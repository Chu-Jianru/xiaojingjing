/**
 * [dsh-p1] 热梗召回 (hot-meme recall).
 *
 * She should understand 网上热梗 and be able to 接梗, without stuffing a 70-entry
 * dictionary into every prompt (the prompt is already ~10.7KB). Instead, every
 * inbound message is matched against <mediaDir>/hot-memes.jsonl and only the
 * entries the message actually hits (max 2) are injected as a trusted block:
 *
 *   [梗]
 *   - 不烧心：AI 短剧梗：靠谱、放心、不坑人（顺着夸一句）
 *   [/梗]
 *
 * Matching: substring on term + aliases after stripping whitespace; ASCII is
 * lowercased. Entries marked `exact` only match when the whole message equals
 * the term (single-word replies like 「典」), so a dictionary word cannot
 * hijack 经典/典故. The file is hot-reloadable (60s cache), so adding a meme is
 * one line — no rebuild, no restart.
 *
 * Data file shape (one JSON per line):
 *   {"term":"不烧心","aliases":[],"meaning":"…","reply":"…","exact":false}
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

export const HOT_MEMES_PATH = join(REPO, 'bot-home', 'media', 'onebot', 'hot-memes.jsonl');
const CACHE_MS = 60_000;
const MAX_ITEMS = 400;

let cache = { at: 0, items: [] };

const squash = text => String(text ?? '').toLowerCase().replace(/\s+/g, '');

async function loadMemes(path = HOT_MEMES_PATH) {
    const now = Date.now();
    const cached = path === HOT_MEMES_PATH;
    if (cached && now - cache.at < CACHE_MS)
        return cache.items;
    let items = [];
    try {
        const raw = await readFile(path, 'utf8');
        items = raw.split(/\r?\n/).map(line => {
            if (line.trim() === '')
                return null;
            try {
                const item = JSON.parse(line);
                if (item === null || typeof item !== 'object' || typeof item.term !== 'string' || item.term === '')
                    return null;
                return {
                    term: item.term,
                    aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
                    meaning: typeof item.meaning === 'string' ? item.meaning : '',
                    example: typeof item.example === 'string' ? item.example : '',
                    reply: typeof item.reply === 'string' ? item.reply : '',
                    exact: item.exact === true,
                };
            }
            catch {
                return null;
            }
        }).filter(item => item !== null);
    }
    catch { /* no meme file yet */ }
    if (cached)
        cache = { at: now, items: items.slice(-MAX_ITEMS) };
    return items.slice(-MAX_ITEMS);
}

/**
 * Return a `- term：meaning（reply）` block for the memes this text hits.
 * Empty string when nothing matches (the caller injects nothing).
 */
export async function recallHotMemes(text, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 2;
    const hay = squash(text);
    if (hay === '')
        return '';
    const items = await loadMemes(options.path);
    if (items.length === 0)
        return '';
    const scored = [];
    for (const item of items) {
        const terms = [item.term, ...item.aliases].filter(term => typeof term === 'string' && term !== '');
        let best = 0;
        for (const term of terms) {
            const needle = squash(term);
            if (needle === '')
                continue;
            const hit = item.exact ? hay === needle : hay.includes(needle);
            if (hit)
                best = Math.max(best, needle.length);
        }
        if (best > 0)
            scored.push({ item, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    const seen = new Set();
    for (const { item } of scored) {
        if (seen.has(item.term))
            continue;
        seen.add(item.term);
        picked.push(item);
        if (picked.length >= limit)
            break;
    }
    return picked.map(item => {
        const hint = item.example !== '' ? '接法：' + item.example : item.reply;
        return '- ' + item.term + '：' + item.meaning + (hint === '' ? '' : '（' + hint + '）');
    }).join('\n');
}

/** Test seam: drop the cache. */
export function resetHotMemeCache() {
    cache = { at: 0, items: [] };
}

export default recallHotMemes;
