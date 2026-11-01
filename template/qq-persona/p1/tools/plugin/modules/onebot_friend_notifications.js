// The live event and snapshot scanner share durable history and one queue.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class FriendNotifications {
    constructor({ store, bridge, readDump, now = Date.now }) {
        this.store = store;
        this.bridge = bridge;
        this.now = now;
        this.readDump = readDump ?? (async () => JSON.parse(await readFile(join(bridge.deps.config.mediaDir, 'buddy-requests.json'), 'utf8')));
        this.queue = Promise.resolve();
    }

    serial(run) {
        const task = this.queue.then(run, run);
        this.queue = task.catch(() => undefined);
        return task;
    }

    admins() { return (this.bridge.deps.policy?.adminUsers ?? []).map(String); }
    log(level, message) { this.bridge.deps.log(level, 'friend notifications: ' + message); }

    async friends() {
        const result = await this.bridge.guardedConnectionCall('get_friend_list', {});
        const rows = Array.isArray(result) ? result : result?.data;
        if (!Array.isArray(rows)) throw new Error('invalid friend list');
        return new Set(rows.map(row => String(row?.user_id ?? '')));
    }

    async initialize() {
        await this.store.ensureLoaded();
        if (this.store.state.notificationBaseline) return true;
        let dump;
        try { dump = await this.readDump(); }
        catch (error) {
            // A broken file is not an empty history: don't enable replay later.
            if (error?.code !== 'ENOENT') throw error;
            dump = { requests: [] };
        }
        if (!Array.isArray(dump?.requests)) throw new Error('invalid buddy dump');
        // One-time migration: existing snapshot entries are history, not news.
        return await this.store.baselineNotifications(dump.requests);
    }

    event(event) {
        return this.serial(async () => {
            if (!this.admins().length || !await this.initialize()) return;
            const userId = String(event.user_id ?? ''), flag = String(event.flag ?? '');
            if (!/^\d+$/.test(userId) || !flag) return;
            // NapCat filters handled requests before emitting this event.
            if ((await this.friends()).has(userId)) {
                await this.store.settle(userId, flag);
                return;
            }
            await this.notify(userId, flag, String(event.nickname ?? ''), String(event.comment ?? '').trim());
        });
    }

    scan() {
        return this.serial(async () => {
            if (!this.admins().length || !await this.initialize()) return;
            const dump = await this.readDump();
            if (!Array.isArray(dump?.requests)) return;
            if (!Number.isFinite(Number(dump.at)) || Math.abs(this.now() - Number(dump.at)) > 120_000) return;
            const friends = await this.friends();
            for (const req of dump.requests) {
                const userId = String(req?.uin ?? ''), flag = String(req?.reqTime ?? '');
                if (!/^\d+$/.test(userId) || !/^\d+$/.test(flag)) continue;
                if (friends.has(userId) || req.isPending === false) {
                    if ((await this.store.notification(userId, flag))?.status !== 'settled')
                        await this.store.settle(userId, flag);
                    continue;
                }
                if (req.isInitiator) continue;
                // Legacy dumps cannot prove that read non-friend rows are pending.
                if (req.isPending !== true && req.isUnread !== true) continue;
                await this.notify(userId, flag, String(req.nick ?? ''), String(req.extWords ?? '').trim());
            }
        });
    }

    async notify(userId, flag, nickname, comment) {
        if (await this.store.notification(userId, flag)) return;
        // A historical row omitted from the migration snapshot is still old.
        if (/^\d+$/.test(flag) && Number(flag) < Math.floor(this.store.state.notificationBaseline / 1000)) {
            await this.store.rememberNotification(userId, flag, 'baseline');
            return;
        }
        const previous = await this.store.get(userId);
        if (previous && /^\d+$/.test(previous.flag) && /^\d+$/.test(flag) && BigInt(previous.flag) > BigInt(flag)) {
            await this.store.rememberNotification(userId, flag, 'superseded');
            return;
        }
        // Persist before sending. An unknown send result is never replayed.
        if (!await this.store.rememberNotification(userId, flag, 'reserved')) {
            this.log('warn', 'notification not sent: history could not be saved');
            return;
        }
        if (!nickname) {
            try {
                const info = await this.bridge.guardedConnectionCall('get_stranger_info', { user_id: Number(userId) });
                nickname = String(info?.nickname ?? info?.data?.nickname ?? '');
            } catch { /* nickname is optional */ }
        }
        const entry = { flag, at: this.now(), nickname, comment };
        if (!await this.store.set(userId, entry)) {
            this.log('warn', 'notification not sent: approval entry could not be saved');
            return;
        }
        const parts = ['老大，有人想加我好友，要同意吗？QQ ' + userId + (nickname ? '（' + nickname + '）' : '')];
        if (comment) parts.push('验证：' + comment);
        parts.push('回「同意 ' + userId + '」或「拒绝 ' + userId + '」；也可以直接引用这条消息回「同意/拒绝」');
        try {
            const ids = await this.bridge.sendToChat('private:' + this.admins()[0], parts.join('｜'));
            if (!Array.isArray(ids) || !ids.length) throw new Error('no delivery receipt');
            await this.store.set(userId, { ...entry, notifyId: String(ids[0]) });
            await this.store.rememberNotification(userId, flag, 'notified');
            this.log('info', 'new pending request forwarded');
        } catch (error) {
            this.log('warn', 'notification delivery uncertain; not replaying: ' + String(error?.message ?? error));
        }
    }
}

const instances = new WeakMap();
export function friendNotificationsFor(bridge, store) {
    let instance = instances.get(bridge);
    if (!instance) {
        instance = new FriendNotifications({ bridge, store });
        instances.set(bridge, instance);
    }
    return instance;
}
