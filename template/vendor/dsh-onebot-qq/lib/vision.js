/**
 * [dsh-p1] 本地视觉客户端（v2.28 sidecar 化）：本模块不再加载 Qwen2-VL。
 *
 * 模型在独立进程 `tools\ops\vision-sidecar.mjs`（HTTP 127.0.0.1，DSH_VISION_PORT
 * 默认 8399）：约 2.7GB 常驻内存 + 推理峰值全部隔离在 sidecar 里，DSH 主进程只剩
 * 一个 HTTP 调用方。2026-10-26 02:34 事故（DSH 私有内存 26GB）后从「进程内推理」
 * 改成这个结构；以后想接视觉 API，换个 DSH_VISION_URL 指向适配器即可，主进程不动。
 *
 * 职责：
 * - 缓存快路径：vision-cache.json（路径+mtime 为键，LRU 200 条）只读本进程——
 *   命中零开销；写入统一在 sidecar（原子 tmp+rename），两边路径解析规则一致；
 * - 懒启动：首个请求才 spawn sidecar（detached，DSH 重启后还能复用活实例）；
 *   sidecar 没起来/挂了 → 优雅降级「视觉模型不可用」，绝不阻塞入站回合。
 * - 自动描述护栏：DSH_VISION_AUTO_LIMIT（默认 12）限制每个 DSH 进程最多自动
 *   描述多少张图（sidecar 已把内存风险隔离，这里只防群图片洪峰空转 CPU）；
 *   手动 qq_look 不受此限。超限的图只走 OCR/指纹/裸注记。
 * - 眼睛开关（v2.31）：`media\onebot\vision-state.json` 的 {"enabled":true} 才开，
 *   **文件缺失/解析失败一律视为关**（默认关，省内存的 fail-safe）。开关期间
 *   noteImage 仅记路径不起 sidecar、describeImage/lookImage 返回能力状态，
 *   不提供可照抄的回复（缓存里有描述也不看）。开关脚本：
 *   scripts\vision-on.cmd / vision-off.cmd（关时顺手 POST /shutdown 停 sidecar）。
 *
 * 协议细节见 sidecar 文件头；等待上限 180s（v2.09c），超时不杀 sidecar 任务，
 * 结果照常落缓存，下次必命中。
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = (() => {
    let d = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(d, 'bot-home')) && existsSync(join(d, 'qq-persona'))) return d;
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    return d;
})();

export const VISION_MODEL = 'onnx-community/Qwen2-VL-2B-Instruct';
export const VISION_CACHE_LIMIT = 200;
// 等待上限 180s（v2.09c）：冷加载 15s + 大图预处理 + 64 token 在 CPU 上可能要几分钟
function waitCapMs() {
    const n = Number(process.env.DSH_VISION_WAIT_CAP_MS);
    return Number.isFinite(n) && n > 0 ? n : 180_000;
}

// 测试可注入：DSH_VISION_MEDIA_DIR 把缓存指到 tmp（须与 sidecar 同值才共享缓存）
const MEDIA_DIR = process.env.DSH_VISION_MEDIA_DIR || join(REPO, 'bot-home', 'media', 'onebot');
const SIDECAR_SCRIPT = join(REPO, 'qq-persona', 'p1', 'tools', 'ops', 'vision-sidecar.mjs');

// chatId -> 最新的入站图片路径（qq_look 不带参数时用）
const lastImage = new Map();
let autoStarted = 0;
let sidecarLastFailAt = 0;
let spawning = false;

function autoLimit() {
    const n = Number(process.env.DSH_VISION_AUTO_LIMIT);
    return Number.isFinite(n) && n >= 0 ? n : 12;
}

function endpointUrl() {
    if (process.env.DSH_VISION_URL)
        return String(process.env.DSH_VISION_URL).replace(/\/+$/, '');
    return 'http://127.0.0.1:' + (process.env.DSH_VISION_PORT ?? '8399');
}

function cachePath() {
    return join(MEDIA_DIR, 'vision-cache.json');
}

// Tool failures carry machine-readable facts, never ready-made dialogue.
function disabledResult() {
    return { error: 'vision_disabled', disabled: true, reason: 'disabled_by_admin', canReadText: true };
}

/** Partial text recognition does not mean that the picture itself was seen. */
export function unseenImageAnnotation(path, ocr = '') {
    const facts = ocr === '' ? [] : ['图里写着：「' + ocr + '」'];
    facts.push(visionEnabled() ? '画面尚未识别，不能据此猜画面或保证稍后能看到' : '画面不可见，看图功能已关闭，OCR 文字仍可读取');
    return '[图片:' + path + ']（' + facts.join('；') + '）';
}

export function rememberImage(chatId, path) {
    if (typeof path === 'string' && path !== '')
        lastImage.set(String(chatId), path);
}

// v2.31 眼睛开关：状态文件缺失/解析失败 = 关（默认关，老板要省内存）
function statePath() {
    return join(MEDIA_DIR, 'vision-state.json');
}
export function visionEnabled() {
    try {
        return JSON.parse(readFileSync(statePath(), 'utf8')).enabled === true;
    }
    catch {
        return false;
    }
}

async function readCache() {
    try {
        return JSON.parse(await readFile(cachePath(), 'utf8'));
    }
    catch {
        return {};
    }
}

function cacheKey(path, mtimeMs) {
    return String(path) + '|' + Number(mtimeMs) || 0;
}

async function getHealth(timeoutMs = 1200) {
    const res = await fetch(endpointUrl() + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok)
        throw new Error('http ' + res.status);
    return await res.json();
}

/**
 * Node command candidates for spawning the sidecar, best first.
 * DSH 主进程是 Electron 壳（DeepSeek Harness.exe，dsh.cmd 以 ELECTRON_RUN_AS_NODE=1
 * 跑成 node 模式）——process.execPath 指向 Electron exe 而非 node.exe，不能直接当
 * node 用：优先真 node（PATH/覆盖变量），万不得已才用 execPath 并显式强制
 * ELECTRON_RUN_AS_NODE=1（否则 Electron exe 会按 GUI 应用启动，炸出窗口）。
 */
export function __spawnCandidates(execPath, env) {
    const exe = String(execPath ?? '');
    const out = [];
    if (env?.DSH_VISION_NODE)
        out.push(env.DSH_VISION_NODE);
    if (/node(\.exe)?$/i.test(exe))
        out.push(exe); // plain node host (tests / CLI)
    out.push('node'); // resolve from PATH
    if (exe)
        out.push(exe); // electron-as-node host: caller forces ELECTRON_RUN_AS_NODE=1
    return [...new Set(out.filter(Boolean))];
}

function spawnSidecar(log = () => { }) {
    if (spawning)
        return;
    spawning = true;
    setTimeout(() => { spawning = false; }, 4000).unref?.();
    if (!existsSync(SIDECAR_SCRIPT)) {
        log('vision sidecar script missing: ' + SIDECAR_SCRIPT);
        return;
    }
    const candidates = __spawnCandidates(process.execPath, process.env);
    let idx = 0;
    const trySpawn = () => {
        if (idx >= candidates.length) {
            log('vision sidecar: all spawn candidates failed');
            return;
        }
        const cmd = candidates[idx++];
        const isNodeExe = cmd === 'node' || /node(\.exe)?$/i.test(cmd);
        const childEnv = { ...process.env };
        if (!isNodeExe)
            childEnv.ELECTRON_RUN_AS_NODE = '1';
        try {
            const child = spawn(cmd, [SIDECAR_SCRIPT], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: childEnv,
            });
            child.on('error', (error) => {
                log('vision sidecar spawn via ' + cmd + ' failed: ' + String(error?.message ?? error));
                trySpawn();
            });
            child.unref();
            log('vision sidecar spawning via ' + cmd + (child.pid ? ' (pid ' + child.pid + ')' : ''));
        }
        catch (error) {
            log('vision sidecar spawn via ' + cmd + ' failed: ' + String(error?.message ?? error));
            trySpawn();
        }
    };
    trySpawn();
}

/** Make sure the sidecar is up (spawn if needed). Never throws. */
async function ensureSidecar(log = () => { }) {
    try {
        await getHealth();
        sidecarLastFailAt = 0;
        return true;
    }
    catch { /* not running yet */ }
    // recent failed attempt: fail fast instead of re-polling every call
    if (Date.now() - sidecarLastFailAt < 60_000)
        return false;
    spawnSidecar(log);
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
            await getHealth();
            sidecarLastFailAt = 0;
            return true;
        }
        catch { /* still booting (or port taken by a foreign app) */ }
    }
    sidecarLastFailAt = Date.now();
    log('vision sidecar unreachable after spawn attempt');
    return false;
}

async function postDescribe(body, timeoutMs) {
    const res = await fetch(endpointUrl() + '/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
        throw new Error('http ' + res.status);
    return await res.json();
}

/** Inbound hook: remember the newest image per chat + start a background describe.
 *  Returns true when an auto describe was started (inbound gates the annotation on it). */
export function noteImage(chatId, path, log = () => { }) {
    if (typeof path !== 'string' || path === '')
        return false;
    rememberImage(chatId, path);
    if (!visionEnabled())
        return false; // only remember the path; no quota or sidecar work
    if (autoStarted >= autoLimit())
        return false;
    autoStarted += 1;
    void (async () => {
        if (!(await ensureSidecar(log)))
            return;
        // fire-and-forget: the sidecar replies {pending} at once and the result
        // lands in vision-cache.json for the annotation / qq_look to pick up
        await postDescribe({ path, wait: false }, 15_000);
    })().catch(() => undefined);
    return true;
}

/**
 * Describe one image. Returns { text } or { error }.
 * background=true: fire the describe without waiting (cache warmer contract:
 * callers get { error: 'pending' } immediately, result lands in the cache).
 */
export async function describeImage(path, { background = false, log = () => { } } = {}) {
    if (!visionEnabled())
        return disabledResult();
    let key = '';
    try {
        key = cacheKey(path, (await stat(path)).mtimeMs);
    }
    catch {
        return { error: '文件不存在' };
    }
    const cache = await readCache();
    if (cache[key] !== undefined)
        return { text: cache[key] };

    if (background) {
        void (async () => {
            if (!(await ensureSidecar(log)))
                return;
            await postDescribe({ path, wait: false }, 15_000);
        })().catch(() => undefined);
        return { error: 'pending' }; // caller does not wait
    }
    if (!(await ensureSidecar(log)))
        return { error: '视觉模型不可用' };
    try {
        return await postDescribe({ path, wait: true }, waitCapMs());
    }
    catch (error) {
        // the sidecar job keeps running past a client timeout and lands in the
        // cache, so a retry (next turn / qq_look) returns instantly
        if (error?.name === 'TimeoutError')
            return { error: 'vision_pending', pending: true };
        return { error: '视觉服务没响应' };
    }
}

/** Tool entry: describe a given path or the newest image of a chat. */
export async function lookImage(chatId, path = '', log) {
    if (!visionEnabled())
        return disabledResult();
    const target = typeof path === 'string' && path !== '' ? path : (lastImage.get(String(chatId)) ?? '');
    if (target === '')
        return { error: '这个会话最近没有图' };
    return await describeImage(target, { log });
}

/** Test seams. */
export function lastImageOf(chatId) {
    return lastImage.get(String(chatId));
}
export function __resetForTest() {
    autoStarted = 0;
    lastImage.clear();
    sidecarLastFailAt = 0;
}
