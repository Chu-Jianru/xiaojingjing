import { readFile, stat, mkdir, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

export function favoriteUrls(data) {
    const value = Array.isArray(data) ? data : data?.data ?? data?.faces ?? [];
    return Array.isArray(value) ? [...new Set(value.map(row => typeof row === 'string' ? row : row?.url ?? row?.file).filter(url => /^https?:\/\//i.test(url || '')))] : [];
}
async function favoriteNotes(mediaDir) {
    try { return (await readFile(join(mediaDir, 'stickers/favorites.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    }); } catch { return []; }
}
export async function rememberFavorite(mediaDir, path, meaning = '', source = '') {
    const bytes = await readFile(path);
    const md5 = createHash('md5').update(bytes).digest('hex');
    const row = { md5, path, meaning: String(meaning).trim().slice(0, 160), source, at: Date.now() };
    await mkdir(join(mediaDir, 'stickers'), { recursive: true });
    await appendFile(join(mediaDir, 'stickers/favorites.jsonl'), JSON.stringify(row) + '\n', 'utf8');
    return row;
}
export async function findFavorites(mediaDir, data, query = '', limit = 8, offset = 0) {
    const notes = await favoriteNotes(mediaDir);
    const urls = favoriteUrls(data);
    const terms = String(query).toLowerCase().split(/[\s，,、/]+/u).filter(Boolean);
    const rows = urls.map(url => {
        const note = notes.findLast(row => url.toLowerCase().includes(row.md5) || row.source === url);
        const meaning = note?.meaning || '';
        const score = terms.reduce((n, term) => n + (meaning.toLowerCase().includes(term) ? 10 : 0), 0);
        return { url, meaning: meaning || '尚未理解含义，需要先看图，不凭链接猜', as_sticker: true, score };
    }).sort((a,b) => b.score-a.score);
    const start = Math.max(0, Math.floor(Number(offset)||0));
    const selected = rows.slice(start, start+limit).map(({score,...row}) => row);
    return { total: urls.length, offset: start, next_offset: start+limit<urls.length ? start+limit : null,
        stickers: selected, urls: selected.map(row => row.url) };
}

export async function findStickers(personaDir, mediaDir, query = '', limit = 8) {
    const index = JSON.parse(await readFile(join(personaDir, 'stickers/memes-index.json'), 'utf8'));
    const terms = String(query).toLowerCase().split(/[\s，,、/]+/u).filter(Boolean);
    const grams = term => term.length < 2 ? [term] : Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2));
    const rows = (index.memes ?? []).filter(m => m.ready !== false && m.desc && basename(m.file) === m.file).map(m => {
        const body = (m.file + ' ' + m.desc).toLowerCase();
        const score = terms.reduce((n, term) => n + (body.includes(term) ? 10 : grams(term).filter(g => body.includes(g)).length), 0);
        return { m, score };
    }).filter(row => !terms.length || row.score > 0).sort((a, b) => b.score - a.score);
    const result = [];
    for (const { m } of rows) {
        const path = join(mediaDir, 'stickers/memes', m.file);
        try { if (!(await stat(path)).isFile()) continue; } catch { continue; }
        result.push({ file: m.file, meaning: String(m.desc).slice(0, 160), path });
        if (result.length >= Math.max(1, Math.min(12, Number(limit) || 8))) break;
    }
    return result;
}
