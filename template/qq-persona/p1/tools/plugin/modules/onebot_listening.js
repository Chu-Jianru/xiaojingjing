/** Private conversation listening. Status notices are hints, never user text. */
const controllers = new WeakMap();
const TYPING_TTL = 8_000;
const HOLD_CAP = 25_000;

function messageText(event) {
    return typeof event.raw_message === 'string' ? event.raw_message
        : (event.message ?? []).filter(p => p.type === 'text').map(p => String(p.data?.text ?? '')).join('');
}

export function isBackchannel(text) {
    return /^(?:哈{2,}|呵{2,}|嘿{2,}|嘻{2,}|嗯+[嗯呢]?|好(?:的|呀|哒)?|行|收到|233+|(?:ha){2,})[！!~～。.\s]*$/iu.test(String(text ?? '').trim());
}

export function typingNotice(event, selfId = '') {
    if (event?.post_type !== 'notice' || event.notice_type !== 'notify' || event.sub_type !== 'input_status') return null;
    const user = String(event.user_id ?? '');
    if (!/^\d+$/.test(user) || user === '0' || user === String(selfId) || Number(event.group_id || 0) !== 0) return null;
    const text = String(event.status_text ?? '').trim();
    // NTQQ's numeric event_type is passed through, not a universal boolean.
    // Prefer known display meanings; unknown codes/text never invent typing.
    let active = null;
    if (/停止|取消|结束|不在输入|未在输入|idle|stopped/i.test(text)) active = false;
    else if (/正在输入|正在说话|正在录音|typing|recording/i.test(text)) active = true;
    else if (typeof event.typing === 'boolean') active = event.typing;
    return { chatId: 'private:' + user, active, at: Number(event.time) * 1000 || 0 };
}

export class PrivateListening {
    constructor({ deliver, held = () => {}, log = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
        Object.assign(this, { deliver, held, log, now, schedule, cancel, sleep });
        this.chats = new Map();
        this.stopped = false;
    }

    state(chatId) {
        let s = this.chats.get(chatId);
        if (!s) {
            s = { revision: 0, active: null, versions: [], running: false, typingUntil: 0, lastMessageAt: 0,
                batch: [], timer: null, firstHeldAt: 0, guards: new Set(), seen: new Set(), interrupted: false };
            this.chats.set(chatId, s);
        }
        return s;
    }

    typing(event, selfId) {
        const notice = typingNotice(event, selfId);
        if (!notice) return false;
        const now = this.now();
        if (notice.at && (notice.at < now - 20_000 || notice.at > now + 60_000)) return true;
        const s = this.state(notice.chatId);
        if (notice.active !== null) {
            s.typingUntil = notice.active ? now + TYPING_TTL : 0;
            if (s.batch.length) this.arm(notice.chatId);
        }
        return true;
    }

    invalidate(s) {
        s.revision++;
        if (s.running || s.guards.size) s.interrupted = true;
        for (const guard of s.guards) guard.abort();
        s.guards.clear();
    }

    async receive(event, { injected = false, immediate = false, selfId = '' } = {}) {
        if (this.stopped || injected || event?.post_type !== 'message' || event.message_type !== 'private'
            || event.catchup === true || event.dshListeningReleased === true || event.dshFragmentReleased === true
            || String(event.user_id) === String(selfId)) return false;
        const chatId = 'private:' + String(event.user_id);
        const s = this.state(chatId);
        const id = String(event.message_id ?? '');
        if (!id) return false;
        if (s.seen.has(id)) return true;
        s.seen.add(id);
        if (s.seen.size > 256) s.seen.delete(s.seen.values().next().value);
        const text = messageText(event);
        event.raw_message = text;
        s.lastMessageAt = this.now();
        s.typingUntil = 0; // a previous typing notice may describe this just-sent bubble
        if (!isBackchannel(text)) this.invalidate(s);
        event.dshListeningRevision = s.revision;
        const plain = !text.includes('[CQ:') && (!Array.isArray(event.message) || event.message.every(p => p.type === 'text'));
        if (!plain || immediate || /^\s*\/[A-Za-z]/.test(text)) {
            await this.flush(chatId);
            return false;
        }
        if (!s.batch.length) s.firstHeldAt = this.now();
        s.batch.push(event);
        this.held({ chatId, messageId: id });
        this.arm(chatId);
        return true;
    }

    arm(chatId) {
        const s = this.state(chatId);
        this.cancel(s.timer);
        const text = String(s.batch.at(-1)?.raw_message ?? '');
        const unfinished = /(?:因为|然后|但是|所以|还有|我觉得|我想说|比如|…|\.\.\.|，|,|、)$/.test(text.trim());
        const soft = unfinished ? 6000 : (isBackchannel(text) ? 1800 : 900);
        const due = Math.min(s.firstHeldAt + HOLD_CAP, Math.max(s.lastMessageAt + soft, s.typingUntil + 500));
        s.timer = this.schedule(() => {
            s.timer = null;
            void this.flush(chatId).catch(e => this.log('warn', 'private listening release: ' + String(e.message)));
        }, Math.max(0, due - this.now()));
        s.timer?.unref?.();
    }

    async flush(chatId) {
        const s = this.state(chatId);
        this.cancel(s.timer);
        s.timer = null;
        if (!s.batch.length || this.stopped) return;
        const batch = s.batch;
        s.batch = [];
        const last = batch.at(-1);
        const text = batch.map(e => String(e.raw_message ?? '')).join('\n');
        const merged = { ...last, raw_message: text, message: [{ type: 'text', data: { text } }],
            dshListeningReleased: true, dshFragmentReleased: true,
            dshListeningRevision: last.dshListeningRevision ?? s.revision, dshListeningMergedIds: batch.map(e => String(e.message_id)) };
        await this.deliver(merged);
    }

    dispatch(chatId, revision) {
        if (chatId.startsWith('private:')) this.state(chatId).versions.push(revision ?? this.state(chatId).revision);
    }

    beginTurn(chatId) {
        if (!chatId.startsWith('private:')) return;
        const s = this.state(chatId);
        s.active = s.versions.shift() ?? s.revision;
        s.running = true;
    }

    endTurn(chatId) { if (chatId.startsWith('private:')) this.state(chatId).running = false; }

    adopt(chatId, revision) {
        if (chatId.startsWith('private:')) this.state(chatId).active = revision ?? this.state(chatId).revision;
    }

    hint(chatId, text, buffered = false) {
        if (!chatId.startsWith('private:')) return '';
        const s = this.state(chatId);
        const hints = ['[接话时机] 先把这句话和上文连起来理解，再决定要不要接、接什么、发几句；没有输入提示不等于对方已经说完。'];
        if (buffered) hints.push('这次相邻私聊气泡已一起交给你，不逐条应答，按合起来的意思接。');
        if (s.typingUntil > this.now()) hints.push('对方最近仍在输入，可能还想补充；先留点空间，不催、不猜未发内容。');
        if (isBackchannel(text)) hints.push('这条只有简短应和或笑声：可能只是点缀上句话、表达情感状态或收尾，先理解它的作用，不默认需要再回一句；不分析笑声、不点评对方在笑。若它实际回答了你的问题或承载需要接住的情绪，按上文自然接。');
        if (s.interrupted) {
            hints.push('上一轮尚未发送的回复可能已收起；把仍需回答的内容并进当前话题，别假定对方看过那段文字，也别解释取消过程。');
            s.interrupted = false;
        }
        return hints.join('\n');
    }

    timing(chatId) {
        if (!chatId.startsWith('private:') || this.stopped) return null;
        const s = this.state(chatId);
        if (s.active === null) return null;
        const revision = s.active;
        const abort = new AbortController();
        s.guards.add(abort);
        const current = () => !this.stopped && !abort.signal.aborted && revision === s.revision;
        const guard = {
            signal: abort.signal, isCurrent: current,
            context: { active: this.now() - s.lastMessageAt < 120_000 },
            beforeSend: async ({ immediate = false } = {}) => {
                if (immediate) return current();
                const cap = this.now() + HOLD_CAP;
                while (current()) {
                    const due = Math.max(s.typingUntil + 500, s.lastMessageAt + 900, s.batch.length ? this.now() + 200 : 0);
                    if (this.now() >= due || this.now() >= cap) return true;
                    await this.sleep(Math.min(100, due - this.now(), cap - this.now()));
                }
                return false;
            },
            onCancelled: () => { s.interrupted = true; },
            dispose: () => { s.guards.delete(abort); },
        };
        return guard;
    }

    stop() {
        this.stopped = true;
        for (const s of this.chats.values()) {
            this.cancel(s.timer);
            for (const guard of s.guards) guard.abort();
            s.guards.clear();
            s.batch = [];
        }
    }
}

export function listeningFor(bridge) {
    let controller = controllers.get(bridge);
    if (!controller) {
        controller = new PrivateListening({
            deliver: event => bridge.handleInboundOnce(event, false),
            held: inbound => bridge.catchup?.noteDeferred?.(inbound),
            log: (level, message) => bridge.deps?.log?.(level, message),
        });
        controllers.set(bridge, controller);
    }
    return controller;
}
