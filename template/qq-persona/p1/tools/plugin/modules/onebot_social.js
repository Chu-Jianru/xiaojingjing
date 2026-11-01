import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const services = new WeakMap();
export class SocialService {
    constructor(mediaDir, call) { this.dir = mediaDir; this.call = call; this.queue = Promise.resolve(); }
    run(task) {
        const next = this.queue.catch(() => {}).then(task);
        this.queue = next;
        return next;
    }
    async load() {
        try {
            const rows = JSON.parse(await readFile(join(this.dir, 'social-requests.json'), 'utf8'));
            if (!Array.isArray(rows)) throw new Error('social_ledger_invalid');
            return rows;
        } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    }
    async save(rows) {
        await mkdir(this.dir, { recursive: true });
        const path = join(this.dir, 'social-requests.json'), temp = path + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify(rows, null, 1), 'utf8');
        await rename(temp, path);
    }
    request(args, chatId, { allowRetry = false } = {}) {
        return this.run(async () => {
            const { action, target } = args;
            if (!['add_friend', 'join_group'].includes(action) || !/^[1-9]\d{4,11}$/.test(String(target))) throw new Error('social_target_invalid');
            const rows = await this.load();
            const old = rows.findLast(e => e.action === action && e.target === String(target));
            if (old && !['already_friend', 'already_member'].includes(old.status)) {
                const current = await this.call('/v1/social/status', { action, target: String(target) }).catch(() => null);
                if (['already_friend', 'already_member'].includes(current?.status)) {
                    old.status = current.status; old.confirmedAt = Date.now();
                    await this.save(rows);
                    return current;
                }
            }
            const answering = old?.status === 'needs_answer' && String(args.answer ?? '').trim() !== '';
            if (old && !answering && !(old.status === 'rejected' && args.retry === true && allowRetry))
                return { action, target: String(target), status: old.status, repeated: true, next: '不要重复申请；可查好友/群列表确认是否通过' };
            const entry = { id: randomUUID(), action, target: String(target), chatId, at: Date.now(), status: 'sending' };
            rows.push(entry);
            await this.save(rows);
            try { Object.assign(entry, await this.call('/v1/social/request', { action, target: String(target), message: String(args.message ?? ''), answer: String(args.answer ?? '') })); }
            catch (error) { entry.status = 'unknown'; entry.error = String(error.message).slice(0, 200); }
            await this.save(rows);
            return { ...entry, next: entry.status === 'submitted' ? '仅申请已提交，等待对方/群管理员通过；不说已加成功' : undefined };
        });
    }
    recent(chatId) { return this.run(async () => {
        const rows = await this.load(), visible = rows.filter(e => e.chatId === chatId).slice(-8);
        for (const row of visible) {
            if (rows.findLast(e => e.action === row.action && e.target === row.target) !== row) continue;
            if (['already_friend', 'already_member'].includes(row.status)) continue;
            const current = await this.call('/v1/social/status', { action: row.action, target: row.target }).catch(() => null);
            if (['already_friend', 'already_member'].includes(current?.status)) {
                row.status = current.status; row.confirmedAt = Date.now();
            }
        }
        await this.save(rows);
        return visible;
    }); }
}

export function socialFor(bridge) {
    let service = services.get(bridge);
    if (!service) {
        const dir = bridge.deps.config.mediaDir;
        service = new SocialService(dir, async (path, body) => {
            if (bridge.deps.config.inject?.intercepting || bridge.stopping) throw new Error('social_dry_run');
            const token = (await readFile(join(dir, 'calls/control.token'), 'utf8')).trim();
            const response = await fetch('http://127.0.0.1:6110' + path, { method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
            const value = await response.json();
            if (!response.ok || value.code !== 0) throw new Error(String(value.message ?? 'social_request_failed').slice(0, 200));
            return value.data;
        });
        services.set(bridge, service);
    }
    return service;
}

export function makeSocialTool(defineTool, bridge) {
    return defineTool({ name: 'qq_social',
        description: '以你自己的QQ申请加好友或加入群聊。老大给出明确目标就执行；平常真想认识某个人/群、对方邀请或聊天自然产生交集也可以自己决定，不批量扫号，不因别人随口提到一个号就申请。action=add_friend/join_group，target是真实QQ号/群号，message是简短验证招呼，answer仅填写已知验证答案，read查当前会话的申请记录。submitted仅表示提交，不能说已经成为好友/入群；unknown不重试，先用qq_napcat_api查好友/群列表。',
        parameters: {
            action: { type: 'string', required: true, enum: ['add_friend', 'join_group', 'read'] },
            target: { type: 'string', description: '真实QQ号或群号，不能猜' },
            message: { type: 'string', description: '验证留言，最多120字' },
            answer: { type: 'string', description: '已知的好友验证问题答案，无则省略' },
            retry: { type: 'boolean', description: '仅老大明确要求重新申请、且上次明确rejected时使用；未知/待审不重投' },
        },
        output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const chatId = bridge.chatForSession?.(exec.agent?.session.id);
            const chat = bridge.chats?.get(chatId);
            if (!chat || !['admin', 'member'].includes(chat.activeTurnRole)) throw new Error('social_chat_turn_required');
            if (bridge.deps.config.inject?.intercepting || bridge.stopping) throw new Error('social_dry_run');
            const service = socialFor(bridge);
            return args?.action === 'read' ? service.recent(chatId) : service.request(args ?? {}, chatId, { allowRetry: chat.activeTurnRole === 'admin' });
        },
    });
}
