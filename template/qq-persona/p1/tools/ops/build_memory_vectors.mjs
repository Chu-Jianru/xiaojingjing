/**
 * Rebuild memory/vectors.json from scratch (P1 semantic recall, v2.00).
 *
 * Run after: first deploy, `tidy_memory.py`, manual edits to memories.jsonl,
 * or whenever recall should re-embed everything:
 *
 *   node tools/ops/build_memory_vectors.mjs [--media-dir E:\path\to\onebot]
 *
 * Reuses the live module (tools/plugin/modules/onebot_memory2.js) so ids/quantization stay
 * consistent with runtime behavior. Safe to re-run; replaces the sidecar
 * atomically. Notes (kind=note) are not embedded — they never ride [记忆].
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { memoryIdOf, quantizeVec } from '../plugin/modules/onebot_memory2.js';

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

const PROVIDER = process.env.DSH_EMBED_PROVIDER ?? join(REPO, 'bot-home', 'embed', 'provider.mjs');
const MODEL = 'Xenova/bge-small-zh-v1.5';
const DIM = 512;

function argMediaDir() {
    const i = process.argv.indexOf('--media-dir');
    if (i !== -1 && process.argv[i + 1] !== undefined)
        return process.argv[i + 1];
    return join(REPO, 'bot-home', 'media', 'onebot');
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

const mediaDir = argMediaDir();
const file = join(mediaDir, 'memory', 'memories.jsonl');
const items = parseLines(await readFile(file, 'utf8'));
const targets = items.filter(item => item.kind !== 'note');
console.log(`memories: ${items.length} total, ${targets.length} to embed (notes excluded)`);

const mod = await import(pathToFileURL(PROVIDER).href);
const extractor = await mod.pipeline('feature-extraction', mod.EMBED_MODEL ?? MODEL, {
    dtype: 'q8',
    cache_dir: join(dirname(PROVIDER), 'models'),
});

const BATCH = 64;
const vecs = {};
for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const out = await extractor(batch.map(item => item.text), { pooling: 'mean', normalize: true });
    const rows = out.tolist();
    batch.forEach((item, j) => {
        vecs[memoryIdOf(item)] = quantizeVec(rows[j] ?? []);
    });
    process.stdout.write(`  embedded ${Math.min(i + BATCH, targets.length)}/${targets.length}\r`);
}
console.log('');

const payload = { version: 1, model: mod.EMBED_MODEL ?? MODEL, dim: DIM, vecs };
const out = join(mediaDir, 'memory', 'vectors.json');
await mkdir(dirname(out), { recursive: true });
const tmp = out + '.tmp';
await writeFile(tmp, JSON.stringify(payload), 'utf8');
await rename(tmp, out);
console.log('vectors.json written:', out, `(${Object.keys(vecs).length} entries)`);
