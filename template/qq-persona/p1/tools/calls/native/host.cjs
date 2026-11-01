// Derived from ClaudiaGardner/maibot-qq-voice-call 22f30c0, GPL-3.0-only. Windows adaptation: DSH, 2026-10-27.
"use strict";

const { timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { parseAudioDeviceSnapshot, selectWindowsHardware } = require("./audio-devices.cjs");
const { AudioRouteGuard } = require("./route-guard.cjs");
let routeGuard = null;
let devices = null;
let selectedHardware = null;
let selectedRoute = null;
let selectionInvocationId = null;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ALLOWED_COMMANDS = new Set([1, 5, 8, 9, 10, 55]);

function port(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return parsed;
}

function loadSettings(env = process.env) {
  const local = fs.existsSync(path.join(__dirname, "host-config.json"))
    ? JSON.parse(fs.readFileSync(path.join(__dirname, "host-config.json"), "utf8")) : {};
  const bridgeDir = path.resolve(env.MAIBOT_QQ_CALL_BRIDGE_DIR || local.bridgeDir || path.join(__dirname, ".."));
  const qqDir = path.resolve(env.MAIBOT_QQ_CALL_QQ_DIR || path.join(bridgeDir, "QQ"));
  const host = env.MAIBOT_QQ_CALL_AV_HOST_HOST || "127.0.0.1";
  const bridgeHost = env.MAIBOT_QQ_CALL_BRIDGE_HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) || !LOOPBACK_HOSTS.has(bridgeHost)) {
    throw new Error("AV host endpoints must use loopback addresses");
  }
  return {
    bridgeDir,
    qqDir,
    guardPython: local.guardPython,
    host,
    listenPort: port(env.MAIBOT_QQ_CALL_AV_HOST_PORT, 6111, "AV host port"),
    bridgeHost,
    bridgePort: port(env.MAIBOT_QQ_CALL_BRIDGE_PORT, 6110, "bridge port"),
    token: (env.MAIBOT_QQ_CALL_BRIDGE_TOKEN || "").trim(),
    tokenFile: path.resolve(
      env.MAIBOT_QQ_CALL_BRIDGE_TOKEN_FILE || local.tokenFile || path.join(bridgeDir, "runtime", "control.token"),
    ),
    avsdkPath: path.resolve(
      env.MAIBOT_QQ_CALL_AVSDK_PATH || local.avsdkPath ||
        path.join(qqDir, "resources", "app", "avsdk", "libAVSDKPlugin.so"),
    ),
  };
}

const settings = loadSettings();
let controlToken = null;
let avWindow = null;
let controlServer = null;
let nextInvocationId = 1;
let rendererState = {
  ready: false,
  pluginFound: false,
  methods: [],
  messageCount: 0,
  forwardedCount: 0,
  lastForwardedCommand: null,
  forwardError: null,
  invocationCount: 0,
  lastInvocationCommand: null,
  lastInvocationAt: null,
  error: null,
  audioSelection: null,
  audioTrace: [],
};

function loadControlToken() {
  const token = settings.token || fs.readFileSync(settings.tokenFile, "utf8").trim();
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("bridge token is missing or shorter than 32 bytes");
  }
  return token;
}

function hasValidControlToken(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(controlToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(res, statusCode, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.byteLength,
    "Cache-Control": "no-store",
  });
  res.end(encoded);
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function startControlServer() {
  controlServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${settings.host}:${settings.listenPort}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }
    if (!hasValidControlToken(req)) {
      return sendJson(res, 401, { code: -1, message: "Unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/v1/status") {
      return sendJson(res, 200, {
        code: 0,
        data: {
          electron: process.versions.electron ?? null,
          pid: process.pid,
          audioProcessIds: app.getAppMetrics().map(item=>item.pid),
          audioRouteGuard: routeGuard?.status(app.getAppMetrics().map(item=>item.pid)) ?? { ready: false },
          chrome: process.versions.chrome ?? null,
          ...rendererState,
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/invoke") {
      try {
        const body = await readJsonBody(req);
        const command = Number(body?.command);
        const params = body?.params;
        if (!ALLOWED_COMMANDS.has(command)) {
          return sendJson(res, 400, { code: -1, message: "command is not allowed" });
        }
        if (!Array.isArray(params) || params.length > 16) {
          return sendJson(res, 400, { code: -1, message: "invalid params" });
        }
        const invocationId = nextInvocationId++;
        const result = await avWindow?.webContents.executeJavaScript(
          `window.maibotQQCallAVSDKInvoke(${JSON.stringify(command)},` +
            `${JSON.stringify(invocationId)},${JSON.stringify(params)})`,
          false,
        );
        rendererState = {
          ...rendererState,
          invocationCount: rendererState.invocationCount + 1,
          lastInvocationCommand: command,
          lastInvocationAt: new Date().toISOString(),
        };
        return sendJson(res, 200, { code: 0, data: result ?? null });
      } catch (_error) {
        return sendJson(res, 500, { code: -1, message: "AVSDK invocation failed" });
      }
    }
    if (req.method === "POST" && url.pathname === "/v1/select-audio") {
      try {
        const body = await readJsonBody(req, 128 * 1024);
        if (!devices) throw new Error("native device snapshot unavailable");
        selectedRoute = selectWindowsHardware(devices, body.devices);
        selectedHardware = selectedRoute.selectors;
        rendererState.audioSelection = null;
        selectionInvocationId = nextInvocationId++;
        await avWindow.webContents.executeJavaScript(`window.maibotQQCallAVSDKInvoke(102,${selectionInvocationId},${JSON.stringify(selectedHardware)})`, false);
        return sendJson(res, 200, { code: 0, data: { posted: true } });
      } catch { return sendJson(res, 409, { code: -1, message: "virtual audio selection unavailable" }); }
    }
    return sendJson(res, 404, { code: -1, message: "Not Found" });
  });
  controlServer.on("clientError", (_error, socket) => socket.destroy());
  controlServer.listen(settings.listenPort, settings.host, () => {
    console.log(`[MaiBotQQCallAVHost] listening on ${settings.host}:${settings.listenPort}`);
    routeGuard = new AudioRouteGuard(settings.guardPython, path.join(__dirname, "route-guard"), process.pid);
    routeGuard.start();
  });
}

ipcMain.on("maibot-qq-call-avsdk-state", (_event, incoming) => {
  rendererState = {
    ...rendererState,
    ready: Boolean(incoming?.ready) && incoming?.methods?.includes("postMessage"),
    pluginFound: Boolean(incoming?.pluginFound),
    methods: Array.isArray(incoming?.methods)
      ? incoming.methods.filter((item) => typeof item === "string").slice(0, 100)
      : [],
    error: typeof incoming?.error === "string" ? incoming.error.slice(0, 500) : null,
  };
});

ipcMain.on("maibot-qq-call-avsdk-message", () => {
  rendererState = { ...rendererState, messageCount: rendererState.messageCount + 1 };
});

async function forwardPluginMessage(message) {
  if (
    !message ||
    typeof message !== "object" ||
    !Number.isInteger(message.cmd) ||
    !Object.hasOwn(message, "value")
  ) {
    return;
  }
  if (message.cmd === 20061) {
    try {
      const next = parseAudioDeviceSnapshot(message.value);
      selectedHardware = null; selectedRoute = null; selectionInvocationId = null;
      rendererState.audioSelection = null;
      devices = next;
    }
    catch { devices = null; rendererState.audioSelection = null; }
  }
  if (message.cmd === 102 && message.id === selectionInvocationId && selectedRoute) {
    rendererState.audioSelection = { confirmed: message.value?.[0] === 1, selectorSource:'windows-mmdevice',
      inputName:selectedRoute.inputName, outputName:selectedRoute.outputName };
  }
  if (message.cmd === 20038 && selectedHardware) {
    rendererState.audioSelection = null;
    selectionInvocationId = nextInvocationId++;
    await avWindow.webContents.executeJavaScript(`window.maibotQQCallAVSDKInvoke(102,${selectionInvocationId},${JSON.stringify(selectedHardware)})`, false).catch(() => {});
  }
  if (message.cmd === 20050) {
    // Bounded local device diagnostics only. Never retain login/network,
    // account, room, credential or arbitrary SDK payload logging.
    const visit = value => {
      if (typeof value === 'string' && /SelectAudioDevice|SetAudioDevices|currentInputDeviceId|selected output:|EnableMic|OpenMic|CloseMic|GetMMDevice failed|EnumAudioEndpoints failed/i.test(value)
        && !/ticket|token|password|credential|uin[=:]|uid[=:]|room[=:]|sign[=:]/i.test(value)) {
        rendererState.audioTrace.push({at:Date.now(), text:value.slice(0,700)});
        if (rendererState.audioTrace.length>40) rendererState.audioTrace.shift();
      } else if (Array.isArray(value)) value.forEach(visit);
    };
    visit(message.value);
    return;
  }
  try {
    const response = await fetch(
      `http://${settings.bridgeHost}:${settings.bridgePort}/v1/avsdk/output`,
      {
        signal: AbortSignal.timeout(3000),
        method: "POST",
        headers: {
          Authorization: `Bearer ${controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command: message.cmd,
          id: Number.isInteger(message.id) ? message.id : 0,
          value: message.value,
        }),
      },
    );
    if (!response.ok) throw new Error(`bridge returned HTTP ${response.status}`);
    rendererState = {
      ...rendererState,
      forwardedCount: rendererState.forwardedCount + 1,
      lastForwardedCommand: message.cmd,
      forwardError: null,
    };
  } catch (error) {
    rendererState = { ...rendererState, forwardError: error?.message ?? String(error) };
  }
}

ipcMain.on("maibot-qq-call-avsdk-raw-message", (_event, message) => {
  void forwardPluginMessage(message);
});

if (!fs.existsSync(settings.avsdkPath)) {
  throw new Error(`QQ AVSDK library was not found: ${settings.avsdkPath}`);
}
controlToken = loadControlToken();
app.commandLine.appendSwitch(
  "register-pepper-plugins",
  `${settings.avsdkPath};application/x-ppapi-avSDK`,
);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.setPath("userData", path.join(settings.bridgeDir, "runtime", "av-host-profile"));

app.whenReady()
  .then(async () => {
    avWindow = new BrowserWindow({
      width: 320,
      height: 240,
      show: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        plugins: true,
        sandbox: false,
      },
    });
    avWindow.webContents.on("render-process-gone", (_event, details) => {
      rendererState = {
        ...rendererState,
        ready: false,
        error: `renderer process gone: ${details.reason}`,
      };
    });
    await avWindow.loadFile(path.join(__dirname, "host.html"));
    startControlServer();
  })
  .catch((error) => {
    console.error(`[MaiBotQQCallAVHost] startup failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });

app.on("before-quit", () => routeGuard?.close());
app.on("window-all-closed", () => app.quit());
