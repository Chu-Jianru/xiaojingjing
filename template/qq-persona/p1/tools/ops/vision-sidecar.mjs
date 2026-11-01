/**
 * [dsh-p1] 视觉 sidecar（v2.28）：Qwen2-VL-2B 跑在独立进程里，DSH 主进程零模型内存。
 *
 * 背景（2026-10-26 02:34 事故）：模型原先直接加载在 DSH 进程内（常驻 ~3GB，推理期
 * 更高），把 DSH 私有内存推到 26GB，整机提交内存吃满。v2.28 起模型搬到这里：
 *
 * - DSH 侧 lib/vision.js 只是个 HTTP 客户端（缓存快路径 + 懒拉起本进程）；
 * - 本进程首张图才加载模型（~15s，~2.7GB 常驻），空闲 30 分钟自退（内存归零）；
 * - 自保护三件套，都是那次事故的教训：
 *   ① RSS 超限（默认 5GB）自回收——内存泄漏不外溢到整机；
 *   ② 单任务超时（默认 15 分钟）——onnxruntime 挂死不会永久占住队列；
 *   ③ 空闲自退——DSH 重启/长时间没图时模型内存自动释放。
 *
 * 协议（127.0.0.1，端口 DSH_VISION_PORT 默认 8399）：
 * - GET  /health    → {ok,pid,state,busy,jobs,model,uptimeMs}
 * - POST /describe  {path, wait} → {text}|{error}|{pending}
 *     wait=false（后台预热）：忙时直接丢（{pending:true}），推理结果只写缓存；
 *     wait=true（qq_look/注记）：同 key 在飞就搭车，否则排队等结果；
 * - POST /shutdown  → {ok:true} 后自退（运维用）。
 *
 * 模型加载细节（q4/q4f16 混合、离线强制、fromBlob）承 v2.06 探测结论，
 * 坑见 docs/media.md §3.44——别改 dtype，q4f16 decoder 会崩 onnxruntime。
 *
 * 单测注入点：createVisionServer({ describeFn, port:0, ... })，见 tools/tests/vision.test.mjs。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, appendFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';

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

// [dsh-p1] v2.59: 上传前缩到 1024 以内（1.15k×1.9k 的图要 35s，缩完 10s 级）
const SHRINK_MAX = Number(process.env.DSH_VISION_SHRINK_MAX ?? 1024);

async function shrinkForCloud(file) {
    const { spawnSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const targets = [
        process.env.DSH_VISION_PYTHON,
        'C:\\Users\\USER\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
        'python',
    ].filter(Boolean);
    const code = 'import sys\n'
        + 'from PIL import Image\n'
        + 'im = Image.open(sys.argv[1])\n'
        + 'im.thumbnail((int(sys.argv[3]), int(sys.argv[3])))\n'
        + 'im.convert("RGB").save(sys.argv[2], "JPEG", quality=85)\n';
    const out = join(tmpdir(), 'vision-shrink-' + process.pid + '-' + Date.now() + '.jpg');
    for (const python of targets) {
        try {
            const done = spawnSync(python, ['-c', code, file, out, String(SHRINK_MAX)], { timeout: 20_000, windowsHide: true });
            if (done.status === 0)
                return { file: out, mime: 'image/jpeg', temp: true };
        }
        catch { /* try next */ }
    }
    return { file, mime: null, temp: false };
}


// [dsh-p1] v2.52: 云视觉。DSH_VISION_CLOUD=1 时优先走云端 OpenAI 兼容接口，
// 本地 Qwen2-VL 只当兜底；不设这个变量就和原来完全一样。
const CLOUD = {
    enabled: String(process.env.DSH_VISION_CLOUD ?? '') === '1',
    base: String(process.env.DSH_VISION_BASE ?? '').replace(/\/+$/, ''),
    key: String(process.env.DSH_VISION_API_KEY ?? ''),
    model: String(process.env.DSH_VISION_MODEL ?? 'GLM-4V-Flash'),
    timeoutMs: Number(process.env.DSH_VISION_CLOUD_TIMEOUT_MS ?? 60_000),
};
const CLOUD_MEMO = new Map();
const CLOUD_PROMPT = String(process.env.DSH_VISION_PROMPT ?? '') ||
    '看这张图，用中文说清楚：画面是什么、图里有什么字（原样念出来）、氛围或梗是什么。'
    + '认不出具体角色/梗就只说画面，别硬安名字（不要猜成别的动漫角色）。不超过 120 字，不要客套。';

async function cloudDescribe(path) {
    const { readFile } = await import('node:fs/promises');
    let buf = await readFile(path);
    if (buf.length > 8 * 1024 * 1024)
        throw new Error('image too large (>8MB)');
    const ext = String(path).split('.').pop().toLowerCase();
    const shrink = await shrinkForCloud(path);
    let mime;
    if (shrink.temp) {
        const { readFile: readShrunk } = await import('node:fs/promises');
        buf = await readShrunk(shrink.file);
        mime = shrink.mime;
    }
    else {
        mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'webp' ? 'image/webp'
                : ext === 'gif' ? 'image/gif' : 'image/png';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLOUD.timeoutMs);
    timer.unref?.();
    try {
        const res = await fetch(CLOUD.base + '/chat/completions', {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLOUD.key },
            body: JSON.stringify({
                model: CLOUD.model,
                max_tokens: 700,
                temperature: 0.3,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: CLOUD_PROMPT },
                        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } },
                    ],
                }],
            }),
        });
        const text = await res.text();
        if (!res.ok)
            throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 120));
        const json = JSON.parse(text);
        const answer = json?.choices?.[0]?.message?.content;
        if (!answer)
            throw new Error('empty answer');
        return String(answer).trim().slice(0, 600);
    }
    finally {
        clearTimeout(timer);
    }
}


const EMBED_DIR = join(REPO, 'bot-home', 'embed');

function cacheKey(path, mtimeMs) {
    return String(path) + '|' + Number(mtimeMs) || 0;
}

function makeFileLogger(file) {
    return (msg) => {
        const line = new Date().toISOString() + ' [pid ' + process.pid + '] ' + msg;
        try { console.log(line); } catch { /* stdio ignore */ }
        void (async () => {
            try {
                await mkdir(dirname(file), { recursive: true });
                try {
                    const s = await stat(file);
                    if (s.size > 512 * 1024)
                        await writeFile(file, '', 'utf8');
                }
                catch { /* first write */ }
                await appendFile(file, line + '\n', 'utf8');
            }
            catch { /* logging must never take the sidecar down */ }
        })();
    };
}

/**
 * Create (but do not start) the sidecar HTTP server.
 * opts: { port, cacheDir, describeFn, idleMs, maxRss, jobCapMs, logFile, log, exit }
 *   - describeFn: async (path, log) => {text}|{error}; default = real Qwen2-VL.
 *     Tests inject a stub here and never load the 2.7GB weights.
 *   - exit: process.exit seam (tests spy instead of killing the runner).
 */
export function createVisionServer(opts = {}) {
    const cfg = {
        port: opts.port ?? Number(process.env.DSH_VISION_PORT ?? 8399),
        host: '127.0.0.1',
        // must resolve identically on the client (lib/vision.js) or the two
        // sides will read/write different vision-cache.json files
        cacheDir: opts.cacheDir ?? process.env.DSH_VISION_MEDIA_DIR ?? join(REPO, 'bot-home', 'media', 'onebot'),
        idleMs: opts.idleMs ?? Number(process.env.DSH_VISION_IDLE_MS ?? 30 * 60_000),
        maxRss: opts.maxRss ?? Number(process.env.DSH_VISION_MAX_RSS ?? 5 * 1024 ** 3),
        jobCapMs: opts.jobCapMs ?? Number(process.env.DSH_VISION_JOB_CAP_MS ?? 15 * 60_000),
        logFile: opts.logFile ?? join(REPO, 'logs', 'vision-sidecar.log'),
        describeFn: opts.describeFn ?? null,
    };
    const log = opts.log ?? makeFileLogger(cfg.logFile);
    const exitProcess = opts.exit ?? ((code) => process.exit(code));

    const modelState = { state: 'idle', model: null, processor: null, RawImage: null };
    let busy = false;
    let jobStartedAt = 0;
    const jobs = new Map(); // cacheKey -> in-flight describe promise (dedup)
    let chain = Promise.resolve(); // serialize real inference: one VLM at a time
    let idleTimer = null;
    let exiting = false;

    function cachePath() {
        return join(cfg.cacheDir, 'vision-cache.json');
    }

    async function readCache() {
        try {
            return JSON.parse(await readFile(cachePath(), 'utf8'));
        }
        catch {
            return {};
        }
    }

    async function writeCacheEntry(key, text) {
        const fresh = await readCache();
        fresh[key] = text;
        const keys = Object.keys(fresh);
        if (keys.length > VISION_CACHE_LIMIT)
            for (const k of keys.slice(0, keys.length - VISION_CACHE_LIMIT))
                delete fresh[k];
        const file = cachePath();
        await mkdir(dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await writeFile(tmp, JSON.stringify(fresh), 'utf8');
        await rename(tmp, file);
    }

    /** Load the model once (fully offline: remote checks hang, see header). */
    async function ensureModel() {
        if (modelState.state === 'ready')
            return modelState;
        if (modelState.state === 'loading') {
            while (modelState.state === 'loading')
                await new Promise(r => setTimeout(r, 200));
            return modelState.state === 'ready' ? modelState : null;
        }
        modelState.state = 'loading';
        log('loading ' + VISION_MODEL + ' ...');
        try {
            const { AutoProcessor, Qwen2VLForConditionalGeneration, RawImage, env } = await import(pathToFileURL(join(EMBED_DIR, 'provider.mjs')).href);
            env.remoteHost = 'https://hf-mirror.com';
            env.allowRemoteModels = false;
            env.cacheDir = join(EMBED_DIR, 'models');
            modelState.RawImage = RawImage;
            modelState.model = await Qwen2VLForConditionalGeneration.from_pretrained(VISION_MODEL, {
                // probe-verified mix (docs/media.md 3.44): q4f16 decoder hits an
                // onnxruntime buffer-reuse bug (InsertedPrecisionFreeCast_); q4
                // decoder runs clean. embed/vision q4f16 are fine.
                dtype: { embed_tokens: 'q4f16', decoder_model_merged: 'q4', vision_encoder: 'q4f16' },
                cache_dir: env.cacheDir,
            });
            modelState.processor = await AutoProcessor.from_pretrained(VISION_MODEL, { cache_dir: env.cacheDir });
            modelState.state = 'ready';
            log('model ready');
            return modelState;
        }
        catch (error) {
            modelState.state = 'failed';
            log('model load failed: ' + String(error));
            return null;
        }
    }

    async function inferWithModel(path) {
        const v = await ensureModel();
        if (v === null)
            return { error: '视觉模型不可用' };
        const bytes = await readFile(path);
        const image = await v.RawImage.fromBlob(new Blob([bytes]));
        const messages = [{ role: 'user', content: [
            { type: 'image' },
            { type: 'text', text: '用一两句中文说清这张图里有什么（人物/动作/文字/场景）。' },
        ] }];
        const prompt = v.processor.apply_chat_template(messages, { add_generation_prompt: true });
        const inputs = await v.processor(prompt, [image]);
        const out = await v.model.generate({ ...inputs, max_new_tokens: 64 });
        const seq = out?.generated_ids ?? out?.sequences ?? out;
        const inputLen = inputs.input_ids.dims.at(-1);
        const text = String(v.processor.batch_decode(seq.slice(null, [inputLen, seq.dims.at(-1)]), { skip_special_tokens: true })[0] ?? '').trim();
        if (text === '')
            return { error: '没看出来' };
        return { text };
    }

    function checkRss() {
        if (exiting || !(cfg.maxRss > 0))
            return;
        const rss = process.memoryUsage.rss();
        if (rss > cfg.maxRss) {
            log('rss ' + (rss / 1024 ** 3).toFixed(2) + 'GB over ' + (cfg.maxRss / 1024 ** 3).toFixed(1) + 'GB limit — recycling');
            exiting = true;
            setTimeout(() => exitProcess(0), 2000).unref();
        }
    }

    function touch() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        if (exiting || !(cfg.idleMs > 0))
            return;
        idleTimer = setTimeout(() => {
            if (jobs.size === 0 && !busy) {
                log('idle ' + Math.round(cfg.idleMs / 60000) + 'min — exiting (memory released)');
                exiting = true;
                setTimeout(() => exitProcess(0), 100).unref();
            }
            else {
                touch(); // job in flight; re-check when it lands
            }
        }, cfg.idleMs);
        idleTimer.unref();
    }

    function startJob(key, path) {
        const started = Date.now();
        jobStartedAt = started;
        const infer = cfg.describeFn
            ? () => cfg.describeFn(path, log)
            : () => inferWithModel(path);
        const run = chain.then(async () => {
            busy = true;
            try {
                const result = await Promise.race([
                    infer(),
                    new Promise(resolve => {
                        const cap = setTimeout(() => resolve({ error: '看图超时了（任务上限 ' + Math.round(cfg.jobCapMs / 60000) + ' 分钟）' }), cfg.jobCapMs);
                        cap.unref?.();
                    }),
                ]);
                const secs = Math.round((Date.now() - started) / 1000);
                if (result && typeof result.text === 'string' && result.text !== '') {
                    await writeCacheEntry(key, result.text);
                    log('described in ' + secs + 's: ' + path);
                }
                else {
                    log('describe failed (' + String(result?.error ?? 'unknown') + ') after ' + secs + 's: ' + path);
                }
                return result;
            }
            catch (error) {
                return { error: '看图出错：' + String(error?.message ?? error) };
            }
            finally {
                busy = false;
                jobs.delete(key);
                touch();
                checkRss();
            }
        });
        jobs.set(key, run);
        chain = run.then(() => undefined, () => undefined);
        return run;
    }

    async function describeOne(path, wait) {
        let key = '';
        try {
            key = cacheKey(path, (await stat(path)).mtimeMs);
        }
        catch {
            return { error: '文件不存在' };
        }

        if (CLOUD.enabled && CLOUD.base !== '' && CLOUD.key !== '') {
            const memo = CLOUD_MEMO.get(key);
            if (memo !== undefined)
                return { text: memo };
            if (!wait) {
                // 后台预热：插件是 fire-and-forget，必须自己算完写缓存，
                // 否则图永远停在“pending”（她会说看不见图）
                void cloudDescribe(path).then((text) => {
                    CLOUD_MEMO.set(key, text);
                    if (CLOUD_MEMO.size > VISION_CACHE_LIMIT)
                        CLOUD_MEMO.delete(CLOUD_MEMO.keys().next().value);
                    log('cloud vision ok (bg, ' + CLOUD.model + '): ' + text.slice(0, 60));
                }).catch((error) => log('cloud vision bg failed: ' + String(error?.message ?? error)));
                return { pending: true };
            }
            try {
                const text = await cloudDescribe(path);
                CLOUD_MEMO.set(key, text);
                if (CLOUD_MEMO.size > VISION_CACHE_LIMIT)
                    CLOUD_MEMO.delete(CLOUD_MEMO.keys().next().value);
                log('cloud vision ok (' + CLOUD.model + '): ' + text.slice(0, 60));
                return { text };
            }
            catch (error) {
                log('cloud vision failed: ' + String(error?.message ?? error) + ' — fallback to local');
            }
        }
    const cache = await readCache();
        if (cache[key] !== undefined)
            return { text: cache[key] };
        if (!wait) {
            // background warmer: opportunistic — if anything is in flight, drop
            // (the awaited path will cover this image later via the cache)
            if (busy || jobs.size > 0)
                return { pending: true, error: 'pending' };
            startJob(key, path);
            return { pending: true };
        }
        const existing = jobs.get(key);
        if (existing)
            return await existing; // ride the identical in-flight job
        return await startJob(key, path);
    }

    const server = http.createServer((req, res) => {
        const done = (code, obj) => {
            if (res.writableEnded)
                return;
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > (1 << 20))
                req.destroy();
        });
        req.on('end', () => {
            void (async () => {
                touch();
                try {
                    if (req.method === 'GET' && req.url === '/health')
                        return done(200, { ok: true, pid: process.pid, state: modelState.state, busy, jobs: jobs.size, model: VISION_MODEL, uptimeMs: Math.round(process.uptime() * 1000) });
                    if (req.method === 'POST' && req.url === '/describe') {
                        let body = {};
                        try {
                            body = JSON.parse(raw || '{}');
                        }
                        catch {
                            return done(400, { error: 'bad json' });
                        }
                        return done(200, await describeOne(String(body?.path ?? ''), body?.wait === true));
                    }
                    if (req.method === 'POST' && req.url === '/shutdown') {
                        done(200, { ok: true });
                        log('shutdown requested');
                        exiting = true;
                        setTimeout(() => exitProcess(0), 300).unref();
                        return;
                    }
                    done(404, { error: 'not found' });
                }
                catch (error) {
                    done(500, { error: 'sidecar error: ' + String(error?.message ?? error) });
                }
            })();
        });
    });
    server.on('error', (error) => log('server error: ' + String(error?.message ?? error)));

    function start() {
        return new Promise((resolve, reject) => {
            const onListenError = (error) => reject(error);
            server.once('error', onListenError);
            server.listen(cfg.port, cfg.host, () => {
                server.removeListener('error', onListenError);
                touch();
                resolve({ port: server.address().port });
            });
        });
    }

    async function stop() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        await new Promise((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.(); // tests: drop keep-alive sockets so the runner can exit
    }

    return {
        server, cfg, log, start, stop,
        __state: {
            isBusy: () => busy,
            jobCount: () => jobs.size,
            modelState: () => modelState.state,
        },
    };
}

function main() {
    const app = createVisionServer({});
    app.start().then(({ port }) => {
console.log(new Date().toISOString() + ' cloud vision: ' + (CLOUD.enabled ? 'on (' + CLOUD.model + ', key ' + (CLOUD.key ? 'set' : 'missing') + ')' : 'off — local only'));
            app.log('vision sidecar listening on ' + app.cfg.host + ':' + port + ' (model loads on first image; idle exit ' + Math.round(app.cfg.idleMs / 60000) + 'min)');
    }).catch((error) => {
        app.log('vision sidecar failed to start (' + String(error?.code ?? '') + '): ' + String(error?.message ?? error));
        process.exit(1);
    });
}

const isMain = (() => {
    try {
        const argvHref = process.argv[1] ? pathToFileURL(process.argv[1]).href.toLowerCase() : '';
        return argvHref !== '' && argvHref === import.meta.url.toLowerCase();
    }
    catch {
        return false;
    }
})();

if (isMain)
    main();
