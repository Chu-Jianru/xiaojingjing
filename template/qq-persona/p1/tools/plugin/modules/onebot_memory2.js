/**
 * [dsh-p1] 长期记忆 v2 (P1): one JSONL store with per-chat isolation,
 * forget-with-backup, and shared notes merged in.
 *
 * v1 (patch_onebot_memory.py + patch_onebot_shared_notes.py) had two stores
 * and no isolation:
 *   - memories.jsonl recalled by bigram overlap in EVERY chat, so a memory
 *     learned in a private DM could surface in a group — the README's
 *     "不要把私聊内容带到群里" constraint was enforced only by the model.
 *   - shared-notes.md was a separate file, always injected everywhere.
 *   - nothing could be deleted: "说「忘掉」能删干净" (P1 acceptance) was
 *     impossible without hand-editing the JSONL.
 *
 * v2 rules (this module, wired by patch_onebot_memory_v2.py):
 *   - every record has a scope: 'chat' (default, only visible where it was
 *     learned; legacy records without scope count as 'chat') or 'global'
 *     (visible everywhere). Group recall NEVER sees private-chat records.
 *   - shared notes ("记住：…" taught by the admin) are stored here too as
 *     kind='note', scope='global'; the [共同记忆] block is rendered from
 *     them, so there is a single store to tidy/backup.
 *   - only global notes already pinned in [共同记忆] are excluded from recall;
 *     older notes remain retrievable and private notes stay in their chat.
 *   - qq_forget deletes matching *visible* records and appends them to
 *     memory/removed.jsonl (rollback = re-append the original lines).
 *   - v2.00 (P1 semantic recall): when the local embedder (transformers.js +
 *     bge-small-zh, provider at bot-home\embed\provider.mjs) is ready and the
 *     vectors.json sidecar covers ≥80% of candidates, ranking becomes
 *     0.7×cosine + 0.3×bigram; anything else degrades to pure bigram.
 *
 * Storage: <mediaDir>/memory/memories.jsonl (+ removed.jsonl), atomic
 * rewrite on forget. Cache: 30 s per mediaDir, invalidated on writes.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export const MEMORY_V2_DEFAULTS = {
    /** [记忆] recall: how many lines to inject per message. */
    recallTopN: 4,
    /** Load cache lifetime. */
    cacheMs: 30_000,
    /** [共同记忆]: latest N notes, tail-trimmed to this many chars. */
    notesMaxLines: 40,
    notesMaxChars: 800,
    /** qq_forget: minimum share of the query's bigrams present in a record. */
    forgetGramCoverage: 0.6,
    /** Semantic mode needs the sidecar to cover at least this share of
     *  candidates; below it the ranking would mix incomparable scores. */
    semanticMinCoverage: 0.8,
    /** Semantic relevance floor (cosine); calibrated 2026-10-25 on
     *  bge-small-zh: related ≥0.52, unrelated ≤0.40. */
    semanticMinCos: 0.48,
    /** qq_memories: default/list cap. */
    listLimit: 20,
    /** qq_remember: max text length. */
    maxTextChars: 200,
};

const caches = new Map();
const loads = new Map(), writes = new Map(), revisions = new Map();
const gramCache = new WeakMap(), queryCaches = new WeakMap();

function mutateMemory(dir, operation) {
    const work = (writes.get(dir) ?? Promise.resolve()).catch(() => {}).then(operation);
    writes.set(dir, work);
    return work.finally(() => { if (writes.get(dir) === work) writes.delete(dir); });
}

function queryEmbedding(embed, text) {
    let cache = queryCaches.get(embed);
    if (!cache) { cache = new Map(); queryCaches.set(embed, cache); }
    const old = cache.get(text);
    if (old && Date.now() - old.at < 5 * 60_000) return old.promise;
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    const row = { at: Date.now(), promise: Promise.resolve().then(() => embed([text])) };
    cache.set(text, row);
    row.promise.catch(() => { if (cache.get(text) === row) cache.delete(text); });
    return row.promise;
}

function memoryFile(mediaDir) {
    return join(String(mediaDir), 'memory', 'memories.jsonl');
}

function removedFile(mediaDir) {
    return join(String(mediaDir), 'memory', 'removed.jsonl');
}

function parseLines(raw) {
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '')
            continue;
        try {
            const item = JSON.parse(line);
            if (item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text.trim() !== '')
                items.push(item);
        }
        catch { /* skip broken line */ }
    }
    return items;
}

export async function loadMemories(mediaDir) {
    const dir = String(mediaDir);
    await writes.get(dir)?.catch(() => {});
    const cached = caches.get(dir);
    if (cached !== undefined && Date.now() - cached.at < MEMORY_V2_DEFAULTS.cacheMs)
        return cached.items;
    if (loads.has(dir)) return await loads.get(dir);
    const work = (async () => {
        while (true) {
            await writes.get(dir)?.catch(() => {});
            const revision = revisions.get(dir) ?? 0;
            let items;
            try { items = parseLines(await readFile(memoryFile(dir), 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT') throw error; items = []; }
            if (revision !== (revisions.get(dir) ?? 0)) continue;
            if (caches.size >= 32) caches.delete(caches.keys().next().value);
            caches.set(dir, { at: Date.now(), items });
            return items;
        }
    })();
    loads.set(dir, work);
    try { return await work; } finally { if (loads.get(dir) === work) loads.delete(dir); }
}

function invalidate(mediaDir) {
    const dir = String(mediaDir);
    caches.delete(dir); revisions.set(dir, (revisions.get(dir) ?? 0) + 1);
}

// -- semantic recall (P1, v2.00) --------------------------------------------------------
// Local embeddings via transformers.js + bge-small-zh (ONNX q8). The provider
// lives OUTSIDE the plugin tree (bot-home\embed\) because the profile's own
// node_modules can't be re-resolved by npm; we import it by absolute path.
// Every failure path (no provider, no model, slow first download, embed
// error) degrades to the v1.95 bigram scorer, so recall never breaks.
const EMBED_PROVIDER = process.env.DSH_EMBED_PROVIDER
    ?? join(REPO, 'bot-home', 'embed', 'provider.mjs');
const EMBED_MODEL = 'Xenova/bge-small-zh-v1.5';
const EMBED_DIM = 512;
const embedder = { state: 'idle', extractor: null, loadPromise: null };

function vectorsFile(mediaDir) {
    return join(String(mediaDir), 'memory', 'vectors.json');
}

/** Stable per-record id (existing id, or FNV-1a of ts|chat|text for legacy). */
export function memoryIdOf(item) {
    if (typeof item?.id === 'string' && item.id !== '')
        return item.id;
    const key = `${Number(item?.ts) || 0}|${item?.chat ?? ''}|${item?.text ?? ''}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i += 1) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'h' + hash.toString(16) + '-' + key.length.toString(36);
}

/** float[-1,1] → int8 for compact sidecar storage. */
export function quantizeVec(vec) {
    return Array.from(vec, v => Math.max(-127, Math.min(127, Math.round(Number(v) * 127))));
}

export function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Lazy background init: recall uses embeddings only once state === 'ready'. */
function loadEmbedder() {
    if (embedder.state === 'ready')
        return Promise.resolve(embedder.extractor);
    if (embedder.state === 'failed')
        return Promise.resolve(null);
    if (embedder.loadPromise === null) {
        embedder.state = 'loading';
        embedder.loadPromise = (async () => {
            const mod = await import(pathToFileURL(EMBED_PROVIDER).href);
            const extractor = await mod.pipeline('feature-extraction', mod.EMBED_MODEL ?? EMBED_MODEL, {
                dtype: 'q8',
                cache_dir: join(dirname(EMBED_PROVIDER), 'models'),
            });
            embedder.extractor = async texts => {
                const out = await extractor(texts, { pooling: 'mean', normalize: true });
                return out.tolist();
            };
            embedder.state = 'ready';
            return embedder.extractor;
        })().catch(() => {
            embedder.state = 'failed';
            embedder.loadPromise = null;
            return null;
        });
    }
    return embedder.loadPromise;
}
// warm start in the background; a cold ~25s first download never blocks a turn
void loadEmbedder();

let vectorsCache = { at: 0, byDir: '' , data: null };

async function loadVectors(mediaDir, force = false) {
    const dir = String(mediaDir);
    if (!force && vectorsCache.byDir === dir && Date.now() - vectorsCache.at < MEMORY_V2_DEFAULTS.cacheMs)
        return vectorsCache.data;
    let data = null;
    try {
        const parsed = JSON.parse(await readFile(vectorsFile(dir), 'utf8'));
        if (parsed?.model === EMBED_MODEL && parsed?.dim === EMBED_DIM && parsed?.vecs !== null && typeof parsed.vecs === 'object')
            data = parsed;
    }
    catch { /* missing or corrupt: rebuild lazily */ }
    // a missing sidecar is NOT cached: every recall retries the cheap read,
    // so the first ensureVectors write flips recall to semantic immediately
    if (data !== null)
        vectorsCache = { at: Date.now(), byDir: dir, data };
    else if (vectorsCache.byDir === dir)
        vectorsCache = { at: 0, byDir: '', data: null };
    return data;
}

async function saveVectors(mediaDir, vecs) {
    const dir = String(mediaDir);
    const file = vectorsFile(dir);
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const payload = { version: 1, model: EMBED_MODEL, dim: EMBED_DIM, vecs };
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, file);
    vectorsCache = { at: Date.now(), byDir: dir, data: payload };
}

const ensureVectorsInFlight = new Map();

/** Embed any visible-relevant records missing from the sidecar (one batch). */
async function ensureVectors(mediaDir, items) {
    const dir = String(mediaDir);
    if (ensureVectorsInFlight.has(dir))
        return ensureVectorsInFlight.get(dir);
    const run = (async () => {
        const embed = await loadEmbedder();
        if (embed === null || items.length === 0)
            return;
        const current = (await loadVectors(dir, true)) ?? { version: 1, model: EMBED_MODEL, dim: EMBED_DIM, vecs: {} };
        const missing = items.filter(item => current.vecs[memoryIdOf(item)] === undefined);
        if (missing.length === 0)
            return;
        const fresh = await embed(missing.map(item => item.text));
        await mutateMemory(dir, async () => {
            // A forget/append may have completed while embeddings were running.
            // Merge against the latest sidecar and keep only records still live.
            const live = new Set(parseLines(await readFile(memoryFile(dir), 'utf8')).map(memoryIdOf));
            const latest = (await loadVectors(dir, true)) ?? { vecs: {} };
            missing.forEach((item, i) => {
                const id = memoryIdOf(item);
                if (live.has(id) && fresh[i]?.length) latest.vecs[id] = quantizeVec(fresh[i]);
            });
            await saveVectors(dir, latest.vecs);
        });
    })().catch(() => { /* sidecar stays partial; recall falls back per-item */ })
        .finally(() => ensureVectorsInFlight.delete(dir));
    ensureVectorsInFlight.set(dir, run);
    return run;
}

/** Isolation: 'global' records cross chats; everything else stays home.
 *  A group never sees private-chat records and vice versa. */
export function visibleIn(item, chatId) {
    return item.scope === 'global' || item.chat === chatId;
}

function bigramSet(text) {
    const clean = String(text ?? '').replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i + 1 < clean.length; i += 1)
        set.add(clean.slice(i, i + 2));
    return set;
}

/** [记忆] block: hybrid semantic + bigram recall over visible records.
 *  deps is injectable for tests: { embed(texts) -> vecs, vectors } — the
 *  default wires the local bge embedder and the vectors.json sidecar.
 *
 *  Semantic mode (embedder ready + sidecar covers ≥ semanticMinCoverage of
 *  the visible pool): candidates are ALL visible records — no lexical gate —
 *  qualifying on cosine ≥ semanticMinCos OR any bigram overlap; ranking is
 *  0.7×cosine + 0.3×bigram. Bigram mode (v1.95) keeps the overlap>0 gate.
 *  Threshold 0.48 calibrated on the real model: related ≥0.52, unrelated
 *  ≤0.40 (tools probe, 2026-10-25). */
export async function recallMemoryBlock(mediaDir, chatId, text, deps = {}) {
    let items;
    try { items = await loadMemories(mediaDir); }
    catch (error) { console.warn('[memory] recall read unavailable: ' + error.code); return ''; }
    const target = bigramSet(text);
    if (items.length === 0 || target.size === 0)
        return '';
    const shared = new Set(sharedNoteLines(items));
    const pool = items.filter(item => !(item.kind === 'note' && item.scope === 'global' && shared.has('- ' + item.text)) && visibleIn(item, chatId));
    if (pool.length === 0)
        return '';
    // keep the vector sidecar warm in the background (fire-and-forget, never
    // blocks the recall); during cold start this chains the first embedding
    // right after the model finishes loading
    void loadEmbedder().then(embed => {
        if (embed !== null)
            return ensureVectors(mediaDir, pool);
    }).catch(() => undefined);
    const overlapOf = (item) => {
        let grams = gramCache.get(item);
        if (!grams) { grams = bigramSet(item.text); gramCache.set(item, grams); }
        let overlap = 0;
        for (const gram of grams)
            if (target.has(gram))
                overlap += 1;
        return overlap;
    };

    const embedTexts = deps.embed !== undefined
        ? deps.embed
        // only use the real embedder once it is READY: during the ~25s cold
        // start the turn must not block — bigram covers it, semantics kick in
        // from the next message on.
        : (embedder.state === 'ready' ? embedder.extractor : null);
    let queryVec = null;
    let vecs = null;
    if (embedTexts !== null) {
        try {
            vecs = await (deps.vectors ? deps.vectors() : loadVectors(mediaDir));
            const covered = pool.filter(item => vecs?.vecs?.[memoryIdOf(item)] !== undefined).length;
            if (covered / pool.length >= MEMORY_V2_DEFAULTS.semanticMinCoverage)
                queryVec = (await queryEmbedding(embedTexts, text))[0] ?? null;
        }
        catch { queryVec = null; }
    }
    const withVec = queryVec !== null && vecs !== null
        ? pool.filter(item => vecs.vecs?.[memoryIdOf(item)] !== undefined).length
        : 0;
    const semantic = queryVec !== null && vecs !== null
        && withVec / pool.length >= MEMORY_V2_DEFAULTS.semanticMinCoverage;

    const scored = [];
    for (const item of pool) {
        const overlap = overlapOf(item);
        let base;
        if (semantic) {
            const itemVec = vecs.vecs[memoryIdOf(item)];
            if (itemVec === undefined) {
                // no vector for this one: it may still ride pure bigram, low
                if (overlap === 0)
                    continue;
                base = 0.3 * (overlap / Math.max(1, target.size));
            }
            else {
                const cos = cosine(queryVec, itemVec);
                if (overlap === 0 && cos < MEMORY_V2_DEFAULTS.semanticMinCos)
                    continue;
                base = 0.7 * cos + 0.3 * (overlap / Math.max(1, target.size));
            }
        }
        else {
            if (overlap === 0)
                continue;
            base = overlap / Math.max(1, target.size);
        }
        let score = base * 10;
        if (item.chat === chatId)
            score += 2;
        score += Math.max(0, 3 - (Date.now() - Number(item.ts ?? 0)) / (30 * 24 * 3600 * 1000));
        scored.push({ item, score });
    }
    if (scored.length === 0)
        return '';
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set(), lines = [];
    for (const { item } of scored) {
        const key = JSON.stringify([item.chat, item.scope ?? 'chat', item.kind ?? 'fact', item.text]);
        if (item.kind !== 'event' && seen.has(key)) continue;
        seen.add(key); lines.push('- ' + item.text);
        if (lines.length >= MEMORY_V2_DEFAULTS.recallTopN) break;
    }
    return lines.join('\n');
}

/** [共同记忆] block: the admin-taught notes, newest last, tail-trimmed. */
export async function notesBlock(mediaDir) {
    let items;
    try { items = await loadMemories(mediaDir); }
    catch (error) { console.warn('[memory] shared-note read unavailable: ' + error.code); return ''; }
    return sharedNoteLines(items).join('\n');
}

function sharedNoteLines(items) {
    const notes = items.filter(item => item.kind === 'note' && item.scope === 'global');
    if (notes.length === 0)
        return [];
    const lines = [], seen = new Set(); let size = 0;
    for (const item of notes.slice(-MEMORY_V2_DEFAULTS.notesMaxLines).reverse()) {
        if (seen.has(item.text)) continue;
        seen.add(item.text);
        const line = '- ' + item.text;
        if (size + line.length + (lines.length ? 1 : 0) > MEMORY_V2_DEFAULTS.notesMaxChars) continue;
        size += line.length + (lines.length ? 1 : 0); lines.push(line);
    }
    return lines.reverse();
}

/** Append one record (qq_remember / 记住： / auto-learn all funnel here). */
export async function appendMemory(mediaDir, record) {
    const dir = String(mediaDir);
    return await mutateMemory(dir, () => appendMemoryUnlocked(dir, record));
}

async function appendMemoryUnlocked(dir, record) {
    const text = String(record?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_V2_DEFAULTS.maxTextChars);
    if (text === '')
        throw new Error('memory: text 不能为空');
    const kind = typeof record?.kind === 'string' && record.kind !== '' ? record.kind : 'fact';
    const scope = record?.scope === 'global' ? 'global' : 'chat';
    const entry = { ts: Date.now(), chat: String(record?.chat ?? ''), kind, text, scope };
    entry.id = 'm' + entry.ts.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    if (record?.auto === true)
        entry.auto = true;
    if (typeof record?.autoKey === 'string' && record.autoKey !== '')
        entry.autoKey = record.autoKey;
    const file = memoryFile(dir);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
    invalidate(dir);
    // warm the vector sidecar in the background; failure just means this
    // record recalls via bigram until the next ensureVectors pass
    if (embedder.state === 'ready')
        void ensureVectors(dir, [entry]).catch(() => undefined);
    return entry;
}

function normalize(text) {
    return String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** Share of the query's bigrams that appear anywhere in the text. Chinese
 *  forget-queries are keyword-ish ("打赌输了", "香菜"), so query-side coverage
 *  works better than symmetric similarity (which short queries always lose). */
function gramCoverage(queryGrams, text) {
    if (queryGrams.size === 0)
        return 0;
    const grams = bigramSet(text);
    let hit = 0;
    for (const gram of queryGrams)
        if (grams.has(gram))
            hit += 1;
    return hit / queryGrams.size;
}

/** Forget: remove visible records matching query (normalized substring, or
 *  ≥60 % of the query's bigrams present). Removed records are archived
 *  verbatim to memory/removed.jsonl with _removedAt/_removedFrom for manual
 *  rollback. Reads the FULL file (not the 500-item recall cache) so the
 *  rewrite never drops unrelated old records or malformed original lines. */
export async function forgetMemories(mediaDir, chatId, query) {
    const dir = String(mediaDir);
    return await mutateMemory(dir, () => forgetMemoriesUnlocked(dir, chatId, query));
}

async function forgetMemoriesUnlocked(dir, chatId, query) {
    const q = String(query ?? '').trim();
    if (q === '' || normalize(q) === '')
        return { removed: [] };
    let raw = '';
    try {
        raw = await readFile(memoryFile(dir), 'utf8');
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const qNorm = normalize(q);
    const qGrams = bigramSet(q);
    const removed = [];
    const kept = [];
    for (const line of raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        let item;
        try { item = JSON.parse(line); } catch { kept.push(line); continue; }
        if (typeof item?.text === 'string' && visibleIn(item, chatId)
            && (normalize(item.text).includes(qNorm) || gramCoverage(qGrams, item.text) >= MEMORY_V2_DEFAULTS.forgetGramCoverage))
            removed.push(item);
        else
            kept.push(line);
    }
    if (removed.length === 0)
        return { removed: [] };
    const file = memoryFile(dir);
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const archive = removed.map(item => ({
        ...item,
        _removedAt: Date.now(),
        _removedFrom: String(chatId ?? ''),
    }));
    await appendFile(removedFile(dir), archive.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
    await writeFile(tmp, kept.join(''), 'utf8');
    await rename(tmp, file);
    invalidate(dir);
    try {
        const current = await loadVectors(dir, true);
        if (current !== null) {
            for (const item of removed) delete current.vecs[memoryIdOf(item)];
            await saveVectors(dir, current.vecs);
        }
    } catch { /* stale vectors cannot recall absent records; prune is best effort */ }
    return { removed: removed.map(item => item.text) };
}

/** qq_memories: what she can see in this chat, newest first. */
export async function listMemories(mediaDir, chatId, query = '', limit = MEMORY_V2_DEFAULTS.listLimit) {
    const items = await loadMemories(mediaDir);
    const qNorm = normalize(query);
    const rows = items
        .filter(item => visibleIn(item, chatId))
        .filter(item => qNorm === '' || normalize(item.text).includes(qNorm))
        .slice()
        .reverse()
        .slice(0, Math.min(100, Math.max(1, Math.floor(Number(limit) || MEMORY_V2_DEFAULTS.listLimit))))
        .map(item => ({ ts: Number(item.ts ?? 0), kind: item.kind ?? 'fact', scope: item.scope === 'global' ? 'global' : 'chat', text: item.text }));
    return rows;
}
