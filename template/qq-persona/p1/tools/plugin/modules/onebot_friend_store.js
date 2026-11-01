/**
 * [dsh-p1] Pending QQ friend requests that survive a DSH restart.
 *
 * The friend-request patch used to keep approvals in a module-level Map: a
 * restart (of which there are plenty during persona/plugin work) silently
 * forgot every request the admin had not settled yet. This store writes them
 * to <mediaDir>/friend-requests.json — one entry per requester, 24h TTL,
 * pruned on load and on read. The separate notifications map has no TTL:
 * an expired/settled approval must never become a new notification again.
 *
 * File shape:
 *   { "version": 1, "updatedAt": 1792..., "requests": {
 *       "12345678": { "flag": "…", "at": 1792…, "nickname": "示例昵称", "comment": "…" } } }
 *
 * Writes are atomic (tmp + rename) and serialized through one promise chain,
 * so two requests landing together cannot interleave a half-written file.
 * Read/parse/write failures degrade to a log line — never a throw: a broken
 * JSON must not take the QQ bridge down.
 *
 * Patched into the plugin by tools/patch_onebot_friend_store.py.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const FRIEND_REQUESTS_FILE = 'friend-requests.json';
export const DEFAULT_FRIEND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

function errText(error) {
    return error instanceof Error ? error.message : String(error);
}

export class FriendRequestStore {
    constructor(options = {}) {
        this.mediaDir = options.mediaDir ?? '';
        this.ttlMs = options.ttlMs ?? DEFAULT_FRIEND_REQUEST_TTL_MS;
        this.now = options.now ?? Date.now;
        this.log = options.log ?? (() => undefined);
        this.state = { version: 1, requests: {}, notifications: {}, notificationBaseline: 0 };
        this.loaded = false;
        this.loading = undefined;
        this.writing = Promise.resolve();
    }

    file() {
        return join(this.mediaDir, FRIEND_REQUESTS_FILE);
    }

    count() {
        return Object.keys(this.state.requests).length;
    }

    async ensureLoaded() {
        if (this.loaded)
            return;
        if (this.loading === undefined)
            this.loading = this.load();
        await this.loading;
    }

    async load() {
        let raw;
        try {
            raw = await readFile(this.file(), 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                this.log('warn', 'friend store: read failed: ' + errText(error));
            this.loaded = true;
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            const requests = parsed?.requests;
            if (requests === null || typeof requests !== 'object' || Array.isArray(requests))
                throw new Error('bad state shape');
            for (const [userId, entry] of Object.entries(requests)) {
                if (entry === null || typeof entry !== 'object')
                    continue;
                if (typeof entry.flag !== 'string' || entry.flag === '')
                    continue;
                this.state.requests[userId] = {
                    flag: entry.flag,
                    at: Number(entry.at) || 0,
                    nickname: typeof entry.nickname === 'string' ? entry.nickname : '',
                    comment: typeof entry.comment === 'string' ? entry.comment : '',
                    // The id of HER "有人想加我好友" message; a QQ reply to that
                    // message is how the admin says which request he means.
                    notifyId: typeof entry.notifyId === 'string' ? entry.notifyId : '',
                };
            }
            const notifications = parsed?.notifications;
            if (notifications && typeof notifications === 'object' && !Array.isArray(notifications)) {
                for (const [key, value] of Object.entries(notifications)) {
                    if (value && typeof value === 'object' && typeof value.status === 'string')
                        this.state.notifications[key] = { status: value.status, at: Number(value.at) || 0 };
                }
            }
            this.state.notificationBaseline = Number(parsed?.notificationBaseline) || 0;
            // Import receipts before pruning. Notification history has no TTL.
            for (const [userId, entry] of Object.entries(this.state.requests)) {
                if (entry.notifyId)
                    this.state.notifications[userId + '#' + entry.flag] ??= { status: 'notified', at: entry.at };
            }
            const dropped = this.prune();
            if (this.count() > 0)
                this.log('info', 'friend store: restored ' + this.count() + ' pending request(s) from disk');
            if (dropped)
                await this.persist();
        }
        catch (error) {
            this.log('warn', 'friend store: parse failed, starting empty: ' + errText(error));
            this.state.requests = {};
        }
        finally {
            this.loaded = true;
        }
    }

    /** Drop entries past the TTL; returns true when something was removed. */
    prune() {
        const now = this.now();
        let changed = false;
        for (const [userId, entry] of Object.entries(this.state.requests)) {
            if (now - entry.at > this.ttlMs) {
                delete this.state.requests[userId];
                changed = true;
            }
        }
        return changed;
    }

    async get(userId) {
        await this.ensureLoaded();
        const key = String(userId);
        const entry = this.state.requests[key];
        if (entry === undefined)
            return undefined;
        if (this.now() - entry.at > this.ttlMs) {
            delete this.state.requests[key];
            await this.persist();
            this.log('info', 'friend store: request from ' + key + ' expired');
            return undefined;
        }
        return entry;
    }

    async set(userId, entry) {
        await this.ensureLoaded();
        const key = String(userId);
        this.state.requests[key] = {
            flag: String(entry?.flag ?? ''),
            at: Number(entry?.at) || this.now(),
            nickname: String(entry?.nickname ?? ''),
            comment: String(entry?.comment ?? ''),
            notifyId: String(entry?.notifyId ?? ''),
        };
        return await this.persist();
    }

    async delete(userId) {
        await this.ensureLoaded();
        const key = String(userId);
        if (this.state.requests[key] === undefined)
            return;
        delete this.state.requests[key];
        await this.persist();
    }

    async list() {
        await this.ensureLoaded();
        if (this.prune())
            await this.persist();
        return Object.entries(this.state.requests).map(([userId, entry]) => ({ userId, ...entry }));
    }

    async notification(userId, flag) {
        await this.ensureLoaded();
        return this.state.notifications[String(userId) + '#' + String(flag)];
    }

    async rememberNotification(userId, flag, status) {
        await this.ensureLoaded();
        const key = String(userId) + '#' + String(flag);
        const previous = this.state.notifications[key];
        this.state.notifications[key] = { status, at: this.now() };
        if (await this.persist()) return true;
        if (previous) this.state.notifications[key] = previous;
        else delete this.state.notifications[key];
        return false;
    }

    async baselineNotifications(requests) {
        await this.ensureLoaded();
        if (this.state.notificationBaseline)
            return true;
        const previous = { ...this.state.notifications };
        for (const req of requests) {
            const uin = String(req?.uin ?? ''), flag = String(req?.reqTime ?? '');
            if (uin && flag)
                this.state.notifications[uin + '#' + flag] ??= { status: 'baseline', at: this.now() };
        }
        this.state.notificationBaseline = this.now();
        if (await this.persist())
            return true;
        this.state.notificationBaseline = 0;
        this.state.notifications = previous;
        return false;
    }

    async settle(userId, flag) {
        await this.ensureLoaded();
        const key = String(userId);
        this.state.notifications[key + '#' + String(flag)] = { status: 'settled', at: this.now() };
        if (this.state.requests[key]?.flag === String(flag))
            delete this.state.requests[key];
        return await this.persist();
    }

    async persist() {
        const run = async () => {
            if (this.mediaDir === '') {
                this.log('warn', 'friend store: mediaDir is empty, request not persisted');
                return false;
            }
            try {
                const file = this.file();
                await mkdir(dirname(file), { recursive: true });
                const snapshot = { ...this.state, version: 1, updatedAt: this.now(), requests: { ...this.state.requests }, notifications: { ...this.state.notifications } };
                const tmp = file + '.tmp';
                await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
                await rename(tmp, file);
                return true;
            }
            catch (error) {
                this.log('warn', 'friend store: write failed: ' + errText(error));
                return false;
            }
        };
        this.writing = this.writing.then(run, run);
        return await this.writing;
    }
}

export default FriendRequestStore;
