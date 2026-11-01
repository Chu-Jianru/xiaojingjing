// A complete authored reply plus optional local side effects in one model step.
// Existing transport, reaction guards, memory scopes and delivery checks apply.
export async function noteDeliveredSleep(bridge, text, deps) {
    // [dsh-p1] v2.62 self: preserve falling-asleep intent after actual delivery.
    if (/[?？]/.test(text) || !/(?:我|小鲸鲸)(?:先|这就|马上|也)?(?:去)?(?:睡|躺)了|^(?:先|这就)?(?:去)?(?:睡觉去了|要睡了|睡了)[。！!～~]*$/.test(text)) return;
    try {
        const sleep = deps.sleep ?? await import('./sleep.js');
        const now = deps.now?.() ?? Date.now();
        const state = await sleep.loadSleep(bridge.deps.config.mediaDir);
        if (sleep.computeStatus(state, now) === 'awake') {
            state.sleepPendingAt = now + 10 * 60_000;
            state.sleepIntent = { kind: 'random' }; state.fallingAt = now;
            await sleep.saveSleep(bridge.deps.config.mediaDir, state);
        }
    } catch { /* A state-write failure cannot undo the delivered reply. */ }
}

export function makeReplyTool(defineTool, bridge, deps) {
    return defineTool({
        name: 'qq_reply',
        description: '一次提交已经想完整的聊天回复，可顺带一个原生表情、至多两条默记事实或必要的情绪微调。普通纯文字仍直接回复即可；需要附带这些动作时用它，避免再跑一轮确认。需要先查资料、看图或读取操作结果才能回答时先查询，不提前用它结束。不增加表情/记忆/情绪调整频率，不代发别的会话。',
        parameters: {
            text: { type: 'string', required: true, description: '本轮完整回复；换行和[[reply:ID]]沿用原气泡/引用规则。不要另在工具外重复正文。' },
            face_id: { type: 'number', description: '确实需要点缀时才带一个原生表情编号，省略即不发；纯表情、明确索表情或索图仍用原工具。' },
            memories: { type: 'array', items: { type: 'object', properties: {
                text: { type: 'string', required: true }, kind: { type: 'string' }, scope: { type: 'string', enum: ['chat', 'global'] },
            }, additionalProperties: false }, description: '至多两条值得长期记住的事实；每条text至多200字，scope默认chat。没有新事实就省略。' },
            mood_adjust: { type: 'object', additionalProperties: false, properties: {
                mood: { type: 'number' }, energy: { type: 'number' }, affection: { type: 'number' }, user_id: { type: 'string' },
            }, description: '仅在自动状态更新确有遗漏时微调（同qq_mood adjust）；群里调某人好感要给user_id。不要每轮调、不要重复自动加分或扣精力。' },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const chatId = bridge.chatForSession(exec.agent?.session?.id);
            if (!chatId) throw new Error('qq_reply: no current QQ chat');
            const text = String(args?.text ?? '').trim();
            const plain = text.replace(/\[\[(?:reply|wait):[^\]]*\]\]/g, '').trim();
            if (!plain || /^(?:\[不回\]|（不回）|【不回】)$/.test(plain)) throw new Error('qq_reply: requires an actual reply');
            const memories = args?.memories ?? [];
            if (!Array.isArray(memories) || memories.length > 2) throw new Error('qq_reply: at most two memories');
            for (const note of memories) {
                if (typeof note?.text !== 'string' || !note.text.trim() || note.text.length > 200)
                    throw new Error('qq_reply: memory text must contain 1-200 characters');
                if (note.scope !== undefined && !['chat', 'global'].includes(note.scope)) throw new Error('qq_reply: invalid memory scope');
            }
            if (args.face_id !== undefined && (!Number.isInteger(args.face_id) || args.face_id < 0 || args.face_id > 9999))
                throw new Error('qq_reply: invalid face_id');
            const mood = args.mood_adjust;
            if (mood !== undefined && (!mood || typeof mood !== 'object' || Array.isArray(mood)
                || ['mood', 'energy', 'affection'].some(key => mood[key] !== undefined && !Number.isFinite(mood[key]))))
                throw new Error('qq_reply: invalid mood_adjust');
            if (exec.signal?.aborted || bridge.stopping) throw new Error('qq_reply: cancelled');
            const caption = bridge.__chatCaptionReceipts?.get(exec.agent?.session?.id);
            const shape = value => String(value ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('\n');
            const captionEcho = caption?.chatId === chatId && shape(text) === shape(caption.text);
            const ids = captionEcho ? [caption.messageId]
                : await bridge.sendToChat(chatId, text, { modelReply: true, queuable: true });
            if (!Array.isArray(ids) || !ids.length) return { sent: false, ok: false, code: 'reply_not_delivered' };
            const result = { sent: true, textSent: !captionEcho, messageId: String(ids[0]), ok: true, memoriesSaved: 0,
                ...(captionEcho ? { dedupedCaption: true } : {}) };
            if (!captionEcho && !exec.signal?.aborted && !bridge.stopping) await noteDeliveredSleep(bridge, plain, deps);
            // A decorative expression may be declined by the existing guard.
            // The complete text has already answered the user; do not invent
            // a new follow-up just to discuss decoration or a cooldown.
            if (args.face_id !== undefined && !exec.signal?.aborted && !bridge.stopping) {
                try {
                    result.face = await deps.sendReaction(bridge, chatId, { response_mode: 'reaction_only' },
                        () => bridge.sendSegments(chatId, [{ type: 'face', data: { id: String(args.face_id) } }]));
                } catch { result.face = { sent: false, code: 'decoration_failed' }; }
            }
            if (mood && !exec.signal?.aborted && !bridge.stopping) {
                try {
                    await deps.adjustMood(bridge.deps.config.mediaDir ?? deps.mediaDirFallback, {
                        mood: mood.mood ?? 0, energy: mood.energy ?? 0, affection: mood.affection ?? 0,
                        userId: mood.user_id ?? (chatId.startsWith('private:') ? chatId.slice(8) : ''),
                    });
                    result.moodAdjusted = true;
                } catch { result.ok = false; result.code = 'mood_adjust_failed'; result.remainingMoodAdjust = mood; }
            } else if (mood) {
                result.ok = false; result.code = 'mood_adjust_cancelled'; result.remainingMoodAdjust = mood;
            }
            for (const [index, note] of memories.entries()) {
                if (exec.signal?.aborted || bridge.stopping) {
                    result.ok = false; result.code = 'memory_write_cancelled';
                    result.remainingMemories = memories.slice(index); break;
                }
                try {
                    await deps.appendMemory(bridge.deps.config.mediaDir ?? deps.mediaDirFallback, {
                        chat: chatId, text: note.text, kind: note.kind ?? 'fact', scope: note.scope ?? 'chat',
                    });
                    result.memoriesSaved++;
                } catch {
                    result.ok = false; result.code = 'memory_write_failed';
                    result.remainingMemories = memories.slice(index); break;
                }
            }
            if (!result.ok) result.next = 'text_already_delivered_do_not_repeat_it_retry_only_failed_side_effects';
            return result;
        },
    });
}
