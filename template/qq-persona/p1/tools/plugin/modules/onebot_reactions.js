/** Context is chosen by the model; this guard prevents reaction-only loops. */
const policies = new WeakMap();
const MODES = new Set(['with_text', 'reaction_only', 'requested']);

export function isStickerSource(source) {
    return typeof source === 'string' && /[\\/]stickers[\\/]/i.test(source);
}

export function reactionArgs(args, stripMarkers) {
    const a = args ?? {};
    const text = typeof a.caption === 'string' ? stripMarkers(a.caption).text.trim() : '';
    return { ...a, caption: /^(?:\[不回\]|（不回）|【不回】)$/.test(text) ? '' : text };
}

export class ReactionPolicy {
    constructor() { this.chats = new Map(); }

    state(chatId) {
        let state = this.chats.get(chatId);
        if (!state) {
            state = { turn: 0, lastTextTurn: -1, lastReactionTurn: -1, textReplies: 2, pending: null };
            this.chats.set(chatId, state);
        }
        return state;
    }

    beginTurn(chatId) { this.state(chatId).turn++; }

    noteText(chatId, segments) {
        // A caption on the same reaction does not count as a new plain-text
        // reply, and multiple bubbles in one turn count only once.
        if (segments.some(s => s.type === 'face' || s.type === 'mface' || (s.type === 'image' && Number(s.data?.sub_type) === 1))) return;
        const text = segments.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('');
        if (!/[\p{L}\p{N}]/u.test(text) || /^\s*\[不回\]\s*$/.test(text)) return;
        const state = this.state(chatId);
        if (state.lastTextTurn !== state.turn) {
            state.lastTextTurn = state.turn;
            state.textReplies = Math.min(2, state.textReplies + 1);
        }
    }

    reserve(chatId, { mode, caption = '', count = 1 }) {
        const state = this.state(chatId);
        let code = '';
        if (mode === 'with_text' && !/[\p{L}\p{N}]/u.test(String(caption))) code = 'substantive_reply_required';
        else if (state.pending || state.lastReactionTurn === state.turn) code = 'reaction_already_used_this_turn';
        if (code) return { ok: false, code };
        const ticket = { chatId, turn: state.turn };
        state.pending = ticket;
        return { ok: true, ticket };
    }

    finish(ticket, success) {
        const state = this.state(ticket.chatId);
        if (state.pending !== ticket) return;
        state.pending = null;
        if (success) {
            state.lastReactionTurn = ticket.turn;
            state.textReplies = 0;
        }
    }

    hint(chatId) {
        return '';
    }
}

export function reactionPolicy(bridge) {
    let policy = policies.get(bridge);
    if (!policy) { policy = new ReactionPolicy(); policies.set(bridge, policy); }
    return policy;
}

export async function sendReaction(bridge, chatId, args, send, count = 1, { ownerRequested = false } = {}) {
    if (ownerRequested) {
        const id = await send();
        return { sent: true, textSent: typeof args.caption === 'string' && args.caption.trim() !== '', messageId: id ?? null };
    }
    const policy = reactionPolicy(bridge);
    const decision = policy.reserve(chatId, { mode: args.response_mode, caption: args.caption, count });
    if (!decision.ok) {
        // Internal status only. The model must compose any needed text itself;
        // never send a canned refusal or fabricate a successful reaction.
        return { sent: false, textSent: false, code: decision.code, next: 'reply_to_content_in_your_own_words_if_needed_do_not_send_another_reaction' };
    }
    try {
        const id = await send();
        policy.finish(decision.ticket, true);
        return { sent: true, textSent: typeof args.caption === 'string' && args.caption.trim() !== '', messageId: id ?? null };
    }
    catch (error) {
        policy.finish(decision.ticket, false);
        throw error;
    }
}
