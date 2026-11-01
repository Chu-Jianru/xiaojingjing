// Keep conversation facts; deduplicate only producer-owned historical context.
// Native surface replacements preserve the original append-only log and replay.
const BLOCKS = /^\[(画像|共同记忆|记忆|梗)\]\n[\s\S]*?^\[\/\1\]\n?/gm;
const LINES = /^\[(?:作息|表情使用)\][^\n]*(?:\n|$)|^（状态只影响你怎么接话[^\n]*）(?:\n|$)/gm;

export function planWorkingContext(session, { keepRecent = 6, minSavedChars = 1000 } = {}) {
    const candidates = session.surface.nodes.map(seq => ({ seq, event: session.eventAt(seq) }))
        .filter(({ event }) => event?.type === 'user/message' && event.data?.source?.kind === 'plugin:dsh-onebot');
    const seen = new Set(), edits = [];
    let savedChars = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
        const { seq, event } = candidates[i], preserve = i >= candidates.length - keepRecent;
        const message = session.deriveEventMessage(event);
        if (!message || !Array.isArray(message.content)) continue;
        let changed = false;
        const content = message.content.map(block => {
            if (block.type !== 'text') return block;
            const boundary = block.text.indexOf('<user_message ');
            if (boundary < 0) return block; // Never touch summaries or unknown framing.
            const dedup = (value, name = '') => {
                // The encounter counter changes every message; the facts,
                // relationship stage and style are still compared in full.
                const key = name + '|' + (name === '画像'
                    ? value.replace(/(^- 这是[^\n]*（QQ \d+），你们聊过 )\d+( 次)(?=\n|$)/m, '$1N$2') : value).trim();
                const duplicate = seen.has(key);
                seen.add(key);
                return duplicate && !preserve ? '' : value;
            };
            const prefix = block.text.slice(0, boundary).replace(BLOCKS, dedup).replace(LINES, value => dedup(value));
            const text = prefix + block.text.slice(boundary);
            if (text === block.text) return block;
            changed = true;
            savedChars += block.text.length - text.length;
            return { ...block, text };
        });
        if (changed) edits.push({ seq, message: { ...message, content } });
    }
    return { edits: savedChars >= minSavedChars ? edits : [], savedChars,
        candidateMessages: candidates.length, keepRecent };
}

export function applyWorkingContext(session, plan, createMessage) {
    let changed = 0;
    for (const edit of plan.edits) {
        // A prior native compaction may have replaced this node. A skipped
        // node never causes a broad range to be removed or an old fact revived.
        if (!session.surface.nodes.includes(edit.seq)) continue;
        const message = createMessage({ content: edit.message.content, source: edit.message.source });
        session.append('user/message', message, {
            surfaceOp: { op: 'replace', startSeq: edit.seq, endSeq: edit.seq },
            sourceEventSeqs: [edit.seq],
        });
        changed++;
    }
    return changed;
}

export function installWorkingContext(agentCtx, bridge, createMessage) {
    if (typeof agentCtx.on !== 'function') return;
    const generations = new WeakMap();
    agentCtx.on('agent/pre-step', async ({ agent, signal }, next) => {
        const session = agent.session;
        const chatId = bridge.bySession.get(session.id);
        if (!chatId?.startsWith('group:')) return next();
        const before = session.surface.replaceGeneration;
        const previous = generations.get(session) ?? before;
        const decision = await next();
        const current = session.surface.replaceGeneration;
        // Compaction already broke this prefix. Clean at the same boundary,
        // never every turn: repeated cache invalidation can cost MORE than
        // the cached tokens saved and make ordinary chat noticeably slower.
        if (!signal.aborted && decision.kind !== 'reject' && (current !== before || current !== previous)) {
            const plan = planWorkingContext(session);
            const changed = applyWorkingContext(session, plan, createMessage);
            if (changed) bridge.deps.log('info', 'working context: ' + chatId + ' messages=' + changed
                + ' savedChars=' + plan.savedChars + ' recentKept=' + plan.keepRecent);
        }
        generations.set(session, session.surface.replaceGeneration);
        return decision;
    });
}
