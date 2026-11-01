/** Local expressive Qwen3-TTS, with a bounded Edge fallback and audio reuse. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
export const TTS_VOICES = [
    'zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-TW-HsiaoChenNeural',
    'zh-TW-HsiaoYuNeural', 'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
];
export const TTS_MAX_CHARS = 120;
const CONFIG_PATH = join(REPO, 'bot-home', 'media', 'onebot', 'tts-voice.json');
const DEFAULTS = { engine: 'edge', voice: 'zh-CN-XiaoyiNeural', rate: '-4%', pitch: '+10Hz',
    volume: '-3%', speaker: 'Serena', style: 'soft', port: 8398, localTimeoutMs: 18_000 };
const CACHE_TTL = 24 * 60 * 60_000;

function profileKey(cfg) {
    const identity = cfg.mode === 'reference'
        ? ['reference-v1', cfg.reference.sha256, cfg.reference.text, String(cfg.seed)]
        : ['builtin-v1', cfg.speaker, cfg.style, String(cfg.seed)];
    const base = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const { instruct = '', tempo = 1, gainDb = 0 } = cfg.delivery ?? {};
    if (gainDb !== 0) return createHash('sha256').update(JSON.stringify(['reference-delivery-v2', base, instruct, tempo, gainDb])).digest('hex');
    return instruct || tempo !== 1
        ? createHash('sha256').update(JSON.stringify(['reference-delivery-v1', base, instruct, tempo])).digest('hex')
        : base;
}

function prosody(value, suffix, min, max, fallback) {
    const match = String(value ?? '').match(new RegExp('^([+-]\\d+)' + suffix + '$'));
    return match && Number(match[1]) >= min && Number(match[1]) <= max ? String(value) : fallback;
}

export async function speechConfig(path = CONFIG_PATH) {
    let raw = {};
    try { raw = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { throw new Error('tts: 无法读取语音配置，保留原声线'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tts: 无效语音配置');
    if (raw.mode !== undefined && !['builtin', 'reference'].includes(raw.mode)) throw new Error('tts: 无效声线模式');
    if (path === CONFIG_PATH && !['qwen', 'edge'].includes(raw.engine)) throw new Error('tts: 语音配置缺少引擎');
    const cfg = { ...DEFAULTS,
        engine: raw.engine === 'qwen' ? 'qwen' : 'edge',
        voice: TTS_VOICES.includes(raw.voice) ? raw.voice : DEFAULTS.voice,
        rate: prosody(raw.rate, '%', -20, 20, DEFAULTS.rate),
        pitch: prosody(raw.pitch, 'Hz', -30, 40, DEFAULTS.pitch),
        volume: prosody(raw.volume, '%', -20, 5, DEFAULTS.volume),
        speaker: ['Serena', 'Vivian'].includes(raw.speaker) ? raw.speaker : DEFAULTS.speaker,
        style: ['cute-slow', 'cute', 'soft', 'lively', 'quiet'].includes(raw.style) ? raw.style : DEFAULTS.style,
        port: Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535 ? raw.port : DEFAULTS.port,
        localTimeoutMs: Number.isFinite(raw.localTimeoutMs) ? Math.max(1000, Math.min(45000, raw.localTimeoutMs)) : DEFAULTS.localTimeoutMs,
        voiceLocked: raw.voiceLocked === true || raw.mode === 'reference',
        mode: raw.mode === 'reference' ? 'reference' : 'builtin',
        seed: Number.isSafeInteger(raw.seed) ? raw.seed : 20261026,
        reference: { sha256: String(raw.reference?.sha256 ?? '').toLowerCase(), text: String(raw.reference?.text ?? '').trim() },
    };
    const delivery = raw.delivery === undefined ? {} : raw.delivery;
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) throw new Error('tts: 无效语音语气配置');
    const instruct = delivery.instruct === undefined ? '' : delivery.instruct,
        tempo = delivery.tempo === undefined ? 1 : delivery.tempo,
        gainDb = delivery.gainDb === undefined ? 0 : delivery.gainDb;
    if (typeof instruct !== 'string' || [...instruct].length > 800
        || typeof tempo !== 'number' || !Number.isFinite(tempo) || tempo < .6 || tempo > 1.2
        || typeof gainDb !== 'number' || !Number.isFinite(gainDb) || gainDb < -6 || gainDb > 9
        || (Object.keys(delivery).length && cfg.mode !== 'reference')) throw new Error('tts: 无效语音语气配置');
    cfg.delivery = { instruct, tempo, gainDb };
    cfg.voiceProfileKey = profileKey(cfg);
    return cfg;
}

async function validAudio(path, maxAge = Infinity) {
    const info = await stat(path).catch(() => null);
    return info?.isFile() && info.size >= 1000 && Date.now() - info.mtimeMs < maxAge;
}

async function pruneCache(dir) {
    const names = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.mp3$/.test(name));
    const rows = await Promise.all(names.map(async name => ({ path: join(dir, name), info: await stat(join(dir, name)).catch(() => null) })));
    rows.sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0));
    await Promise.all(rows.filter((row, i) => i >= 64 || Date.now() - (row.info?.mtimeMs ?? 0) > CACHE_TTL)
        .map(row => unlink(row.path).catch(() => {})));
}

/** Injectable runners keep network/GPU tests separate from the real delivery tool. */
export function createSpeechSynthesizer({ edgeRunner = runEdgeTts, qwenRunner = runQwenTts,
    report = value => console.info('[dsh-tts] ' + JSON.stringify(value)) } = {}) {
    const inflight = new Map();
    async function produce(engine, cfg, text, outPath, options, timeoutMs) {
        const identity = engine === 'qwen' ? ['qwen3-tts-locked-v5', cfg.voiceProfileKey]
            : ['edge-v1', cfg.voice, cfg.rate, cfg.pitch, cfg.volume];
        const key = createHash('sha256').update(JSON.stringify([identity, text])).digest('hex');
        const dir = join(dirname(outPath), '.cache');
        const cache = join(dir, key + '.mp3');
        await mkdir(dir, { recursive: true });
        let cached = await validAudio(cache, CACHE_TTL);
        const started = Date.now();
        if (!cached) {
            let job = inflight.get(cache);
            if (!job) {
                job = (async () => {
                    const temp = join(dir, key + '-' + randomUUID() + '.tmp.mp3');
                    try {
                        if (engine === 'qwen') await qwenRunner({ ...cfg, text, outPath: temp, timeoutMs });
                        else await edgeRunner({ ...cfg, text, outPath: temp, timeoutMs, python: options.python });
                        if (!await validAudio(temp)) throw new Error('tts: 生成的文件为空');
                        await rename(temp, cache);
                    }
                    finally { await unlink(temp).catch(() => {}); }
                })();
                inflight.set(cache, job);
                job.finally(() => { if (inflight.get(cache) === job) inflight.delete(cache); }).catch(() => {});
            }
            await job;
        }
        await copyFile(cache, outPath);
        void pruneCache(dir).catch(() => {});
        report({ engine, cache: cached, chars: [...text].length, elapsed_ms: Date.now() - started });
        return outPath;
    }
    return async options => {
        const text = String(options?.text ?? '').trim();
        const outPath = String(options?.outPath ?? '');
        if (!text) throw new Error('tts: text 不能为空');
        if ([...text].length > TTS_MAX_CHARS) throw new Error('tts: 最多 ' + TTS_MAX_CHARS + ' 字');
        if (!outPath) throw new Error('tts: outPath 不能为空');
        // Await the very first config read; the old fire-and-forget read used
        // the wrong fallback voice for the first request after every restart.
        const cfg = await speechConfig(options.configPath);
        if (options.engine === 'edge') cfg.engine = 'edge';
        if (!cfg.voiceLocked && TTS_VOICES.includes(options.voice)) {
            cfg.engine = 'edge';
            cfg.voice = options.voice;
        }
        const budget = Math.max(1000, Math.min(60000, Number(options.timeoutMs) || 30000));
        const deadline = Date.now() + budget;
        if (cfg.engine === 'qwen' && (budget > 9000 || cfg.voiceLocked)) {
            try {
                return await produce('qwen', cfg, text, outPath, options, Math.min(cfg.localTimeoutMs, cfg.voiceLocked ? budget : budget - 8000));
            }
            catch (error) {
                if (cfg.voiceLocked) {
                    report({ engine: 'qwen', unavailable: true, voiceLocked: true });
                    throw Object.assign(new Error('tts: 固定声线暂时不可用，请保留当前声线'), { code: 'tts_voice_unavailable' });
                }
                report({ engine: 'qwen', fallback: 'edge', reason: error?.name === 'TimeoutError' ? 'timeout' : 'unavailable' });
            }
        }
        return produce('edge', cfg, text, outPath, options, Math.max(1, deadline - Date.now()));
    };
}
export const synthesizeSpeech = createSpeechSynthesizer();

export async function runQwenTts({ port, text, speaker, style, outPath, timeoutMs, voiceLocked, voiceProfileKey }) {
    const root = 'http://127.0.0.1:' + port;
    const deadline = Date.now() + timeoutMs;
    const queueUntil = Math.min(deadline, Date.now() + 2500);
    let health;
    do {
        health = await fetch(root + '/health', { signal: AbortSignal.timeout(Math.max(1, Math.min(700, deadline - Date.now()))) }).then(r => r.json());
        if (health.service !== 'dsh-qwen-tts' || !health.ready) throw new Error('tts: 本地引擎未就绪');
        if (voiceLocked && health.voiceProfileKey !== voiceProfileKey) throw new Error('tts: 固定声线配置尚未加载');
        if (!health.busy || !voiceLocked || Date.now() >= queueUntil) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < queueUntil);
    if (health.busy) throw new Error('tts: 本地引擎忙');
    const response = await fetch(root + '/speech', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, speaker, style }), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/mpeg')) throw new Error('tts: 本地合成失败');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1000 || bytes.length > 8 * 1024 * 1024) throw new Error('tts: 无效音频大小');
    await writeFile(outPath, bytes);
}

export async function runEdgeTts(options) {
    const configured = String(options.python ?? process.env.DSH_TTS_PYTHON ?? '').trim();
    const localEnv = join(REPO, 'bot-home', 'tts-runtime', '.venv', 'Scripts', 'python.exe');
    const userPython = process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : '';
    const candidates = configured ? [configured] : [...new Set([
        'python',
        ...(userPython && existsSync(userPython) ? [userPython] : []),
        ...(existsSync(localEnv) ? [localEnv] : []),
    ])];
    const started = Date.now();
    for (const [i, python] of candidates.entries()) {
        try { return await edgeProcess(python, { ...options, timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - started)) }); }
        catch (error) { if (i === candidates.length - 1 || !/ENOENT|启动失败|No module named/i.test(error.message)) throw error; }
    }
}

function edgeProcess(python, { voice, rate, pitch, volume, text, outPath, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const child = spawn(python, ['-m', 'edge_tts', '--voice', voice, '--rate=' + rate,
            '--pitch=' + pitch, '--volume=' + volume, '--text', text, '--write-media', outPath],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        child.on('error', error => { clearTimeout(timer); reject(new Error('tts: 启动失败: ' + error.message)); });
        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) reject(new Error('tts: 超时'));
            else if (code === 0) resolve();
            else reject(new Error('tts: 退出码 ' + code + (stderr ? ': ' + stderr.slice(-300) : '')));
        });
    });
}
