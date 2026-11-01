/**
 * [dsh-p1] P0 断线补拉 (catch-up): replay the messages that arrived while the
 * bridge was offline.
 *
 * Why: the OneBot channel has no offline queue. Anything sent during a
 * disconnect — or during a DSH restart — never reaches the agent; the inbound
 * dedup window (300s) only covers WS re-delivery inside one process, not the
 * gap itself. The README's acceptance item is "断网 30 秒 / 顶号一次：不丢消息、
 * 不重复回复", and this module is the "不丢消息" half.
 *
 * On every (re)connect:
 *   1. wait for the chat mapping + a short settle delay;
 *   2. for each known chat, pull the newest page of history
 *      (get_friend_msg_history / get_group_msg_history; retried once, then a
 *      degraded bigger pull — NapCat's reader intermittently fails with
 *      "方法1查询失败，序号: …，消息数: 0");
 *   3. keep only messages that are inside the catch-up window, were not seen
 *      yet (per-chat message_id ring), and are not from the bot itself. For
 *      groups the replay is anchor-driven (v2.24): an anchor is a message that
 *      actually triggered her — an @/name-call, or the admin speaking (the
 *      live pipeline never drops admin messages, so neither does the replay).
 *      Non-anchor messages within contextWindowMs of an anchor ride along as
 *      [旁听] context, so she answers a quote with the surrounding conversation
 *      visible instead of a bare "@" with no text. With no anchor the group
 *      stays silent: a random "旁听" roll is never replayed — catch-up must
 *      not invent a turn the user never triggered;
 *   4. prepare group messages through the REAL inbound pipeline in original
 *      order, then dispatch the whole selected conversation once. Private
 *      history retains the individual delivery path;
 *   5. persist the per-chat watermark so a restart never replays twice.
 *
 * First run (no state file) primes the watermark from the current history and
 * replays nothing, so installing the patch never answers yesterday's backlog.
 *
 * Knobs are constants (see CATCHUP_DEFAULTS); the README documents them.
 * State file: <mediaDir>/catchup-state.json
 *   { version, chats: { chatId: { ids: [], lastId, lastTime, updatedAt } } }
 *
 * Patched into the plugin by tools/patch_onebot_catchup.py (idempotent).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const CATCHUP_STATE_FILE = 'catchup-state.json';

export const CATCHUP_DEFAULTS = {
    /** Replay at most this much backlog (older messages are considered stale). */
    windowMs: 24 * 60 * 60_000,
    /** History pages are pulled for at most this many chats (most active first). */
    maxChats: 8,
    /** Per chat, replay at most this many messages (the newest ones). Groups
     *  only use this as a private-style slice: anchors always ride and group
     *  context is capped separately (maxContextPerChat). */
    maxPerChat: 5,
    /** [dsh-p1] v2.24: group context window around an anchor — non-anchor
     *  messages within this distance of any anchor ride along as [旁听]
     *  context, so she sees what the anchor was actually about. */
    contextWindowMs: 3 * 60_000,
    /** [dsh-p1] v2.24: at most this many context messages per group chat
     *  (anchors always ride; nearest-to-anchor are kept first). */
    maxContextPerChat: 10,
    /** Per reconnect, replay at most this many messages in total. */
    maxTotal: 20,
    /** History page size. v2.23: 20 only reached the latest burst of a busy
     *  chat, so gaps older than ~20 messages were invisible to every pull
     *  (小k's 23:22 messages sat behind her 00:03-00:08 burst). One page of 60
     *  covers a full busy hour; maxPerChat/maxTotal still bound the replay. */
    fetchCount: 60,
    /** Retries (beyond the first attempt) before the degraded fallback pull. */
    historyRetries: 1,
    /** Backoff between history attempts (multiplied by the attempt index). */
    historyRetryMs: 1_500,
    /** Degraded fallback: one plain pull with a bigger page when retries fail. */
    historyFallbackCount: 100,
    /** Remembered message ids per chat (dedupe ring). */
    seenPerChat: 60,
    /** Ignore observed flapping shorter than this. */
    minOutageMs: 1_000,
    /** Give the transport/NapCat a moment after connect before asking history. */
    settleMs: 3_000,
    /** Space between replayed messages (ms). */
    replayGapMs: 1_500,
    /** Do not run twice within this window. */
    cooldownMs: 30_000,
    /** [dsh-p1] v2.08: empty-history retry. A WS reconnect right after a QQ
     *  crash fires catch-up BEFORE login completes — the history APIs then
     *  "succeed" with zero messages ("no missed" while 49 min of chat was
     *  actually missed). Retry until pages come back non-empty. */
    retryDelayMs: 60_000,
    maxEmptyRetries: 5,
    /** A non-empty page can still be stale immediately after reconnect.
     *  Recheck twice, after 15s then 30s, using the same gap watermark. */
    verificationDelayMs: 15_000,
    maxVerificationPasses: 2,
    /** Debounce for the state write. */
    persistDelayMs: 3_000,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function errText(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}

/** Chronological order; message_seq breaks same-second ties (history pages). */
function byChronology(a, b) {
    const at = Number(a?.time) || 0;
    const bt = Number(b?.time) || 0;
    if (at !== bt)
        return at - bt;
    return (Number(a?.message_seq) || 0) - (Number(b?.message_seq) || 0);
}

function splitChatId(chatId) {
    const idx = typeof chatId === 'string' ? chatId.indexOf(':') : -1;
    if (idx > 0) {
        const kind = chatId.slice(0, idx);
        const target = chatId.slice(idx + 1);
        if (kind === 'private' || kind === 'group')
            return { kind, target };
    }
    return { kind: 'private', target: String(chatId) };
}

/** True when the history message @-mentions the bot (or @all). */
function mentionsSelf(message, selfId) {
    if (selfId === undefined || selfId === null || String(selfId) === '')
        return false;
    const ids = new Set([String(selfId)]);
    const segments = message?.message;
    if (Array.isArray(segments)) {
        for (const segment of segments) {
            if (segment?.type !== 'at')
                continue;
            const qq = String(segment?.data?.qq ?? '');
            if (qq === 'all' || ids.has(qq))
                return true;
        }
    }
    const raw = typeof message?.raw_message === 'string' ? message.raw_message : '';
    for (const id of ids) {
        if (raw.includes('[CQ:at,qq=' + id + ']'))
            return true;
    }
    if (raw.includes('[CQ:at,qq=all]'))
        return true;
    // [dsh-p1] being called by name counts as relevant even without an @.
    const text = raw + (Array.isArray(segments) ? segments.map(segment => String(segment?.data?.text ?? '')).join('') : '');
    const NAMES = ['小鲸鲸', '鲸鱼娘', '小鲸鱼', '蓝鲸鱼', '蓝鲸', '鲸鱼', '鲸鲸', '小鲸', '小鱼', '臭鱼'];
    if (NAMES.some(name => text.includes(name)))
        return true;
    const TRAPS = ['摸鱼', '钓鱼', '鱼丸', '鱼香', '鱼片', '鱼塘', '咸鱼', '飞鱼', '鱼刺', '鱼头', '鱼尾', '鱼缸', '鱼干', '鱼鳞', '鱼饵', '鲸鱼', '鱿鱼', '金鱼', '木鱼', '酸菜鱼', '水煮鱼', '鱼豆腐'];
    return text.includes('鱼') && !TRAPS.some(word => text.includes(word)) && text.trim().length <= 8;
}

/** Rebuild a OneBot message event from one history entry. */
export function toEvent(chatId, message) {
    const { kind, target } = splitChatId(chatId);
    const sender = message?.sender ?? {};
    const event = {
        post_type: 'message',
        // Source metadata, not an obligation to answer or quote each row.
        catchup: true,
        message_type: kind,
        time: message?.time,
        self_id: message?.self_id,
        message_id: message?.message_id,
        message_seq: message?.message_seq,
        raw_message: typeof message?.raw_message === 'string' ? message.raw_message : '',
        message: message?.message,
        sender,
        user_id: kind === 'private'
            ? Number(target)
            : message?.user_id ?? sender?.user_id,
    };
    if (kind === 'group')
        event.group_id = Number(target);
    return event;
}

export class CatchUp {
    constructor(deps, options = {}) {
        this.deps = deps;
        this.opt = { ...CATCHUP_DEFAULTS, ...options };
        this.state = { version: 1, chats: {} };
        this.loaded = false;
        this.primerNeeded = false;
        this.downAt = undefined;
        this.lastRunAt = 0;
        this.running = false;
        this.stopped = false;
        this.emptyRetries = 0;
        this.verificationPasses = 0;
        this.reconnectWatermarks = undefined;
        this.dirty = false;
        this.saveTimer = undefined;
    }

    file() {
        return join(this.deps.mediaDir(), CATCHUP_STATE_FILE);
    }

    isOffline() {
        return typeof this.deps.connected === 'function' ? !this.deps.connected() : false;
    }

    log(level, message) {
        this.deps.log(level, message);
    }

    // ------------------------------------------------------------ state

    chatState(chatId) {
        let st = this.state.chats[chatId];
        if (st === undefined || st === null) {
            st = { ids: [], lastTime: 0 };
            this.state.chats[chatId] = st;
        }
        if (!Array.isArray(st.ids))
            st.ids = [];
        st.deferred ??= {};
        for (const [id, at] of Object.entries(st.deferred)) {
            if (!Number.isFinite(at) || at < Date.now() - this.opt.windowMs)
                delete st.deferred[id];
        }
        return st;
    }

    /** Rejected deliveries remain eligible even as later messages advance the watermark. */
    noteDeferred(inbound) {
        if (this.stopped || !inbound?.chatId || !inbound?.messageId)
            return;
        const st = this.chatState(inbound.chatId);
        const id = String(inbound.messageId);
        if (!st.ids.includes(id))
            st.deferred[id] = Date.now();
        const ids = Object.keys(st.deferred);
        for (const old of ids.slice(0, Math.max(0, ids.length - this.opt.seenPerChat)))
            delete st.deferred[old];
        this.schedulePersist();
    }

    remember(st, message) {
        const id = message?.message_id === undefined || message?.message_id === null
            ? ''
            : String(message.message_id);
        if (id !== '') {
            if (st.deferred) delete st.deferred[id];
            if (!st.ids.includes(id))
                st.ids.push(id);
            if (st.ids.length > this.opt.seenPerChat)
                st.ids.splice(0, st.ids.length - this.opt.seenPerChat);
            st.lastId = id;
        }
        const seconds = Number(message?.time);
        if (Number.isFinite(seconds))
            st.lastTime = Math.max(st.lastTime ?? 0, seconds * 1000);
        st.updatedAt = Date.now();
    }

    /** Called by the bridge for every inbound message that reached dispatch. */
    noteSeen(inbound) {
        if (this.stopped || inbound === undefined || inbound === null)
            return;
        if (!inbound.chatId || !inbound.messageId)
            return;
        this.emptyRetries = 0; // live traffic means login completed
        const st = this.chatState(inbound.chatId);
        const id = String(inbound.messageId);
        delete st.deferred[id];
        if (!st.ids.includes(id))
            st.ids.push(id);
        if (st.ids.length > this.opt.seenPerChat)
            st.ids.splice(0, st.ids.length - this.opt.seenPerChat);
        st.lastId = id;
        st.lastTime = Math.max(st.lastTime ?? 0, Date.now());
        st.updatedAt = Date.now();
        this.schedulePersist();
    }

    /** True when this message was already delivered for the chat. Read-only
     *  lookup used by the bridge's sleep-backlog replay (v2.27): events queued
     *  while asleep are also replayed by a reconnect catch-up, and without
     *  this check she would answer the same message twice. Unlike noteSeen it
     *  must not create state or touch the watermark. */
    hasSeen(chatId, messageId) {
        const id = String(messageId ?? '');
        if (!chatId || id === '')
            return false;
        const st = this.state?.chats?.[String(chatId)];
        return Array.isArray(st?.ids) && st.ids.includes(id);
    }

    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        let raw;
        try {
            raw = await readFile(this.file(), 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                this.log('warn', 'catchup: state read failed: ' + errText(error));
            this.primerNeeded = true;
            return;
        }
        try {
            // 有些编辑器/脚本写文件会带 UTF-8 BOM，JSON.parse 会直接抛
            // "Unexpected token"——那会让水位线被当成首次运行重新 prime，丢一轮补拉。
            const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
            const chats = parsed?.chats;
            if (chats === null || typeof chats !== 'object' || Array.isArray(chats))
                throw new Error('bad state shape');
            for (const [chatId, incoming] of Object.entries(chats)) {
                const cur = this.state.chats[chatId];
                if (cur === undefined) {
                    this.state.chats[chatId] = {
                        ids: Array.isArray(incoming?.ids) ? incoming.ids.map(String) : [],
                        lastId: incoming?.lastId !== undefined ? String(incoming.lastId) : undefined,
                        lastTime: Number(incoming?.lastTime) || 0,
                        updatedAt: incoming?.updatedAt,
                        deferred: incoming?.deferred && typeof incoming.deferred === 'object' && !Array.isArray(incoming.deferred) ? incoming.deferred : {},
                    };
                    continue;
                }
                // A message may have landed while the file was being read.
                for (const id of incoming?.ids ?? []) {
                    const value = String(id);
                    if (!cur.ids.includes(value))
                        cur.ids.push(value);
                }
                cur.ids = cur.ids.slice(-this.opt.seenPerChat);
                cur.deferred = { ...(incoming?.deferred ?? {}), ...(cur.deferred ?? {}) };
                for (const id of cur.ids) delete cur.deferred[id];
                cur.lastTime = Math.max(cur.lastTime ?? 0, Number(incoming?.lastTime) || 0);
                if (incoming?.lastId !== undefined)
                    cur.lastId = String(incoming.lastId);
            }
            this.primerNeeded = false;
        }
        catch (error) {
            this.log('warn', 'catchup: state parse failed, priming instead: ' + errText(error));
            this.primerNeeded = true;
        }
    }

    schedulePersist() {
        this.dirty = true;
        if (this.saveTimer !== undefined)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.persist();
        }, this.opt.persistDelayMs);
        this.saveTimer.unref?.();
    }

    async persist() {
        if (!this.dirty)
            return;
        try {
            const file = this.file();
            await mkdir(dirname(file), { recursive: true });
            const tmp = file + '.tmp';
            await writeFile(tmp, JSON.stringify(this.state), 'utf8');
            await rename(tmp, file);
            this.dirty = false;
        }
        catch (error) {
            this.log('warn', 'catchup: state write failed: ' + errText(error));
        }
    }

    async flush() {
        if (this.saveTimer !== undefined) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        await this.persist();
    }

    async stop() {
        this.stopped = true;
        if (this.retryTimer !== undefined) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        await this.flush();
    }

    // ------------------------------------------------------------ workflow

    onDisconnected() {
        this.downAt = Date.now();
    }

    async pickChats() {
        // v2.21: the provider may be async — the bridge enumerates the whole
        // friend list (registry-only misses friends whose first messages were
        // dropped before any session existed, so their backlog never replayed).
        const list = typeof this.deps.listChats === 'function' ? await this.deps.listChats() : [];
        return Array.isArray(list) ? list.slice(0, this.opt.maxChats) : [];
    }

    async onConnected() {
        return this.runCatchUp(false);
    }

    scheduleRetry(delayMs) {
        if (this.stopped || this.isOffline())
            return;
        if (this.retryTimer !== undefined)
            clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            // Follow-ups belong to the existing reconnect cycle. The external
            // reconnect cooldown must not swallow their bounded retry.
            void this.runCatchUp(true).catch(error =>
                this.log('warn', 'catchup: delayed check failed: ' + errText(error)));
        }, delayMs);
        this.retryTimer.unref?.();
    }

    async runCatchUp(followup) {
        if (this.stopped)
            return;
        if (this.running) {
            if (!followup) this.pendingReconnect = true;
            return;
        }
        const now = Date.now();
        const outage = this.downAt === undefined ? undefined : now - this.downAt;
        this.downAt = undefined;
        // An observed flap shorter than minOutageMs is the transport's own
        // reconnect: no gap worth replaying.
        if (outage !== undefined && outage < this.opt.minOutageMs)
            return;
        if (!followup && this.lastRunAt !== 0 && now - this.lastRunAt < this.opt.cooldownMs) {
            // A real outage inside the cooldown still needs a check. Lifecycle
            // duplicates can reuse the already scheduled verification.
            if (outage !== undefined)
                this.scheduleRetry(this.opt.cooldownMs - (now - this.lastRunAt));
            return;
        }
        if (!followup) {
            if (this.retryTimer !== undefined) {
                clearTimeout(this.retryTimer);
                this.retryTimer = undefined;
            }
            this.reconnectWatermarks = undefined;
            this.verificationPasses = 0;
        }
        this.running = true;
        this.lastRunAt = now;
        this.sawEmptyPages = false;
        try {
            await this.load();
            // New live messages can advance lastTime while NapCat's history
            // catches up. Keep this cycle's original lower bound across every
            // delayed check, while still consulting the current seen-id ring.
            this.reconnectWatermarks ??= new Map(Object.entries(this.state.chats)
                .map(([chatId, st]) => [chatId, Number(st.lastTime) || 0]));
            if (typeof this.deps.ready === 'function')
                await this.deps.ready();
            if (this.opt.settleMs > 0)
                await sleep(this.opt.settleMs);
            if (this.stopped || this.isOffline())
                return;
            const chats = await this.pickChats();
            const priming = this.primerNeeded;
            let replayed = 0;
            let touched = 0;
            for (const chatId of chats) {
                if (this.stopped || this.isOffline() || replayed >= this.opt.maxTotal)
                    break;
                let count = 0;
                try {
                    if (!this.reconnectWatermarks.has(chatId))
                        this.reconnectWatermarks.set(chatId, Number(this.state.chats[chatId]?.lastTime) || 0);
                    count = await this.catchUpChat(chatId, priming, this.opt.maxTotal - replayed,
                        this.reconnectWatermarks.get(chatId));
                }
                catch (error) {
                    this.log('warn', 'catchup: ' + chatId + ' failed: ' + errText(error));
                }
                if (count > 0) {
                    touched += 1;
                    replayed += count;
                }
            }
            this.primerNeeded = false;
            await this.flush();
            if (priming)
                this.log('info', 'catchup: first run, watermark primed for ' + chats.length + ' chat(s) (nothing replayed)');
            else if (replayed > 0) {
                this.emptyRetries = 0;
                this.log('info', 'catchup: replayed ' + replayed + ' missed message(s) in ' + touched + ' chat(s)'
                    + (outage !== undefined ? ' after a ' + Math.round(outage / 1000) + 's outage' : ' after restart'));
            }
            else if (this.sawEmptyPages && chats.length > 0 && this.emptyRetries < this.opt.maxEmptyRetries) {
                // every history page came back EMPTY: most likely login has not
                // finished yet (crash -> QR wait -> WS already up). Try again
                // until pages are non-empty — that's when the missed messages
                // actually become fetchable.
                this.emptyRetries += 1;
                this.log('info', 'catchup: history empty (login pending?) — retry ' + this.emptyRetries + '/' + this.opt.maxEmptyRetries
                    + ' in ' + Math.round(this.opt.retryDelayMs / 1000) + 's');
                this.scheduleRetry(this.opt.retryDelayMs);
            }
            else {
                this.emptyRetries = 0;
                this.log('info', 'catchup: no missed messages');
            }
            if (!priming && chats.length > 0 && this.retryTimer === undefined
                && this.verificationPasses < this.opt.maxVerificationPasses) {
                this.verificationPasses += 1;
                const delayMs = this.opt.verificationDelayMs * this.verificationPasses;
                this.log('info', 'catchup: reconnect verification ' + this.verificationPasses
                    + '/' + this.opt.maxVerificationPasses + ' in ' + Math.round(delayMs / 1000) + 's');
                this.scheduleRetry(delayMs);
            }
        }
        finally {
            this.running = false;
            if (this.pendingReconnect) {
                this.pendingReconnect = false;
                this.scheduleRetry(Math.max(0, this.opt.cooldownMs - (Date.now() - this.lastRunAt)));
            }
        }
    }

    /**
     * One history page, with retries and a degraded fallback.
     *
     * Why: NapCat's internal DB reader intermittently fails with
     * `方法1查询失败，序号: …，消息数: 0`, which used to abort the whole
     * catch-up for that chat (README §5: "补消息可能补到 0 条"). A short
     * retry usually clears it; the last attempt degrades to one plain
     * bigger pull (count=historyFallbackCount), which goes through a
     * different code path on the NapCat side.
     */
    async fetchHistory(chatId, isGroup, params) {
        const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history';
        const attempts = [];
        for (let i = 0; i <= this.opt.historyRetries; i += 1)
            attempts.push({ params, waitMs: i === 0 ? 0 : this.opt.historyRetryMs * i });
        attempts.push({ params: { ...params, count: this.opt.historyFallbackCount }, waitMs: this.opt.historyRetryMs });
        let lastError;
        for (const attempt of attempts) {
            if (attempt.waitMs > 0)
                await sleep(attempt.waitMs);
            try {
                const data = await this.deps.call(action, attempt.params);
                return Array.isArray(data?.messages) ? data.messages : [];
            }
            catch (error) {
                lastError = error;
                this.log('warn', 'catchup: history attempt failed for ' + chatId + ' (' + errText(error) + ')');
            }
        }
        throw lastError ?? new Error('history unavailable');
    }

    async catchUpChat(chatId, priming, budget, gapWatermark) {
        // 同一个聊天同时只跑一份：onConnected 和 recoverSleepGap 都是 fire-and-forget，
        // 并发时两边都先把 seen 快照走，会把同一条积压消息派发两次（她连答两遍）。
        const inflight = (this.inflight ??= new Set());
        if (inflight.has(chatId))
            return 0;
        inflight.add(chatId);
        try {
            return await this.catchUpChatInner(chatId, priming, budget, gapWatermark);
        }
        finally {
            inflight.delete(chatId);
        }
    }

    async catchUpChatInner(chatId, priming, budget, gapWatermark) {
        const { kind, target } = splitChatId(chatId);
        const isGroup = kind === 'group';
        const params = isGroup
            ? { group_id: Number(target), count: this.opt.fetchCount }
            : { user_id: Number(target), count: this.opt.fetchCount };
        params.reverse_order = true;
        params.reverseOrder = true;
        params.disable_get_url = false;
        params.parse_mult_msg = true;
        params.quick_reply = false;
        let messages;
        try {
            messages = await this.fetchHistory(chatId, isGroup, params);
        }
        catch (error) {
            this.log('warn', 'catchup: history unavailable for ' + chatId + ': ' + errText(error));
            // 拉历史失败 == 不知道有没有漏，不能当成「没有漏」，否则这一轮补拉就永久丢了。
            this.sawEmptyPages = true;
            return 0;
        }
        if (messages.length === 0) {
            this.sawEmptyPages = true;
            return 0;
        }
        // NapCat honours reverse_order, but sorting locally keeps us correct on
        // adapters that ignore it (and on equal-second timestamps).
        const ordered = messages.slice().sort(byChronology);
        const st = this.chatState(chatId);
        if (priming) {
            for (const message of ordered.slice(-this.opt.seenPerChat))
                this.remember(st, message);
            this.schedulePersist();
            return 0;
        }
        const seen = new Set(st.ids);
        const selfId = typeof this.deps.selfId === 'function' ? this.deps.selfId() : '';
        const cutoff = Date.now() - this.opt.windowMs;
        // Backstop for messages older than the id ring: anything before the
        // last processed message is not a gap, it is backlog. 2 minutes of slack
        // covers the restart window (send → stop → start → settle) instead of the
        // 10s that used to drop messages sent while the bridge was restarting.
        const watermark = gapWatermark ?? (Number(st.lastTime) || 0);
        const fresh = ordered.filter(message => {
            const id = message?.message_id === undefined || message?.message_id === null
                ? ''
                : String(message.message_id);
            if (id === '' || seen.has(id))
                return false;
            const at = (Number(message?.time) || 0) * 1000;
            if (at < cutoff)
                return false;
            if (watermark > 0 && at < watermark - 120_000 && st.deferred[id] === undefined)
                return false;
            const senderId = String(message?.sender?.user_id ?? message?.user_id ?? '');
            if (selfId !== undefined && selfId !== null && String(selfId) !== '' && senderId === String(selfId))
                return false;
            return true;
        });
        const take = isGroup
            ? this.selectGroupReplay(fresh, selfId, budget)
            : fresh.slice(-Math.max(0, Math.min(this.opt.maxPerChat, budget)));
        if (isGroup && typeof this.deps.handleGroupBatch === 'function' && take.length) {
            try {
                const result = await this.deps.handleGroupBatch(take.map(message => toEvent(chatId, message)));
                const handled = new Set(result?.handledIds ?? []);
                for (const message of take) {
                    if (handled.has(String(message.message_id))) this.remember(st, message);
                    else this.noteDeferred({ chatId, messageId: String(message.message_id) });
                }
                this.schedulePersist();
                return take.filter(message => handled.has(String(message.message_id))).length;
            }
            catch (error) {
                for (const message of take)
                    this.noteDeferred({ chatId, messageId: String(message.message_id) });
                this.log('warn', 'catchup: group batch failed in ' + chatId + ': ' + errText(error));
                return 0;
            }
        }
        let replayed = 0;
        for (const message of take) {
            if (this.stopped || this.isOffline())
                break;
            const inbound = { chatId, messageId: String(message.message_id) };
            try {
                const handled = await this.deps.handleEvent(toEvent(chatId, message));
                if (handled === false) {
                    this.noteDeferred(inbound);
                    continue;
                }
                this.remember(st, message);
                this.schedulePersist();
            }
            catch (error) {
                this.noteDeferred(inbound);
                this.log('warn', 'catchup: replay failed in ' + chatId + ': ' + errText(error));
                continue;
            }
            replayed += 1;
            if (replayed < take.length && this.opt.replayGapMs > 0)
                await sleep(this.opt.replayGapMs);
        }
        return replayed;
    }

    /**
     * [dsh-p1] v2.24: group replay selection — anchors plus context.
     *
     * An anchor is a message that actually triggered her: an @/name-call, or
     * the admin speaking (the live pipeline never drops admin messages, so
     * the replay must not either). No anchors -> no turn was ever triggered
     * -> stay silent: a random 旁听 roll is never replayed, catch-up must not
     * invent a turn the user never triggered.
     *
     * Non-anchor messages inside contextWindowMs of any anchor ride along as
     * [旁听] context — nearest-to-anchor are kept first, capped at
     * maxContextPerChat — so she answers the anchor with the surrounding
     * conversation actually visible instead of a bare "@" with no text.
     * Selection prioritizes anchors, but delivery restores original chronology:
     * later corrections/context must be visible before any answer is generated.
     */
    selectGroupReplay(fresh, selfId, budget) {
        const admins = typeof this.deps.isAdmin === 'function' ? this.deps.isAdmin : () => false;
        const anchors = fresh.filter(message => mentionsSelf(message, selfId)
            || admins(String(message?.sender?.user_id ?? message?.user_id ?? '')));
        if (anchors.length === 0)
            return [];
        const anchorTake = anchors.slice(-Math.max(0, budget));
        const anchorIds = new Set(anchors.map(message => String(message?.message_id ?? '')));
        const anchorTimes = anchorTake.map(message => (Number(message?.time) || 0) * 1000);
        const context = fresh
            .filter(message => {
                if (anchorIds.has(String(message?.message_id ?? '')))
                    return false;
                const at = (Number(message?.time) || 0) * 1000;
                return anchorTimes.some(anchorAt => Math.abs(at - anchorAt) <= this.opt.contextWindowMs);
            })
            .map(message => ({
                message,
                dist: Math.min(...anchorTimes.map(anchorAt => Math.abs((Number(message?.time) || 0) * 1000 - anchorAt))),
            }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, Math.max(0, this.opt.maxContextPerChat))
            .map(entry => entry.message)
            .sort(byChronology);
        // Newest context wins when the budget runs out: the follow-ups right
        // after the anchor are the ones aimed at her.
        const room = Math.max(0, budget - anchorTake.length);
        const contextTake = room === 0 ? [] : context.slice(-room);
        return [...anchorTake, ...contextTake].sort(byChronology);
    }
}

export default CatchUp;
