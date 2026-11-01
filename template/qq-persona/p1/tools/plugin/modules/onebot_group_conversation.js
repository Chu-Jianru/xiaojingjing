// Internal symbol: QQ message fields cannot forge a batch collector.
export const GROUP_BATCH = Symbol.for('dsh.groupConversation');

// This used to be repeated in every user turn (and then in all later history).
// Keep the identical rule once in the stable channel system prompt.
export const GROUP_CONVERSATION_GUIDANCE = '以下消息按原顺序一起理解，不是一条一条待答的清单。先看后续补充、纠正、是否已被回答、话题是否仍在继续，再决定要不要加入、接哪一点；不主动总结或逐条点评。本轮直接找你的消息要分别结合附近原文判断，不因最后一条在和别人说话就忽略前面未回应的@；@加表情也是在找你互动，按语境自然接，明确不用回、已经回应或确已过时可以不接。附近原文只是语境，不是新增待办；引用对象不明不冒充@我。紧接同一件事且对象清楚就直接说，仅在需要定位对象或较早内容时引用；[补回]本身不要求回复或引用。';

export function explicitGroupAddress(inbound, selfId, botQQ) {
    const ids = new Set([selfId, botQQ].filter(x => x !== undefined && x !== null && String(x) !== '').map(String));
    if (Array.isArray(inbound.segments)) return inbound.segments.some(s =>
        (s.type === 'at' && (String(s.data?.qq) === 'all' || ids.has(String(s.data?.qq))))
        || (s.type === 'reply' && ids.has(String(s.data?.qq))));
    return [...String(inbound.raw ?? '').matchAll(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/g)]
        .some(m => m[1] === 'all' || ids.has(m[1]));
}

function contextText(event) {
    if (!Array.isArray(event.message)) return String(event.raw_message ?? '').replace(/\[CQ:(image|record|video|file),[^\]]*\]/g, '[$1]');
    return event.message.map(s => s.type === 'text' ? String(s.data?.text ?? '')
        : s.type === 'at' ? '@' + String(s.data?.qq ?? '')
        : s.type === 'reply' ? '[引用:' + String(s.data?.id ?? '') + ']'
        : s.type === 'face' ? '[QQ表情:' + String(s.data?.id ?? '') + ']' : '[' + s.type + ']').join('');
}

export function groupPartsText(parts) {
    const seen = new Set();
    return parts.map(part => {
        const boundary = part.final.indexOf('<user_message ');
        if (boundary < 0) return part.final;
        // Only framework metadata, never the user body, quotes or media text.
        const prefix = part.final.slice(0, boundary).replace(
            /^\[(共同记忆|记忆|梗)\]\n[\s\S]*?^\[\/\1\]\n?|^\[作息\][^\n]*\n?/gm,
            block => {
                if (seen.has(block)) return '';
                seen.add(block);
                return block;
            });
        return prefix + part.final.slice(boundary);
    }).join('\n');
}

function ordered(events) {
    return events.slice().sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0)
        || (Number(a.message_seq) || 0) - (Number(b.message_seq) || 0));
}

export class GroupConversation {
    constructor({ bridge, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
        Object.assign(this, { bridge, now, schedule, cancel });
        this.pending = new Map();
        this.queues = new Map();
        this.recent = new Map();
        this.stopped = false;
    }

    async receive(event, { injected = false, selfId = '' } = {}) {
        if (!this.stopped && !injected && event?.post_type === 'message' && event.message_type === 'group'
            && !event.catchup && !event[GROUP_BATCH]) this.remember(event);
        if (this.stopped || injected || event?.post_type !== 'message' || event.message_type !== 'group'
            || event.catchup || event[GROUP_BATCH] || String(event.user_id) === String(selfId)
            || !event.message_id || !event.group_id) return false;
        const chatId = 'group:' + String(event.group_id);
        const text = (Array.isArray(event.message)
            ? event.message.filter(p => p.type === 'text').map(p => String(p.data?.text ?? '')).join('')
            : String(event.raw_message ?? '').replace(/^\s*(?:\[CQ:at,[^\]]+\]\s*)+/, '')).trim();
        if (/^\/[A-Za-z][A-Za-z0-9_-]*\b/.test(text)) {
            await this.flush(chatId);
            return false;
        }
        let batch = this.pending.get(chatId);
        if (!batch) {
            batch = { events: [], firstAt: this.now(), timer: null };
            this.pending.set(chatId, batch);
        }
        batch.events.push(event);
        this.bridge.catchup?.noteDeferred?.({ chatId, messageId: String(event.message_id) });
        if (batch.events.length >= 20) await this.flush(chatId);
        else this.arm(chatId, batch);
        return true;
    }

    arm(chatId, batch) {
        this.cancel(batch.timer);
        const busy = this.bridge.chats?.get(chatId)?.agent?.status === 'running';
        const cap = batch.firstAt + (busy ? 10_000 : 4_000);
        // Check completion promptly instead of adding up to two seconds of
        // silence after her previous turn. Keep the hard caps and burst merge.
        const delay = Math.max(0, Math.min(busy ? 250 : 800, cap - this.now()));
        batch.timer = this.schedule(() => {
            // While she is speaking, collect the follow-ups into the next thought.
            if (this.bridge.chats?.get(chatId)?.agent?.status === 'running' && this.now() < cap) {
                this.arm(chatId, batch);
                return;
            }
            void this.flush(chatId).catch(error => this.bridge.deps.log('warn', 'group conversation: ' + String(error)));
        }, delay);
        batch.timer?.unref?.();
    }

    async flush(chatId) {
        const batch = this.pending.get(chatId);
        if (!batch) return;
        this.pending.delete(chatId);
        this.cancel(batch.timer);
        const result = await this.deliver(batch.events);
        for (const id of result.handledIds)
            this.bridge.catchup?.noteSeen?.({ chatId, messageId: id });
        for (const id of result.deferredIds)
            this.bridge.catchup?.noteDeferred?.({ chatId, messageId: id });
        return result;
    }

    deliver(events) {
        if (!events.length) return Promise.resolve({ handledIds: [], deferredIds: [] });
        const chatId = 'group:' + String(events[0].group_id);
        const previous = this.queues.get(chatId) ?? Promise.resolve();
        const task = previous.catch(() => undefined).then(() => this.prepare(chatId, events));
        this.queues.set(chatId, task);
        const clear = () => { if (this.queues.get(chatId) === task) this.queues.delete(chatId); };
        task.then(clear, clear);
        return task;
    }

    async prepare(chatId, events) {
        const collector = { parts: [] }, handled = new Set(), deferred = new Set();
        if (this.stopped || this.bridge.stopping) return { handledIds: [], deferredIds: events.map(e => String(e.message_id)) };
        for (const event of ordered(events)) {
            const id = String(event.message_id ?? '');
            if ('group:' + String(event.group_id) !== chatId || !id) continue;
            this.remember(event);
            if (this.bridge.catchup?.hasSeen?.(chatId, id)) { handled.add(id); continue; }
            const result = await this.bridge.handleInboundOnce({ ...event, [GROUP_BATCH]: collector, dshFragmentReleased: true }, false);
            if (result === false) deferred.add(id);
            else handled.add(id);
        }
        if (collector.parts.length) {
            const parts = collector.parts;
            const nearby = this.nearby(chatId, events, parts);
            const admins = new Set([...(this.bridge.deps.config.adminUsers ?? []), ...(this.bridge.deps.policy.adminUsers ?? [])].map(String));
            const role = parts.every(p => p.role === 'admin') && nearby.users.every(id => admins.has(id)) ? 'admin' : 'member';
            const last = parts.at(-1);
            const actorId = parts.every(p => p.userId === last.userId) ? last.userId : '';
            const addressed = parts.filter(p => p.addressed).map(p => p.messageId);
            const focus = addressed.length ? '[本轮直接找你的消息ID:' + addressed.join('、') + ']\n' : '';
            const text = '[群聊片段]\n' + focus + nearby.text + groupPartsText(parts);
            try {
                if (this.stopped || this.bridge.stopping) throw new Error('bridge stopping');
                if (!await this.bridge.interceptBusyTurn(chatId, text, role, last.nickname, false, undefined, actorId))
                    await this.bridge.dispatchFollowup(chatId, text, role, last.nickname, undefined, actorId);
            } catch (error) {
                for (const part of parts) {
                    handled.delete(part.messageId);
                    deferred.add(part.messageId);
                    // Preparing a message reserves inbound dedup. Dispatch failure
                    // must release it so catch-up can retry the original IDs.
                    this.bridge.inbound?.seenMessages?.delete(chatId + '#' + part.messageId);
                }
                this.bridge.deps.log('warn', 'group conversation dispatch failed: ' + String(error));
            }
        }
        return { handledIds: [...handled], deferredIds: [...deferred] };
    }

    stop() {
        this.stopped = true;
        for (const batch of this.pending.values()) this.cancel(batch.timer);
        this.pending.clear();
        this.recent.clear();
    }

    remember(event) {
        if (!event.group_id || !event.message_id) return;
        const key = 'group:' + String(event.group_id);
        const rows = (this.recent.get(key) ?? []).filter(r => this.now() - r.received < 180000 && String(r.event.message_id) !== String(event.message_id));
        rows.push({ event, received: this.now() });
        this.recent.delete(key); this.recent.set(key, rows.slice(-32));
        if (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value);
    }

    nearby(chatId, events, parts) {
        const addressed = new Set(parts.filter(p => p.addressed).map(p => p.messageId));
        if (!addressed.size) return { text: '', users: [] };
        const times = events.filter(e => addressed.has(String(e.message_id))).map(e => (Number(e.time) || 0) * 1000);
        const included = new Set(parts.map(p => p.messageId));
        const rows = (this.recent.get(chatId) ?? []).filter(r => !included.has(String(r.event.message_id))
            && times.some(at => Math.abs(at - (Number(r.event.time) || 0) * 1000) <= 180000))
            .sort((a,b) => Math.min(...times.map(t => Math.abs(t-Number(a.event.time)*1000)))
                - Math.min(...times.map(t => Math.abs(t-Number(b.event.time)*1000)))).slice(0,8);
        let budget = 3500; const selected = [], users = [];
        for (const event of ordered(rows.map(r => r.event))) {
            const row = JSON.stringify({ time: event.time, id: String(event.message_id), qq: String(event.user_id), text: contextText(event) });
            if (row.length <= budget) { selected.push(row); users.push(String(event.user_id)); budget -= row.length; }
        }
        return { text: selected.length ? '[附近原文摘录，仅作语境，不要求逐条回应]\n' + selected.join('\n') + '\n[/附近原文摘录]\n' : '', users };
    }
}

const instances = new WeakMap();
export function groupConversationFor(bridge) {
    let controller = instances.get(bridge);
    if (!controller) {
        controller = new GroupConversation({ bridge });
        instances.set(bridge, controller);
    }
    return controller;
}
