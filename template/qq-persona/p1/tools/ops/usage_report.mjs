/**
 * Daily token usage report (P5 cost dashboard, v2.01).
 *
 *   node tools/ops/usage_report.mjs [days]        # default 7; prints + writes JSON
 *
 * Scheduled as Bot-usage-report (04:50, after the git snapshot) — the JSON
 * lands in logs/usage-report.json and one summary line goes to stdout/log.
 */

import { existsSync } from 'node:fs';
import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { usageByDays, SESSIONS_ROOT } from '../plugin/modules/onebot_usage.js';

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

const days = Math.min(30, Math.max(1, Math.trunc(Number(process.argv[2]) || 7)));
const byDays = await usageByDays(days);

const fmt = n => n.toLocaleString('en-US');
console.log(`token 用量（最近 ${days} 天，${SESSIONS_ROOT}）`);
console.log('日期        回合  输入       输出     缓存命中        总token');
for (const [day, r] of Object.entries(byDays)) {
    console.log(
        `${day}  ${String(r.total.turns).padStart(4)}  ${fmt(r.total.inputTokens).padStart(9)}  ${fmt(r.total.outputTokens).padStart(7)}  ${fmt(r.total.cacheReadTokens).padStart(11)}  ${fmt(r.total.totalTokens).padStart(11)}`,
    );
    const top = Object.entries(r.chats).sort((a, b) => b[1].turns - a[1].turns).slice(0, 3);
    for (const [chatId, c] of top)
        console.log(`    ${chatId}: ${c.turns} 回合 / ${fmt(c.totalTokens)} tokens`);
}

const out = join(REPO, 'logs', 'usage-report.json');
await mkdir(dirname(out), { recursive: true });
const tmp = out + '.tmp';
await writeFile(tmp, JSON.stringify({ generatedAt: new Date().toISOString(), days: byDays }, null, 1), 'utf8');
await rename(tmp, out);
console.log('written:', out);
