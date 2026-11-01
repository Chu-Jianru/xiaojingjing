// Read-only native Session replay. Run with the bundled Electron-as-Node host:
// ... context_budget.mjs <absolute dsh-session/lib/index.js> [group session dir]
// It never writes the production session and prints no conversation content.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decompressFrames, SESSIONS_ROOT } from '../plugin/modules/onebot_usage.js';
import { planWorkingContext, applyWorkingContext } from '../plugin/modules/onebot_working_context.js';
import { makeReplyTool } from '../plugin/modules/onebot_reply.js';

const require = createRequire(import.meta.url), modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass the installed dsh-session module path');
const { Session } = require(modulePath);
const { createUserMessage } = require(modulePath.replace('dsh-session', 'dsh-llm'));
const { defineTool } = require(modulePath.replace('dsh-session', 'dsh-tools'));
// Also validate the new tool schema with the real host compiler.
const reply = makeReplyTool(defineTool, {}, {});
if (reply.parameters.properties.memories.items.type !== 'object') throw new Error('Unexpected reply schema');
const name = process.argv[3] ?? 'onebot-group-__GROUP_QQ__-mvnnwis6';
if (!/^onebot-group-[\w-]+$/.test(name)) throw new Error('Invalid session basename');
const raw = await readFile(join(SESSIONS_ROOT, name, 'session.v4.jsonl.zstd'));
const records = decompressFrames(raw, zstdDecompressSync).split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
}).filter(row => Number.isInteger(row.seq)); // The file's first header is not a Session event.
const session = new Session(name, records);
const chars = messages => messages.reduce((n, message) => n + message.content.reduce((sum, block) => sum + (block.text?.length ?? 0), 0), 0);
const bodies = messages => messages.filter(m => m.role === 'user' && m.source?.kind === 'plugin:dsh-onebot').flatMap(m => m.content
    .filter(b => b.type === 'text' && b.text.includes('<user_message ')).map(b => b.text.slice(b.text.indexOf('<user_message '))));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const beforeMessages = session.deriveMessages(), beforeChars = chars(beforeMessages), beforeBodies = hash(bodies(beforeMessages));
const archiveLength = session.log.length, originalLog = hash(session.log);
const plan = planWorkingContext(session), changed = applyWorkingContext(session, plan, createUserMessage);
const afterMessages = session.deriveMessages(), afterChars = chars(afterMessages);
const restored = new Session(name, session.log);
const report = { originalLogEvents: records.length, candidateMessages: plan.candidateMessages,
    changedMessages: changed, beforeTextChars: beforeChars, afterTextChars: afterChars,
    savedTextChars: beforeChars - afterChars, textReductionRatio: (beforeChars - afterChars) / (beforeChars || 1),
    recentMessagesKept: plan.keepRecent, userBodiesIntact: beforeBodies === hash(bodies(afterMessages)),
    archivedOriginalLogIntact: originalLog === hash(session.log.slice(0, archiveLength)),
    nativeReplayExact: JSON.stringify(restored.deriveMessages()) === JSON.stringify(afterMessages),
    note: 'Character counts, not measured provider tokens; production cleanup waits for an existing compaction boundary.' };
console.log(JSON.stringify(report, null, 2));
if (!report.userBodiesIntact || !report.archivedOriginalLogIntact || !report.nativeReplayExact) process.exitCode = 1;
