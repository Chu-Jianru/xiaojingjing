/** Read-only group latency/compaction diagnostics. No message content is printed.
 * node tools/ops/group_performance.mjs [ISO timestamp with timezone] [session directory]
 * Auxiliary compaction requests are not included in assistant/message usage.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { decompressFrames, SESSIONS_ROOT } from '../plugin/modules/onebot_usage.js';

const percentile = (values, ratio) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] : null;
};

export function analyzePerformance(records, fromMs = 0) {
    const starts = new Map(), compactions = new Map(), durations = [], firstResponses = [];
    const result = { turns: 0, errors: 0, modelCalls: 0, silentCalls: 0, compactions: 0,
        compactionErrors: 0, compactionMs: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    const responded = new Set();
    for (const row of records) {
        const data = row.data ?? {};
        if (row.type === 'turn/start') starts.set(data.turn, row.time);
        if (row.type === 'compaction/start') compactions.set(data.compactionId, row.time);
        if (row.time < fromMs) continue;
        if (row.type === 'turn/end' && starts.get(data.turn) >= fromMs) {
            result.turns++;
            if (data.reason?.kind === 'error') result.errors++;
            durations.push(row.time - starts.get(data.turn));
        }
        if (row.type === 'compaction/start') result.compactions++;
        if (row.type === 'compaction/end' && compactions.get(data.compactionId) >= fromMs) {
            result.compactionMs += row.time - compactions.get(data.compactionId);
            if (data.error) result.compactionErrors++;
        }
        if (row.type !== 'assistant/message') continue;
        result.modelCalls++;
        if (data.message?.content?.some(block => block.text?.trim() === '[不回]')) result.silentCalls++;
        const usage = data.usage ?? {};
        result.uncachedInputTokens += Number(usage.inputTokens) || 0;
        result.cachedInputTokens += Number(usage.cacheReadTokens) || 0;
        result.outputTokens += Number(usage.outputTokens) || 0;
        if (!responded.has(data.turn) && starts.get(data.turn) >= fromMs) {
            responded.add(data.turn);
            // This is model response completion, not QQ delivery or first text token.
            firstResponses.push(row.time - starts.get(data.turn));
        }
    }
    return { ...result, turnP50Ms: percentile(durations, .5), turnP90Ms: percentile(durations, .9),
        firstResponseP50Ms: percentile(firstResponses, .5),
        cacheHitRatio: result.cachedInputTokens / (result.uncachedInputTokens + result.cachedInputTokens || 1),
        usageExcludesCompaction: true };
}

export async function inspectGroups({ fromMs = 0, session } = {}) {
    const names = session ? [session] : (await readdir(SESSIONS_ROOT)).filter(name => name.startsWith('onebot-group-'));
    const result = {};
    for (const name of names) {
        // Only a directory basename is accepted; never resolve caller input outside sessions.
        if (!/^onebot-group-[\w-]+$/.test(name)) throw new Error('Invalid group session directory');
        const raw = await readFile(join(SESSIONS_ROOT, name, 'session.v4.jsonl.zstd'));
        const records = decompressFrames(raw, zstdDecompressSync).split('\n').flatMap(line => {
            try { return [JSON.parse(line)]; } catch { return []; }
        });
        result[name] = analyzePerformance(records, fromMs);
    }
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const fromMs = process.argv[2] ? Date.parse(process.argv[2]) : Date.now() - 3_600_000;
    if (!Number.isFinite(fromMs)) throw new Error('Expected ISO timestamp with timezone');
    console.log(JSON.stringify({ since: new Date(fromMs).toISOString(), groups: await inspectGroups({ fromMs, session: process.argv[3] }) }, null, 2));
}
