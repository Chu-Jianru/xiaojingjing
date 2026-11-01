/**
 * [dsh-p1] token 用量统计（P5 成本看板，v2.01）。
 *
 * Where the numbers live: every `assistant/message` record inside DSH
 * session logs (bot-home/sessions/<workspace>/<chat>/session.v4.jsonl.zstd,
 * multi-frame zstd) carries `data.usage` =
 *   { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
 * plus `time` (epoch ms) and the model name. Nothing else on disk has usage.
 *
 * Exposed as:
 *   - the `qq_cost` tool (patch_onebot_usage.py) so she can answer 老大's
 *     "今天花了多少" honestly (core.md §16: 成本要如实直答);
 *   - tools/ops/usage_report.mjs (daily 04:50 task) for the human-readable log.
 *
 * The DeepSeek account tier bills by subscription, not per-token, so these
 * are RELATIVE cost figures — exactly what "你太烧钱了" needs to reason about.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
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

function findSessionsRoot() {
    const base = join(REPO, 'bot-home', 'sessions');
    try {
        const names = readdirSync(base, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort();
        for (const name of names) {
            const dir = join(base, name);
            if (readdirSync(dir).some(f => f.startsWith('onebot-'))) return dir;
        }
    } catch { /* sessions 目录不可读时走兜底 */ }
    return join(base, '--E-dsh-qq-persona-p1-workspace--');
}

export const SESSIONS_ROOT = findSessionsRoot();

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** chat session dir name (onebot-private-__ADMIN_QQ__) → chatId (private:__ADMIN_QQ__) */
export function chatIdFromDir(name) {
    const m = /^onebot-(private|group)-(\d+)$/.exec(String(name ?? ''));
    return m === null ? String(name ?? '') : m[1] + ':' + m[2];
}

/** One multi-frame zstd session log → concatenated text (broken frames skipped). */
export function decompressFrames(buf, decompress) {
    const offsets = [];
    for (let i = 0; i <= buf.length - 4; i += 1)
        if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3])
            offsets.push(i);
    const parts = [];
    for (let k = 0; k < offsets.length; k += 1) {
        const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
        try {
            parts.push(decompress(buf.subarray(offsets[k], end)));
        }
        catch { /* torn tail frame during a live append: skip */ }
    }
    return Buffer.concat(parts).toString('utf8');
}

/** Aggregate parsed assistant/message records into a usage summary. */
export function aggregateRecords(records) {
    const total = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    const chats = {};
    for (const rec of records) {
        const usage = rec?.data?.usage;
        if (usage === null || typeof usage !== 'object')
            continue;
        const chatId = String(rec.chatId ?? 'unknown');
        const bucket = chats[chatId] ?? (chats[chatId] = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
        bucket.turns += 1;
        total.turns += 1;
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
            const v = Number(usage[key]) || 0;
            bucket[key] += v;
            total[key] += v;
        }
    }
    return { total, chats };
}

function localDayStartMs(offsetDays = 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - offsetDays * 24 * 3600 * 1000;
}

/** Scan session logs for records in [fromMs, toMs). chatId comes from the dir. */
export async function scanUsage({ fromMs = 0, toMs = Number.MAX_SAFE_INTEGER, root = SESSIONS_ROOT, decompress } = {}) {
    if (typeof decompress !== 'function') {
        let zstd;
        try {
            zstd = (await import('node:zlib')).zstdDecompressSync;
        }
        catch {
            throw new Error('usage: this Node has no zstd support');
        }
        decompress = zstd;
    }
    const records = [];
    let workspaces;
    try {
        workspaces = await readdir(root, { withFileTypes: true });
    }
    catch {
        return aggregateRecords([]);
    }
    for (const chatDir of workspaces) {
        if (!chatDir.isDirectory())
            continue;
        const chatId = chatIdFromDir(chatDir.name);
        const file = join(root, chatDir.name, 'session.v4.jsonl.zstd');
        let info;
        try {
            info = await stat(file);
        }
        catch {
            continue;
        }
        // session logs are append-only and chronological: an untouched-since
        // file cannot contain records in range
        if (info.mtimeMs < fromMs)
            continue;
        let text;
        try {
            text = decompressFrames(await readFile(file), decompress);
        }
        catch {
            continue;
        }
        for (const line of text.split('\n')) {
            if (line.trim() === '' || !line.startsWith('{"type":"assistant/message"'))
                continue;
            let rec;
            try {
                rec = JSON.parse(line);
            }
            catch {
                continue;
            }
            const time = Number(rec?.time) || 0;
            if (time < fromMs || time >= toMs)
                continue;
            records.push({ ...rec, chatId });
        }
    }
    return aggregateRecords(records);
}

/** Last N days (including today), oldest first, keyed 'YYYY-MM-DD'. */
export async function usageByDays(days = 1, root = SESSIONS_ROOT, decompress) {
    const n = Math.min(30, Math.max(1, Math.floor(Number(days) || 1)));
    const out = {};
    for (let i = n - 1; i >= 0; i -= 1) {
        const start = localDayStartMs(i);
        const end = i === 0 ? Number.MAX_SAFE_INTEGER : localDayStartMs(i - 1);
        const key = new Date(start).toLocaleDateString('sv-SE');
        out[key] = await scanUsage({ fromMs: start, toMs: end, root, decompress });
    }
    return out;
}
