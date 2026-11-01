"""v2.35: peer typing, short private bursts and cancellable context-aware replies."""
from __future__ import annotations
import argparse
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
LIB = REPO / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SRC = Path(__file__).resolve().parent.parent / 'modules/onebot_listening.js'
DEST = LIB / 'listening.js'


def put(text: str, old: str, new: str, marker: str) -> str:
    if marker in text: return text
    if text.count(old) != 1: raise SystemExit('listening hook mismatch: ' + marker)
    return text.replace(old, new, 1)


def expected(path: Path) -> str:
    text = path.read_text(encoding='utf-8')
    if path.name == 'bridge.js':
        anchor = "import { CatchUp } from './catchup.js';"
        text = put(text, anchor, anchor + "\nimport { listeningFor } from './listening.js';", "import { listeningFor }")
        text = put(text, '        this.stopping = true;', '        this.stopping = true;\n        listeningFor(this).stop();', 'listeningFor(this).stop();')
        anchor = '                // [dsh-p1] QQ 戳一戳: a poke aimed at us becomes a tiny turn.'
        # This old comment appears twice. Insert before the unique notice log.
        anchor = "                if (event.post_type === 'notice')\n                    this.deps.log('info', 'notice event: '"
        new = """                // [dsh-p1] peer typing is state, not a model/user message.
                const listening = listeningFor(this);
                const selfId = this.deps.connection?.selfId ?? this.deps.config.botQQ ?? '';
                if (listening.typing(event, selfId)) return;
                const immediate = isAdminSettleText(String(event.raw_message ?? ''));
                if (await listening.receive(event, { injected, immediate, selfId })) return false;
""" + anchor
        text = put(text, anchor, new, 'const listening = listeningFor(this);')

        old = """                if (!injected && handled === false)
                    this.catchup.noteDeferred(inbound);
                return handled;"""
        new = """                if (!injected && handled === false)
                    this.catchup.noteDeferred(inbound);
                // Every merged bubble keeps its delivery ledger entry.
                if (!injected) for (const id of inbound.listeningMergedIds ?? []) {
                    const item = { chatId: inbound.chatId, messageId: id };
                    if (handled === false) this.catchup.noteDeferred(item);
                    else this.catchup.noteSeen(item);
                }
                return handled;"""
        text = put(text, old, new, 'Every merged bubble keeps its delivery ledger entry.')

        old = '            dispatchFollowup: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),'
        new = '            dispatchFollowup: (chatId, text, role, nickname, revision) => this.dispatchFollowup(chatId, text, role, nickname, revision),'
        text = put(text, old, new, new.strip())
        old = '            interceptBusyTurn: (chatId, text, role, nickname, plain) => this.interceptBusyTurn(chatId, text, role, nickname, plain),'
        new = '            interceptBusyTurn: (chatId, text, role, nickname, plain, revision) => this.interceptBusyTurn(chatId, text, role, nickname, plain, revision),'
        text = put(text, old, new, new.strip())
        anchor = '            reactionHint: chatId => reactionPolicy(this).hint(chatId),'
        text = put(text, anchor, anchor + '\n            listeningHint: (chatId, body, buffered) => listeningFor(this).hint(chatId, body, buffered),', 'listeningHint: (chatId, body, buffered) =>')

        old = '    async dispatchFollowup(chatId, text, role, nickname) {'
        new = """    async dispatchFollowup(chatId, text, role, nickname, listeningRevision) {
        const listeningStamp = listeningRevision ?? (chatId.startsWith('private:') ? listeningFor(this).state(chatId).revision : undefined);"""
        text = put(text, old, new, 'const listeningStamp = listeningRevision ??')
        anchor = '        chat.pendingTurnRoles.push(role);'
        text = put(text, anchor, anchor + '\n        listeningFor(this).dispatch(chatId, listeningStamp);', 'listeningFor(this).dispatch(chatId, listeningStamp);')
        anchor = "        if (event.type === 'turn/start') {"
        text = put(text, anchor, anchor + '\n            listeningFor(this).beginTurn(chatId);', 'listeningFor(this).beginTurn(chatId);')
        anchor = "        if (event.type === 'turn/end') {"
        text = put(text, anchor, anchor + '\n            listeningFor(this).endTurn(chatId);', 'listeningFor(this).endTurn(chatId);')

        old = '    steerMessage(chatId, text) {'
        new = '    steerMessage(chatId, text, listeningRevision) {'
        text = put(text, old, new, new)
        anchor = '        chat.agent.steer(createUserMessage({'
        text = put(text, anchor, '        listeningFor(this).adopt(chatId, listeningRevision);\n' + anchor, 'listeningFor(this).adopt(chatId, listeningRevision);')
        old = '    async interceptBusyTurn(chatId, text, role, nickname, plain) {'
        new = '    async interceptBusyTurn(chatId, text, role, nickname, plain, listeningRevision) {'
        text = put(text, old, new, new)
        text = text.replace('            this.steerMessage(chatId, text);', '            this.steerMessage(chatId, text, listeningRevision);')
        text = text.replace('        await this.dispatchFollowup(chatId, text, role, nickname);', '        await this.dispatchFollowup(chatId, text, role, nickname, listeningRevision);')

        old = '        return this.outbound.sendToChat(chatId, text, options);'
        new = """        const timing = options.modelReply ? listeningFor(this).timing(chatId) : null;
        const send = this.outbound.sendToChat(chatId, text, timing ? { ...options, replyTiming: timing } : options);
        return timing ? send.finally(() => timing.dispose()) : send;"""
        text = put(text, old, new, 'const timing = options.modelReply ? listeningFor(this).timing(chatId) : null;')
        old = """    sendSegments(chatId, segments) {
        return this.outbound.sendSegments(chatId, segments);
    }"""
        new = """    sendSegments(chatId, segments) {
        const controller = listeningFor(this);
        const timing = chatId.startsWith('private:') && controller.state(chatId).running ? controller.timing(chatId) : null;
        const send = this.outbound.sendSegments(chatId, segments, timing ? { replyTiming: timing, throwIfSuperseded: true } : {});
        return timing ? send.finally(() => timing.dispose()) : send;
    }"""
        text = put(text, old, new, 'throwIfSuperseded: true')
        # Only assistant delivery is paced. Administrative/command receipts are
        # not accidentally attributed to an older model turn.
        old = """        this.interim = new InterimTracker({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),"""
        new = """        this.interim = new InterimTracker({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, { ...options, modelReply: true }),"""
        text = put(text, old, new, new)
        old = """        this.deferred = new DeferredDelivery({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),"""
        new = """        this.deferred = new DeferredDelivery({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, { ...options, modelReply: true }),"""
        text = put(text, old, new, new)
    elif path.name == 'inbound.js':
        anchor = '        catchup: event.catchup === true,'
        new = anchor + """
        listeningRevision: Number.isInteger(event.dshListeningRevision) ? event.dshListeningRevision : undefined,
        listeningBuffered: event.dshListeningReleased === true,
        listeningMergedIds: Array.isArray(event.dshListeningMergedIds) ? event.dshListeningMergedIds.map(String) : [],"""
        text = put(text, anchor, new, 'listeningBuffered: event.dshListeningReleased === true,')
        anchor = '        // [dsh-p1] reaction context: break repeated face/sticker-only replies.'
        new = """        const listeningHint = this.ctx.listeningHint?.(chatId, inbound.text, inbound.listeningBuffered) ?? '';
        if (listeningHint !== '') final = listeningHint + '\\n' + final;
""" + anchor
        text = put(text, anchor, new, 'const listeningHint = this.ctx.listeningHint?.(')
        text = text.replace('this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain)', 'this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain, inbound.listeningRevision)')
        text = text.replace('this.ctx.dispatchFollowup(chatId, final, role, nickname)', 'this.ctx.dispatchFollowup(chatId, final, role, nickname, inbound.listeningRevision)')
    elif path.name == 'outbound.js':
        anchor = '                notBefore: Number.isFinite(timing.notBefore) ? timing.notBefore : this.now() + delay } };'
        new = '                bypassPeerWait: parsedTiming.waitMs === 0,\n' + anchor
        text = put(text, anchor, new, 'bypassPeerWait: parsedTiming.waitMs === 0,')
        anchor = "    async sendMsg(chatId, segments, options) {"
        new = anchor + """
        // [dsh-p1] check fresh peer-input state before every text/media bubble.
        if (options.replyTiming?.beforeSend && !await options.replyTiming.beforeSend({ immediate: options.replyTiming.bypassPeerWait === true })) {
            options.replyTiming.onCancelled?.();
            if (options.throwIfSuperseded) throw new Error('reply_superseded_by_followup');
            return undefined;
        }"""
        text = put(text, anchor, new, 'check fresh peer-input state before every text/media bubble.')
        text = text.replace('!await options.replyTiming.beforeSend())', '!await options.replyTiming.beforeSend({ immediate: options.replyTiming.bypassPeerWait === true }))')
        text = text.replace('    sendSegments(chatId, segments) {', '    sendSegments(chatId, segments, options = {}) {')
        text = text.replace('const id = await this.sendMsg(chatId, segments, {});', 'const id = await this.sendMsg(chatId, segments, options);')
    return text


def apply() -> None:
    edits = {LIB / n: expected(LIB / n) for n in ['bridge.js', 'inbound.js', 'outbound.js']}
    DEST.write_text(SRC.read_text(encoding='utf-8'), encoding='utf-8', newline='\n')
    for p, value in edits.items():
        if value != p.read_text(encoding='utf-8'):
            newline = '\r\n' if b'\r\n' in p.read_bytes() else '\n'
            p.write_text(value, encoding='utf-8', newline=newline)
    print('Private listening installed; restart DSH')


def check() -> bool:
    return DEST.exists() and DEST.read_text(encoding='utf-8') == SRC.read_text(encoding='utf-8') and all(
        expected(LIB / n) == (LIB / n).read_text(encoding='utf-8') for n in ['bridge.js', 'inbound.js', 'outbound.js'])


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--check', action='store_true')
    args = p.parse_args()
    if args.check:
        ok = check()
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    apply()
