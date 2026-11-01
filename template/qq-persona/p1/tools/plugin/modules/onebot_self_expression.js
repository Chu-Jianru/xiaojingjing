/** Own public signature only; never exposes management or credential actions. */
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicTextAllowed } from './journal.js';

const queues = new Map();
export async function updateSignature(mediaDir, text, call, now = Date.now()) {
    const previous = queues.get(mediaDir) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
        const body = String(text ?? '').trim();
        if (!body || body.length > 60 || /[\r\n\[\]<>]/.test(body)) throw new Error('signature_invalid');
        let seeds = [];
        try { seeds = JSON.parse(await readFile(join(mediaDir, 'journal/state.json'), 'utf8')).seeds ?? []; }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('signature_privacy_unavailable'); }
        if (!publicTextAllowed(body, seeds)) throw new Error('signature_private_content');
        const path = join(mediaDir, 'self-expression.json');
        let old;
        try { old = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('signature_state_invalid'); }
        if (old?.text === body) return { changed: false, reason: old.status === 'changed' ? 'same' : 'outcome_unknown' };
        if (old && (!Number.isFinite(old.at) || now - old.at < 12 * 3600_000)) return { changed: false, reason: 'cooldown' };
        await mkdir(mediaDir, { recursive: true });
        const save = async state => {
            const tmp = path + '.' + randomUUID() + '.tmp';
            await writeFile(tmp, JSON.stringify(state), 'utf8');
            await rename(tmp, path);
        };
        // Reserve before writing: ambiguous delivery must not be retried after restart.
        await save({ at: now, text: body, status: 'unknown' });
        try {
            const result = await call('set_self_longnick', { longNick: body });
            if (result?.result !== undefined && Number(result.result) !== 0) throw new Error('signature_rejected');
            await save({ at: now, text: body, status: 'changed' });
            return { changed: true };
        }
        catch { return { changed: false, reason: 'outcome_unknown' }; }
    });
    queues.set(mediaDir, work);
    try { return await work; }
    finally { if (queues.get(mediaDir) === work) queues.delete(mediaDir); }
}

export function makeSelfExpressionTool(defineTool, bridge) {
    return defineTool({
        name: 'qq_self_expression',
        description: '有一个愿意公开的小念头时，可自主改自己的QQ个签，不必等命令；不是每次聊天都改。只写自己的偏好/感受，不写他人的事、账号、私聊或群聊细节；12小时最多一次。不负责修改QQ个性标签列表。',
        parameters: { text: { type: 'string', required: true, description: '个签，最多60字' } },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const chatId = bridge.chatForSession(exec.agent?.session.id);
            if (!chatId || !bridge.chats?.has(chatId) || bridge.deps.config.inject?.intercepting) throw new Error('signature_chat_unavailable');
            return updateSignature(bridge.deps.config.mediaDir, args?.text, (action, params) => bridge.guardedConnectionCall(action, params));
        },
    });
}
