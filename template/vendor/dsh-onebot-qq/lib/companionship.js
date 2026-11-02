/** Shared social opportunities and her own accepted commitments, without sharing private transcripts. */
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { profileGet } from './profiles.js';
import { loadMood } from './mood.js';

export const SOCIAL_THRESHOLDS = Object.freeze({ relay: 10, sing: 60, status: 60, call: 100 });
export const SOCIAL_AFFECTION = Object.freeze({ relay: 40, sing: 55, status: 55, call: 65 });
const queues = new Map();
const relays = new WeakMap();
const dirOf = bridge => bridge?.deps?.config?.mediaDir;
export function turnActor(bridge, sessionId) {
    const chatId = bridge?.chatForSession?.(sessionId);
    const chat = bridge?.chats?.get(chatId);
    if (!chat || !['admin', 'member'].includes(chat.activeTurnRole)) return null;
    const userId = String(chat.activeTurnUserId ?? (chatId.startsWith('private:') ? chatId.slice(8) : ''));
    if (!/^\d{5,12}$/.test(userId)) return null;
    return { chatId, userId, admin: chat.activeTurnRole === 'admin' };
}
export function socialOpportunity(profile, capability, admin = false) {
    if (admin) return { allowed: true, owner: true };
    const minimum = SOCIAL_THRESHOLDS[capability];
    if (minimum === undefined) return { allowed: false, code: 'unknown_capability' };
    const count = Math.max(0, Number(profile?.msgCount) || 0);
    const affection = Number.isFinite(profile?.affection) ? profile.affection : 50;
    const allowed = count >= minimum && affection >= SOCIAL_AFFECTION[capability];
    return { allowed, stage: count >= 100 ? '亲近' : count >= 60 ? '熟悉' : count >= 10 ? '认识' : '初识',
        ...(!allowed ? { code: 'need_more_familiarity', next: '按自己的语气表达还想再熟悉些；不念权限、工具、分数或固定话术，不伪称完成' } : {}) };
}
async function relationship(bridge, userId) {
    const profile = await profileGet(dirOf(bridge), userId);
    const mood = await loadMood(dirOf(bridge));
    return { ...profile, affection: mood.affection?.[userId] ?? 50 };
}
export async function requireOpportunity(bridge, sessionId, capability) {
    const actor = turnActor(bridge, sessionId);
    if (!actor) throw new Error('这轮还无法确认是谁在托我办事，先问清楚，不冒认老大');
    const decision = socialOpportunity(await relationship(bridge, actor.userId), capability, actor.admin);
    if (!decision.allowed) throw new Error('还想和对方再熟悉些；自然回应，不念权限或次数，也别说已经办了');
    return actor;
}
export async function relayTargetAllowed(bridge, actor, target) {
    if (actor.admin) return;
    // A friend can ask for a relay into a group they actually share with her.
    // Membership comes from QQ, never the model's claim or a quoted user ID.
    const match = /^group:(\d{5,12})$/.exec(target);
    if (!match) throw new Error('先只帮朋友往共同的群捎话；不替人骚扰陌生联系人');
    const data = await bridge.guardedConnectionCall('get_group_member_list', { group_id: Number(match[1]) });
    const rows = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(rows) || !rows.some(row => String(row.user_id) === actor.userId))
        throw new Error('还没确认这是和对方共同的群，先问清楚目的地');
}
export async function relayText(bridge, sessionId, target, text) {
    const actor = await requireOpportunity(bridge, sessionId, 'relay');
    await relayTargetAllowed(bridge, actor, target);
    if (!/^(private|group):\d{5,12}$/.test(target) || !text.trim() || text.length > 1000) throw new Error('传话目标或正文不完整');
    const chat = bridge.chats.get(actor.chatId);
    let state = relays.get(bridge);
    if (!state) { state = new Map(); relays.set(bridge, state); }
    const key = JSON.stringify([sessionId, chat.activeTurnSequence, target, text]);
    if (state.has(key)) return state.get(key);
    const job = (async () => {
        const profile = await profileGet(dirOf(bridge), actor.userId);
        const name = String(profile?.nickname || actor.userId).replace(/[\r\n\[\]]/g, '').slice(0, 40);
        const message = actor.admin ? text : name + '托我捎句话：' + text;
        const [kind, id] = target.split(':');
        const value = await bridge.guardedConnectionCall('send_msg', { message_type: kind,
            ...(kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) }),
            message: [{ type: 'text', data: { text: message } }] });
        const messageId = value?.message_id ?? value?.data?.message_id;
        return messageId ? { sent: true, messageId } : { sent: false, status: 'unknown', next: '回执未确认，不说已送达，不重复投递' };
    })();
    state.set(key, job);
    if (state.size > 128) state.delete(state.keys().next().value);
    return job;
}
async function rows(mediaDir) {
    try { return (await readFile(join(mediaDir, 'companionship.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    }); } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}
async function append(mediaDir, row) {
    const previous = queues.get(mediaDir) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
        await mkdir(mediaDir, { recursive: true });
        await appendFile(join(mediaDir, 'companionship.jsonl'), JSON.stringify({ ...row, at: Date.now() }) + '\n');
        return row;
    });
    queues.set(mediaDir, job);
    try { return await job; } finally { if (queues.get(mediaDir) === job) queues.delete(mediaDir); }
}
export async function rememberCommitment(bridge, sessionId, args) {
    const actor = turnActor(bridge, sessionId);
    if (!actor) throw new Error('commitment_actor_unknown');
    const text = String(args?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 180) throw new Error('只简短记下自己认真接受的做法，最多180字');
    const key = String(args?.topic ?? '').trim().slice(0, 40);
    if (!key) throw new Error('commitment_topic_required');
    return append(dirOf(bridge), { kind: 'commitment', userId: actor.userId, topic: key, text,
        share: args?.share === true, chatId: actor.chatId, active: args?.active !== false });
}
export async function renderCommitments(mediaDir, chatId, userId) {
    const current = new Map();
    for (const row of await rows(mediaDir)) if (row.kind === 'commitment') current.set(row.userId + ':' + row.topic, row);
    const visible = [...current.values()].filter(row => row.active && (row.share || row.chatId === chatId));
    // Public entries contain her own chosen conduct, never copied private messages.
    const chosen = visible.sort((a, b) => Number(b.userId === String(userId)) - Number(a.userId === String(userId)) || b.at - a.at).slice(0, 8);
    return chosen.length ? '[自己的约定]\n' + chosen.map(row => '- ' + row.text).join('\n') + '\n认真接受的做法跨群与私聊保持一致；别把别人的要求自动当自己的承诺。\n[/自己的约定]' : '';
}
export async function grantCall(bridge, sessionId, args = {}) {
    const actor = args.allow === false ? turnActor(bridge, sessionId) : await requireOpportunity(bridge, sessionId, 'call');
    if (!actor) throw new Error('call_actor_unknown');
    const expires = Date.now() + 2 * 60 * 60_000;
    await append(dirOf(bridge), { kind: 'call', userId: actor.userId, expires: args.allow === false ? 0 : expires });
    return { allowed: args.allow !== false, expires: args.allow === false ? null : expires,
        next: '这是同意对方在两小时内拨入QQ一对一电话，不代表已经拨打或接通；目前没有主动拨号能力' };
}
export async function allowedCallers(bridge) {
    const owners = [...(bridge.deps?.policy?.adminUsers ?? []), ...(bridge.deps?.config?.adminUsers ?? [])].map(String);
    const current = new Map();
    for (const row of await rows(dirOf(bridge))) if (row.kind === 'call') current.set(row.userId, row);
    const allowed = new Set(owners);
    for (const row of current.values()) if (row.expires > Date.now()
        && socialOpportunity(await relationship(bridge, row.userId), 'call').allowed) allowed.add(row.userId);
    return [...allowed];
}

export function companionshipTools(defineTool, bridge) {
    const output = { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] };
    return [defineTool({ name: 'qq_commitment',
        description: '认真答应一个长期相处约定时记下自己的决定，或明确改口时更新；不能把别人单方面的要求自动变承诺。share=true只用于能跨场景执行的自己行为，不写私聊原话、秘密或他人经历；同一人同topic更新生效，不删除旧记录。',
        parameters: { topic: { type: 'string', required: true }, text: { type: 'string', required: true },
            share: { type: 'boolean', description: '自己的做法需要群聊私聊保持一致且无隐私时才true' }, active: { type: 'boolean' } },
        output, isConcurrencySafe: () => false, execute: (args, exec) => rememberCommitment(bridge, exec.agent?.session.id, args) }),
    defineTool({ name: 'qq_call_permission', description: '熟悉亲近的朋友请求QQ语音通话时，可以自行决定是否答应，allow=true开放该人两小时内的一对一拨入；老大无亲密度限制。不是主动拨号，不能假称正在打给对方。',
        parameters: { allow: { type: 'boolean', required: true } }, output, isConcurrencySafe: () => false,
        execute: (args, exec) => grantCall(bridge, exec.agent?.session.id, args) })];
}
