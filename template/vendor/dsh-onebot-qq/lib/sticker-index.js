/**
 * [dsh-p1] 表情包指纹匹配：认出「这张图是不是她库里的表情包」，并带上含义。
 *
 * 不是文件哈希：QQ 会重压缩/缩放，SHA 全变；这里用 dHash（9×8 灰度差分，
 * 64 位）——同一张图重压缩后通常只差 0–4 位，汉明距离 ≤ 阈值即命中。
 *
 * 索引：<mediaDir>/stickers/fingerprints.json
 *   由本模块的 buildStickerIndex() 生成；库里新增图片后，load 时会发现
 *   memes 目录比索引新，后台重建一次（当前这次先不匹配）。
 *
 * 库外的图（新梗图）不猜；交给 OCR / 视觉模型。
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const INDEX_VERSION = 1;
const CACHE_MS = 60_000;
const HASH_BITS = 256;
const DEFAULT_MAX_DISTANCE = 24;
const BUILD_INFLIGHT = new Set();
let cache = { mediaDir: '', at: 0, index: null };

const FFMPEG_CANDIDATES = [
    'ffmpeg',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
];

function errText(error) {
    return error instanceof Error ? error.message : String(error);
}

function indexPath(mediaDir) {
    return join(mediaDir, 'stickers', 'fingerprints.json');
}

function memesDir(mediaDir) {
    return join(mediaDir, 'stickers', 'memes');
}

function runFfmpegGray(path, width, height) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-i', path,
            '-vf', `scale=${width}:${height}:flags=area,format=gray`,
            '-frames:v', '1',
            '-f', 'rawvideo',
            '-',
        ];
        const tryAt = index => {
            const program = FFMPEG_CANDIDATES[index];
            const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const chunks = [];
            let stderr = '';
            const timer = setTimeout(() => {
                try { child.kill(); } catch { /* gone */ }
                reject(new Error('sticker: ffmpeg 超时'));
            }, 8_000);
            child.stdout.on('data', chunk => chunks.push(chunk));
            child.stderr.on('data', chunk => { stderr += String(chunk); });
            child.on('error', error => {
                clearTimeout(timer);
                if (index + 1 < FFMPEG_CANDIDATES.length) tryAt(index + 1);
                else reject(new Error('sticker: ffmpeg 启动失败: ' + errText(error)));
            });
            child.on('close', code => {
                clearTimeout(timer);
                if (code === 0 && chunks.length > 0) {
                    resolve(Buffer.concat(chunks));
                    return;
                }
                if (index + 1 < FFMPEG_CANDIDATES.length) {
                    tryAt(index + 1);
                    return;
                }
                reject(new Error('sticker: ffmpeg 退出码 ' + code + (stderr ? ' ' + stderr.slice(-200) : '')));
            });
        };
        tryAt(0);
    });
}

/** 256 位 dHash（17×16 灰度差分，16×16 个比较），返回 64 位十六进制。 */
export async function computeDHash(path) {
    const raw = await runFfmpegGray(path, 17, 16);
    if (raw.length < 272) throw new Error('sticker: 解码结果不足 272 字节');
    let hash = 0n;
    for (let y = 0; y < 16; y += 1) {
        for (let x = 0; x < 16; x += 1) {
            const left = raw[y * 17 + x];
            const right = raw[y * 17 + x + 1];
            hash = (hash << 1n) | (left > right ? 1n : 0n);
        }
    }
    return hash.toString(16).padStart(HASH_BITS / 4, '0');
}

/** 两个 dHash 的汉明距离。 */
export function hammingDistance(a, b) {
    let x = BigInt('0x' + String(a)) ^ BigInt('0x' + String(b));
    let count = 0;
    while (x > 0n) {
        count += Number(x & 1n);
        x >>= 1n;
    }
    return count;
}

/** 64×64 灰度像素（用于指纹分不清时的像素级复核）。 */
export async function computeGray64(path) {
    const raw = await runFfmpegGray(path, 64, 64);
    if (raw.length < 64 * 64) throw new Error('sticker: 灰度解码不足');
    return raw;
}

/** 两张 64×64 灰度的平均绝对差（0–255，越小越像）。 */
export function meanAbsDiff(left, right) {
    const size = Math.min(left.length, right.length);
    if (size === 0) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += Math.abs(left[i] - right[i]);
    return sum / size;
}

/** 解析「文件名 = 含义」清单。 */
export function parseMeanings(text) {
    const map = new Map();
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const file = trimmed.slice(0, idx).trim();
        const meaning = trimmed.slice(idx + 1).trim();
        if (file !== '') map.set(file, meaning);
    }
    return map;
}

async function listStickerFiles(mediaDir) {
    try {
        const entries = await readdir(memesDir(mediaDir), { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
            .map(entry => entry.name)
            .sort();
    }
    catch {
        return [];
    }
}

/** 重建指纹索引（幂等）；可选 ocr(path) 为每张库图补 OCR 文本。 */
export async function buildStickerIndex({ mediaDir, personaDir, ocr }) {
    const files = await listStickerFiles(mediaDir);
    if (files.length === 0) return { version: INDEX_VERSION, builtAt: Date.now(), items: [] };
    let meanings = new Map();
    try {
        meanings = parseMeanings(await readFile(join(personaDir, '表情包含义.txt'), 'utf8'));
    }
    catch { /* meanings optional */ }

    const items = [];
    for (const file of files) {
        try {
            const hash = await computeDHash(join(memesDir(mediaDir), file));
            const name = file.replace(/\.[^.]+$/, '');
            let ocrText = '';
            if (typeof ocr === 'function') {
                try {
                    ocrText = String(await ocr(join(memesDir(mediaDir), file)) ?? '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 300);
                }
                catch { ocrText = ''; }
            }
            items.push({
                file,
                name,
                hash,
                meaning: (meanings.get(file) ?? '').slice(0, 200),
                ocrText,
            });
        }
        catch { /* skip unreadable image */ }
    }
    const payload = { version: INDEX_VERSION, builtAt: Date.now(), items };
    const target = indexPath(mediaDir);
    await mkdir(dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, target);
    cache = { mediaDir, at: Date.now(), index: payload };
    return payload;
}

/** 库里新增图片时，后台重建一次（同一目录同时只跑一个）。 */
function scheduleRebuild(mediaDir, personaDir) {
    if (BUILD_INFLIGHT.has(mediaDir)) return;
    BUILD_INFLIGHT.add(mediaDir);
    void buildStickerIndex({ mediaDir, personaDir })
        .catch(() => undefined)
        .finally(() => BUILD_INFLIGHT.delete(mediaDir));
}

/** 读取索引；缺失/过期时后台重建（本次返回旧索引或 null）。 */
export async function loadStickerIndex({ mediaDir, personaDir }) {
    const now = Date.now();
    if (cache.mediaDir === mediaDir && now - cache.at < CACHE_MS) {
        return cache.index;
    }
    let index = null;
    let indexMtime = 0;
    try {
        index = JSON.parse(await readFile(indexPath(mediaDir), 'utf8'));
        indexMtime = (await stat(indexPath(mediaDir))).mtimeMs;
    }
    catch { index = null; }
    if (index === null || !Array.isArray(index.items)) {
        scheduleRebuild(mediaDir, personaDir);
        cache = { mediaDir, at: now, index: null };
        return null;
    }
    try {
        const memesMtime = (await stat(memesDir(mediaDir))).mtimeMs;
        if (memesMtime > indexMtime) scheduleRebuild(mediaDir, personaDir);
    }
    catch { /* ignore */ }
    cache = { mediaDir, at: now, index };
    return index;
}

/**
 * 匹配一张图；命中返回 {file,name,meaning,distance}，否则 null。
 * 指纹接近到分不清时，若给了 ocr(path) 回调，会用 OCR 文本做一次消歧；
 * OCR 也分不开就返回 null（宁可不认，也不安错含义）。
 * @param {{path:string, mediaDir:string, personaDir:string, maxDistance?:number, ocr?:(path:string)=>Promise<string>}} options
 */
export async function matchSticker(options) {
    const index = await loadStickerIndex({ mediaDir: options.mediaDir, personaDir: options.personaDir });
    if (index === null || index.items.length === 0) return null;
    const hash = await computeDHash(options.path);
    const maxDistance = Number(options.maxDistance) > 0 ? Number(options.maxDistance) : DEFAULT_MAX_DISTANCE;
    const ranked = index.items
        .map(item => ({ item, distance: hammingDistance(hash, item.hash) }))
        .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    if (best === undefined || best.distance > maxDistance) return null;
    const second = ranked[1];
    if (second === undefined || second.distance - best.distance >= 20) return toResult(best);

    const top = ranked.slice(0, 3);

    // 1) 指纹分不清：先用 OCR 文本消歧——但候选图自己的 OCR 文本都很像时，
    //    OCR 没有区分力（同一张底图只改了水印），直接走像素复核。
    const ocrCandidates = top.filter(row => String(row.item.ocrText ?? '').trim() !== '');
    const ocrTop = ocrCandidates.slice(0, 2);
    const ocrDiscriminative = ocrTop.length >= 2
        && ocrSimilarity(ocrTop[0].item.ocrText, ocrTop[1].item.ocrText) < 0.85;
    if (typeof options.ocr === 'function' && ocrDiscriminative) {
        let inboundText = '';
        try {
            inboundText = String(await options.ocr(options.path) ?? '');
        }
        catch { inboundText = ''; }
        if (normalizeOcrText(inboundText) !== '') {
            const scored = ocrCandidates
                .map(row => ({ ...row, score: ocrSimilarity(inboundText, row.item.ocrText) }))
                .sort((a, b) => b.score - a.score);
            if (scored[0].score >= 0.85) return toResult(scored[0]);
            if (scored[0].score >= 0.45
                && (scored[1] === undefined || scored[0].score - scored[1].score >= 0.15)) {
                return toResult(scored[0]);
            }
        }
    }

    // 2) OCR 分不开（或库图没有 OCR 文本）：用 64×64 灰度像素复核。
    return disambiguateByPixels(options.path, top, options.mediaDir);
}

/** 指纹/OCR 都分不开时，比较 64×64 灰度 MAD，选明显更近的一张。 */
async function disambiguateByPixels(path, candidates, mediaDir) {
    try {
        const inbound = await computeGray64(path);
        const scored = [];
        for (const row of candidates.slice(0, 3)) {
            try {
                const gray = await computeGray64(join(memesDir(mediaDir), row.item.file));
                scored.push({ ...row, pixel: meanAbsDiff(inbound, gray) });
            }
            catch { /* skip unreadable candidate */ }
        }
        if (scored.length === 0) return null;
        scored.sort((a, b) => a.pixel - b.pixel);
        if (scored.length > 1 && scored[1].pixel - scored[0].pixel < 0.08) return null;
        if (scored[0].pixel > 2.0) return null;
        return toResult({ ...scored[0], score: 1 });
    }
    catch {
        return null;
    }
}

function toResult(row) {
    return {
        file: row.item.file,
        name: row.item.name,
        meaning: row.item.meaning,
        distance: row.distance,
        score: row.score,
    };
}

/** OCR 文本归一化：去水印、去标点空白、小写。 */
export function normalizeOcrText(text) {
    return String(text ?? '')
        .replace(/(?:知乎\s*@[^\s|]+|(?:抖音|d料音|dou音)号?[:：]?\s*\d+)/gi, '')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .toLowerCase();
}

/** 两段 OCR 文本的字符二元组 Dice 相似度（0–1）。 */
export function ocrSimilarity(a, b) {
    const left = normalizeOcrText(a);
    const right = normalizeOcrText(b);
    if (left === '' || right === '') return 0;
    if (left === right) return 1;
    if (left.length < 2 || right.length < 2) return 0;
    const grams = text => {
        const map = new Map();
        for (let i = 0; i < text.length - 1; i += 1) {
            const gram = text.slice(i, i + 2);
            map.set(gram, (map.get(gram) ?? 0) + 1);
        }
        return map;
    };
    const ga = grams(left);
    const gb = grams(right);
    let intersection = 0;
    let total = 0;
    for (const [gram, count] of ga) {
        total += count;
        intersection += Math.min(count, gb.get(gram) ?? 0);
    }
    for (const count of gb.values()) total += count;
    return total === 0 ? 0 : (2 * intersection) / total;
}

/** Test seam. */
export function resetStickerCache() {
    cache = { mediaDir: '', at: 0, index: null };
}
