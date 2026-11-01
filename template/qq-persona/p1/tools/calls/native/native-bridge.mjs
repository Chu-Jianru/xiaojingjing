// Derived from ClaudiaGardner/maibot-qq-voice-call 22f30c0, GPL-3.0-only. Windows adaptation: DSH, 2026-10-27.
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { socialCapabilities, executeSocial, inspectFriend, safeSocialReceipt, latestSocialReceipt, readSocialStatus } from './social.mjs?v=2.94.8';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_EVENTS = 100;
const SENSITIVE_KEY =
  /(auth|ticket|token|sign|open_?key|d2|a2|cookie|session|credential|password|secret)/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

let logger = null;
let pluginContext = null;
let settings = null;
let controlToken = null;
let controlServer = null;
let avsdkService = null;
let kernelCore = null;
let kernelSession = null;
let listener = null;
let listenerId = null;
let activeSDKInvite = null;
let loginTimer = null;
let acceptTimer = null;
let armedUntil = 0;
let callLeaseUntil = 0;
let loginAttempts = 0;
let leaseTimer = null;
let lastInitialize = 0;

const state = {
  startedAt: null,
  listenerRegistered: false,
  listenerError: null,
  serviceAvailable: false,
  serviceNull: null,
  serviceMethods: [],
  eventCount: 0,
  events: [],
  avHost: idleAVHost(),
  call: idleCall(),
};

function idleAVHost() {
  return {
    loginPosted: false,
    loginSucceeded: false,
    kernelActionCount: 0,
    outputCount: 0,
    networkOutputCount: 0,
    inviteCallbackSeen: false,
    autoAcceptAttemptedAt: null,
    autoAcceptInviteAt: null,
    autoAcceptPostedAt: null,
    acceptOutputAt: null,
    enterRoomOutputAt: null,
    lastOutputCommand: null,
    lastError: null,
    recentOutputs: [],
  };
}

function idleCall() {
  return {
    phase: "idle",
    inviteAt: null,
    endedAt: null,
    endReason: null,
    inviteType: null,
    callerUid: null,
    callerUin: null,
    callerName: null,
    identityResolvedAt: null,
    identityError: null,
  };
}

function integerSetting(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return parsed;
}

export function parseBridgeSettings(env = process.env, pluginDir = PLUGIN_DIR) {
  let fileConfig = {};
  const configPath = path.join(pluginDir, "bridge-config.json");
  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("bridge-config.json must contain an object");
    }
    fileConfig = parsed;
  }
  const controlHost = env.MAIBOT_QQ_CALL_BRIDGE_HOST || fileConfig.controlHost || "127.0.0.1";
  const avHost = env.MAIBOT_QQ_CALL_AV_HOST_HOST || fileConfig.avHost || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(controlHost) || !LOOPBACK_HOSTS.has(avHost)) {
    throw new Error("bridge endpoints must use a loopback host");
  }
  return {
    controlHost,
    controlPort: integerSetting(
      env.MAIBOT_QQ_CALL_BRIDGE_PORT || fileConfig.controlPort,
      6110,
      "bridge port",
    ),
    avHost,
    avPort: integerSetting(
      env.MAIBOT_QQ_CALL_AV_HOST_PORT || fileConfig.avPort,
      6111,
      "AV host port",
    ),
    token:
      typeof env.MAIBOT_QQ_CALL_BRIDGE_TOKEN === "string"
        ? env.MAIBOT_QQ_CALL_BRIDGE_TOKEN.trim()
        : "",
    tokenFile:
      env.MAIBOT_QQ_CALL_BRIDGE_TOKEN_FILE || fileConfig.tokenFile || "",
    allowedCallers: Array.isArray(fileConfig.allowedCallers)
      ? fileConfig.allowedCallers.map(String).filter(x => /^[1-9]\d{4,11}$/.test(x)) : [],
  };
}

function loadControlToken(config) {
  const token = config.token || fs.readFileSync(config.tokenFile, "utf8").trim();
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("bridge token is missing or shorter than 32 bytes");
  }
  return token;
}

function hasValidControlToken(req, expectedToken) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
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

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
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

export function summarizeValue(value, depth = 0) {
  if (value === null) return null;
  if (value === undefined) return { type: "undefined" };
  if (depth > 2) return { type: typeof value };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: "binary", length: value.byteLength };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, 4).map((item) => summarizeValue(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value)
        .slice(0, 40)
        .map((key) => ({
          key,
          value: SENSITIVE_KEY.test(key)
            ? "[REDACTED]"
            : summarizeValue(value[key], depth + 1),
        })),
    };
  }
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number" || typeof value === "boolean") {
    return { type: typeof value, value };
  }
  return { type: typeof value };
}

function discoverMethods(value) {
  const methods = new Set();
  let cursor = value;
  for (let depth = 0; cursor && depth < 6; depth += 1) {
    for (const key of Reflect.ownKeys(cursor)) {
      if (typeof key !== "string" || key === "constructor") continue;
      try {
        if (typeof value[key] === "function") methods.add(key);
      } catch {
        // Native getters may throw during discovery.
      }
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return [...methods].sort();
}

function mapValue(value, key) {
  if (!value) return null;
  if (typeof value.get === "function") return value.get(key) ?? null;
  return typeof value === "object" ? value[key] ?? null : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function resolveCallerIdentity(uid, inviteAt) {
  let uin = null;
  let profile = null;
  const errors = [];
  try {
    const result = await kernelSession?.getUixConvertService?.().getUin([uid]);
    const resolved = mapValue(result?.uinInfo, uid);
    if (resolved !== null && String(resolved) !== "0") uin = String(resolved);
  } catch (error) {
    errors.push(`uin: ${error?.message ?? String(error)}`);
  }
  try {
    const profiles = await kernelCore?.eventWrapper?.callNoListenerEvent?.(
      "NodeIKernelProfileService/getCoreAndBaseInfo",
      "nodeStore",
      [uid],
    );
    profile = mapValue(profiles, uid);
    const profileUin = profile?.uin ?? profile?.coreInfo?.uin;
    if (!uin && profileUin !== null && profileUin !== undefined && String(profileUin) !== "0") {
      uin = String(profileUin);
    }
  } catch (error) {
    errors.push(`profile: ${error?.message ?? String(error)}`);
  }
  if (state.call.inviteAt !== inviteAt || state.call.callerUid !== uid) return;
  state.call = {
    ...state.call,
    callerUin: uin,
    callerName: firstString(
      profile?.remark,
      profile?.displayName,
      profile?.nick,
      profile?.nickname,
      profile?.coreInfo?.remark,
      profile?.coreInfo?.nick,
      profile?.simpleInfo?.coreInfo?.nick,
    ),
    identityResolvedAt: new Date().toISOString(),
    identityError: uin ? null : errors.join("; ") || "caller identity lookup returned empty",
  };
}

export function buildAcceptParams(invite) {
  if (!Array.isArray(invite) || invite.length < 12) {
    throw new Error("AVSDK invite callback is incomplete");
  }
  // Verified against QQ Linux AVSDK. invite[2] contains this account, while
  // the native Accept session key must use the inviter at invite[1].
  const params = [
    invite[0],
    invite[1],
    [invite[1]],
    invite[3],
    invite[4],
    Boolean(invite[10]),
    invite[11],
  ];
  const valid =
    typeof params[0] === "number" &&
    typeof params[1] === "string" &&
    Array.isArray(params[2]) &&
    params[2].every((item) => typeof item === "string") &&
    typeof params[3] === "number" &&
    typeof params[4] === "string" &&
    typeof params[5] === "boolean" &&
    typeof params[6] === "string";
  if (!valid) throw new Error("AVSDK invite does not match the native Accept signature");
  return params;
}

function invokeAVHost(command, params, retries = 2) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify({ command, params }));
    const request = http.request(
      {
        host: settings.avHost,
        port: settings.avPort,
        path: "/v1/invoke",
        method: "POST",
        headers: {
          Authorization: `Bearer ${controlToken}`,
          "Content-Type": "application/json",
          "Content-Length": encoded.byteLength,
        },
        timeout: 3000,
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve();
          else reject(new Error(`AV host returned HTTP ${response.statusCode}`));
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("AV host timeout")));
    request.on("error", (error) => {
      if (retries > 0) {
        setTimeout(() => invokeAVHost(command, params, retries - 1).then(resolve, reject), 250);
      } else reject(error);
    });
    request.end(encoded);
  });
}

async function acceptActiveInvite() {
  if (!Array.isArray(activeSDKInvite) || state.call.phase === "ended") return;
  // Resolve QQ identity first; a working audio controller must renew this lease.
  if (!mayAcceptInvite(activeSDKInvite, state.call, settings.allowedCallers, armedUntil)) return;
  const inviteAt = state.call.inviteAt;
  if (!inviteAt || state.avHost.autoAcceptInviteAt === inviteAt) return;
  state.avHost.autoAcceptInviteAt = inviteAt;
  state.avHost.autoAcceptAttemptedAt = new Date().toISOString();
  state.call.phase = "accepting";
  await invokeAVHost(5, buildAcceptParams(activeSDKInvite), 0);
  state.avHost.autoAcceptPostedAt = new Date().toISOString();
}

export function mayAcceptInvite(invite, call, callers, until, now = Date.now()) {
  // A group invite must never gain access to the owner's private session.
  return Array.isArray(invite) && invite[0] === 1 && call.phase === 'ringing'
    && typeof call.callerUin === 'string' && callers.includes(call.callerUin) && now < until;
}

async function hangupCurrent(id) {
  if (state.call.inviteAt !== id || !activeSDKInvite || !settings.allowedCallers.includes(state.call.callerUin)
      || !['accepted', 'connected', 'accepting'].includes(state.call.phase)) return;
  state.call.phase = 'ending';
  try { await invokeAVHost(8, [activeSDKInvite[0], 0], 0); }
  finally { await invokeAVHost(10, [activeSDKInvite[0], activeSDKInvite[1], 0], 0); }
}

function scheduleAccept(delayMs) {
  if (acceptTimer) clearTimeout(acceptTimer);
  acceptTimer = setTimeout(() => {
    acceptTimer = null;
    void acceptActiveInvite().catch((error) => {
      state.call.phase = "ringing";
      state.avHost.lastError = `native auto-accept failed: ${error?.message ?? String(error)}`;
      logger?.warn(`[MaiBotQQCall] ${state.avHost.lastError}`);
    });
  }, delayMs);
  acceptTimer.unref?.();
}

function forwardKernelAction(name, args) {
  let actionType = null;
  let payload = null;
  if (name.toLowerCase() === "oninviteactiontoavsdk") {
    actionType = args[1];
    payload = args[2];
  } else if (name.toLowerCase() === "onactiontoavsdk") {
    actionType = args[0];
    payload = args[1];
  }
  if (typeof actionType !== "number" || typeof payload !== "string") return;
  void invokeAVHost(55, [actionType, payload]).then(
    () => {
      state.avHost.kernelActionCount += 1;
      state.avHost.lastError = null;
      if (name.toLowerCase() === "onactiontoavsdk" && activeSDKInvite) scheduleAccept(75);
    },
    (error) => {
      state.avHost.lastError = `kernel action forward failed: ${error?.message ?? String(error)}`;
    },
  );
}

function recordEvent(name, args) {
  const now = new Date().toISOString();
  const lowerName = name.toLowerCase();
  if (lowerName === "oninviteactiontoavsdk" && ['idle', 'ended'].includes(state.call.phase)) {
    activeSDKInvite = null;
    state.avHost.autoAcceptAttemptedAt = null;
    state.avHost.autoAcceptInviteAt = null;
    state.avHost.autoAcceptPostedAt = null;
    state.call = {
      ...idleCall(),
      phase: "ringing",
      inviteAt: now,
      inviteType: typeof args[0]?.invite_type === "number" ? args[0].invite_type : null,
    };
  } else if (lowerName === "ons2cactiontoavsdk" && typeof args[0]?.destroyReason === "number") {
    if (acceptTimer) clearTimeout(acceptTimer);
    acceptTimer = null;
    activeSDKInvite = null;
    state.call = {
      ...state.call,
      phase: "ended",
      endedAt: now,
      endReason: args[0].destroyReason,
    };
  }
  state.eventCount += 1;
  state.events.push({ name, at: now, args: args.map((arg) => summarizeValue(arg)) });
  if (state.events.length > MAX_EVENTS) state.events.shift();
  forwardKernelAction(name, args);
}

function makeListener() {
  const target = {};
  for (const name of [
    "onS2CActionToAVSDK",
    "onActionToAVSDK",
    "onAVSDKData",
    "onAVSdkCrash",
    "onReceiveInvite",
    "onInviteActionToAVSDK",
    "onGroupVideoActionToAVSDK",
    "onGroupVideoServerPushToAVSDK",
  ]) {
    target[name] = (...args) => recordEvent(name, args);
  }
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (typeof property === "string") {
        const callback = (...args) => recordEvent(property, args);
        Reflect.set(object, property, callback);
        return callback;
      }
      return Reflect.get(object, property, receiver);
    },
  });
}

async function handleAVSDKOutput(body) {
  const command = body?.command;
  const value = body?.value;
  if (!Number.isInteger(command)) throw new Error("invalid AVSDK output command");
  state.avHost.outputCount += 1;
  state.avHost.lastOutputCommand = command;
  if (command === 1) state.avHost.loginSucceeded = Array.isArray(value) && value[0] === 0;
  state.avHost.recentOutputs.push({ command, value: summarizeValue(value) });
  if (state.avHost.recentOutputs.length > 8) state.avHost.recentOutputs.shift();
  if (
    command === 120043 &&
    state.avHost.loginPosted &&
    pluginContext
  ) {
    state.avHost.loginPosted = false;
    scheduleAVHostLogin(pluginContext, 100);
  }
  if (command === 20001) {
    if (!Array.isArray(value) || typeof value[0] !== "number" || typeof value[1] !== "string") {
      throw new Error("invalid AVSDK network output");
    }
    if (value[1].length > 1024 * 1024) throw new Error("AVSDK network output is too large");
    if (!avsdkService || typeof avsdkService.setActionFromAVSDK !== "function") {
      throw new Error("setActionFromAVSDK is unavailable");
    }
    await avsdkService.setActionFromAVSDK(value[0], value[1]);
    state.avHost.networkOutputCount += 1;
  } else if (command === 20006 && Array.isArray(value)) {
    if (activeSDKInvite && state.call.phase !== 'ringing') return;
    if (activeSDKInvite && JSON.stringify(activeSDKInvite) === JSON.stringify(value)) { scheduleAccept(500); return; }
    activeSDKInvite = value;
    const callerUid = typeof value[1] === "string" ? value[1] : null;
    state.call = { ...state.call, inviteType: value[0], callerUid, callerUin: null, callerName: null };
    state.avHost.inviteCallbackSeen = true;
    if (callerUid) {
      const inviteAt = state.call.inviteAt;
      void resolveCallerIdentity(callerUid, inviteAt).then(() => {
        if (state.call.inviteAt === inviteAt) scheduleAccept(500);
      }).catch(() => {});
    }
  } else if (command === 5) {
    state.avHost.acceptOutputAt = new Date().toISOString();
    state.call.phase = Array.isArray(value) && value[0] === 0 ? "accepted" : "ringing";
  } else if (command === 20004) {
    state.avHost.enterRoomOutputAt = new Date().toISOString();
    state.call.phase = Array.isArray(value) && value[0] === 0 ? "connected" : "ringing";
  }
  state.avHost.lastError = null;
}

function publicStatus() {
  return {
    version: "0.3.4",
    adaptation: "dsh-windows-preflight",
    armed: Date.now() < armedUntil,
    startedAt: state.startedAt,
    listenerRegistered: state.listenerRegistered,
    listenerError: state.listenerError,
    serviceAvailable: state.serviceAvailable,
    serviceNull: state.serviceNull,
    serviceMethods: state.serviceMethods,
    avHost: state.avHost,
    call: state.call,
    eventCount: state.eventCount,
    recentEvents: state.events.slice(-10),
  };
}

async function startControlServer() {
  settings = parseBridgeSettings();
  controlToken = loadControlToken(settings);
  controlServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${settings.controlHost}:${settings.controlPort}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }
    if (!hasValidControlToken(req, controlToken)) {
      return sendJson(res, 401, { code: -1, message: "Unauthorized" });
    }
    if (req.method === 'GET' && url.pathname === '/v1/social/capabilities') {
      return sendJson(res, 200, { code: 0, data: socialCapabilities(kernelCore) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/social/receipt') {
      return sendJson(res, 200, { code: 0, data: latestSocialReceipt(url.searchParams.get('action'), url.searchParams.get('target')) ?? null });
    }
    if (req.method === 'GET' && url.pathname === '/v1/social/friend') {
      try {
        const value = await inspectFriend(kernelCore, url.searchParams.get('target'), { diagnostic: true });
        return sendJson(res, 200, { code: 0, data: safeSocialReceipt(value) });
      } catch (error) { return sendJson(res, 400, { code: -1, message: String(error.message).slice(0, 200) }); }
    }
    if (req.method === 'GET' && url.pathname === '/v1/social/group') {
      try {
        const target = url.searchParams.get('target');
        if (!/^[1-9]\d{4,11}$/.test(target)) throw new Error('social_target_invalid');
        const found = await kernelCore.apis.GroupApi.searchGroup(target);
        const info = await Promise.all([0, 1].map(async serviceType => ({ serviceType,
          result: await kernelSession.getGroupService().getGroupInfoForJoinGroup(target, true, serviceType) })));
        const summarize = (value, depth = 0) => depth > 3 ? typeof value : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, v]) => [key, /token|auth|key/i.test(key) ? { type: typeof v, present: Boolean(v) } : summarize(v, depth + 1)])) : value;
        return sendJson(res, 200, { code: 0, data: { found: Boolean(found), search: summarize(found), info: summarize(info) } });
      } catch (error) { return sendJson(res, 400, { code: -1, message: String(error.message).slice(0, 200) }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/social/request') {
      try {
        const result = await executeSocial(kernelCore, await readJsonBody(req, 4096));
        return sendJson(res, 200, { code: 0, data: result });
      } catch (error) { return sendJson(res, 400, { code: -1, message: String(error.message).slice(0, 200) }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/social/status') {
      try { return sendJson(res, 200, { code: 0, data: await readSocialStatus(kernelCore, await readJsonBody(req, 4096)) }); }
      catch (error) { return sendJson(res, 400, { code: -1, message: String(error.message).slice(0, 200) }); }
    }
    if (req.method === "GET" && url.pathname === "/v1/status") {
      return sendJson(res, 200, { code: 0, data: publicStatus() });
    }
    if (req.method === "GET" && url.pathname === "/v1/calls/current") {
      return sendJson(res, 200, { code: 0, data: state.call });
    }
    if (req.method === "POST" && url.pathname === "/v1/initialize") {
      if (!state.avHost.loginSucceeded && Date.now() - lastInitialize > 10000) {
        lastInitialize = Date.now(); loginAttempts = 0;
        scheduleAVHostLogin(pluginContext, 100);
      }
      return sendJson(res, 200, { code: 0 });
    }
    if (req.method === "POST" && url.pathname === "/v1/hangup") {
      try { const body = await readJsonBody(req, 4096); await hangupCurrent(body.id); return sendJson(res, 200, { code: 0 }); }
      catch { return sendJson(res, 500, { code: -1 }); }
    }
    if (req.method === "POST" && url.pathname === "/v1/arm") {
      // This endpoint alone does not place or answer a call. Acceptance also
      // requires a resolved caller from the explicit configured allowlist.
      try {
        const body = await readJsonBody(req, 4096);
        if (Array.isArray(body.allowedCallers)) settings.allowedCallers = body.allowedCallers.map(String).filter(x => /^[1-9]\d{4,11}$/.test(x)).slice(0, 100);
        armedUntil = body.ready === true ? Date.now() + 12000 : 0;
        if (body.ready === true) callLeaseUntil = armedUntil;
        if (body.ready === true && activeSDKInvite && state.call.phase === 'ringing') scheduleAccept(0);
        return sendJson(res, 200, { code: 0, data: { armed: Date.now() < armedUntil } });
      } catch { return sendJson(res, 400, { code: -1 }); }
    }
    if (req.method === "POST" && url.pathname === "/v1/avsdk/output") {
      try {
        await handleAVSDKOutput(await readJsonBody(req));
        return sendJson(res, 200, { code: 0, message: "accepted" });
      } catch (error) {
        state.avHost.lastError = error?.message ?? String(error);
        return sendJson(res, 400, { code: -1, message: "invalid AVSDK output" });
      }
    }
    return sendJson(res, 404, { code: -1, message: "Not Found" });
  });
  controlServer.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(settings.controlPort, settings.controlHost, resolve);
  });
}

function scheduleAVHostLogin(ctx, delayMs = 500) {
  if (loginTimer) clearTimeout(loginTimer);
  if (!pluginContext || loginAttempts >= 3) return;
  loginTimer = setTimeout(async () => {
    if (!pluginContext || loginAttempts >= 3) return;
    loginAttempts++;
    try {
      const session = ctx.core?.context?.session;
      const selfUid = String(ctx.core?.selfInfo?.uid ?? "");
      const selfUin = String(ctx.core?.selfInfo?.uin ?? "");
      const accountPath = String(
        session?.getAccountPath?.(Number.parseInt(selfUin, 10)) || ctx.core?.dataPath || "",
      );
      if (!selfUid || !selfUin || !accountPath) throw new Error("QQ identity is unavailable");
      await invokeAVHost(1, [selfUid, selfUin, selfUin, accountPath, ""]);
      state.avHost.loginPosted = true;
      state.avHost.lastError = null;
    } catch (error) {
      state.avHost.lastError = `AV host login failed: ${error?.message ?? String(error)}`;
      scheduleAVHostLogin(ctx, Math.min(delayMs * 2, 5000));
    }
  }, delayMs);
  loginTimer.unref?.();
}

export const plugin_init = async (ctx) => {
  loginAttempts = 0;
  pluginContext = ctx;
  logger = ctx.logger;
  kernelCore = ctx.core ?? null;
  kernelSession = ctx.core?.context?.session ?? null;
  Object.assign(state, {
    startedAt: new Date().toISOString(),
    listenerRegistered: false,
    listenerError: null,
    serviceAvailable: false,
    serviceNull: null,
    serviceMethods: [],
    eventCount: 0,
    events: [],
    avHost: idleAVHost(),
    call: idleCall(),
  });
  try {
    avsdkService = kernelSession?.getAVSDKService?.() ?? null;
    state.serviceAvailable = Boolean(avsdkService);
    state.serviceMethods = avsdkService ? discoverMethods(avsdkService) : [];
    state.serviceNull = avsdkService?.isNull ? Boolean(avsdkService.isNull()) : null;
    if (avsdkService?.addKernelAVSDKListener) {
      listener = makeListener();
      listenerId = avsdkService.addKernelAVSDKListener(listener);
      state.listenerRegistered = true;
    }
    await startControlServer();
    leaseTimer = setInterval(() => {
      if (callLeaseUntil > 0 && Date.now() > callLeaseUntil) void hangupCurrent(state.call.inviteAt).catch(() => {});
    }, 1000);
    leaseTimer.unref?.();
    scheduleAVHostLogin(ctx);
    logger.info(
      `[MaiBotQQCall] bridge listening on ${settings.controlHost}:${settings.controlPort}`,
    );
  } catch (error) {
    state.listenerError = error?.message ?? String(error);
    logger.error(`[MaiBotQQCall] bridge startup failed: ${state.listenerError}`);
  }
  ctx.router.get("/maibot-qq-call/status", (_req, res) => {
    res.json({ code: 0, data: publicStatus() });
  });
};

export const plugin_cleanup = async () => {
  await hangupCurrent(state.call.inviteAt).catch(() => {});
  clearInterval(leaseTimer); leaseTimer = null;
  armedUntil = 0;
  pluginContext = null;
  if (loginTimer) clearTimeout(loginTimer);
  if (acceptTimer) clearTimeout(acceptTimer);
  loginTimer = null;
  acceptTimer = null;
  if (controlServer) {
    await new Promise((resolve) => controlServer.close(resolve));
    controlServer = null;
  }
  if (avsdkService && listenerId !== null && avsdkService.removeKernelAVSDKListener) {
    try {
      avsdkService.removeKernelAVSDKListener(listenerId);
    } catch (error) {
      logger?.warn(`[MaiBotQQCall] listener cleanup failed: ${error?.message ?? String(error)}`);
    }
  }
  settings = null;
  controlToken = null;
  avsdkService = null;
  kernelCore = null;
  kernelSession = null;
  listener = null;
  listenerId = null;
  activeSDKInvite = null;
  state.listenerRegistered = false;
};

export const plugin_get_config = async () => ({
  controlHost: settings?.controlHost ?? "127.0.0.1",
  controlPort: settings?.controlPort ?? 6110,
  avHost: settings?.avHost ?? "127.0.0.1",
  avPort: settings?.avPort ?? 6111,
});

export const plugin_config_ui = [];
