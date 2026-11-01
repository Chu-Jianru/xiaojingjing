// Deliver committed chat text without waiting for unrelated bookkeeping tools.
// finish_turn is an explicit model decision, never inferred from its wording.
const FINISHABLE = new Set(['qq_send_face', 'qq_send_image', 'qq_send_voice', 'qq_draw', 'qq_sing', 'qq_add_sticker', 'qq_self_expression', 'qq_remember', 'qq_reply', 'qq_mood']);
const BARE_FACE = /^\[表情:([^\]\r\n]{1,20})\]$/u;
const SILENT = /^(?:\[不回\]|（不回）|【不回】)$/;
const instances = new WeakMap();

function argumentsOf(call) {
    try { return typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments ?? {}; }
    catch { return {}; }
}

function finishableCall(call) {
    return FINISHABLE.has(call.name) && !(call.name === 'qq_mood' && argumentsOf(call).action === 'read');
}

// QQ discards empty bubble lines and trims each line. Compare that delivery
// shape, retaining punctuation, inline spaces, quotes and message IDs.
function sameReply(left, right) {
    const shape = value => String(value ?? '').split(/\r?\n/)
        .map(line => line.trim()).filter(Boolean).join('\n');
    const a = shape(left);
    return a !== '' && a === shape(right);
}

export const CHAT_FLOW_GUIDANCE = '【聊天传输】普通群聊正文写好就会发送，不必等记忆或表情工具结束。需要查资料、看图或查询工具结果后才能回答的，先拿到结果再写正文。qq_send_face、qq_send_image、qq_send_voice、qq_remember、qq_add_sticker、qq_self_expression可带finish_turn=true：只在本轮正文/语音已完整（或纯反应足够、明确无需说话），且操作后不需再看结果补话时使用；成功后自然结束，无需再生成确认或[不回]。群聊和私聊均可用媒体工具：发语音实际调用qq_send_voice，表情包用qq_send_image，QQ表情用qq_send_face或qq_reply.face_id；[语音]/[图片]是收到消息的标注，不能用正文冒充媒体；原生QQ表情优先走工具，整句仅一个[表情:名称或编号]兼容为真实QQ表情并受原使用规则约束，引用/说明文字不转换。是否发成以本轮工具结果为准，不能把历史文字或一次失败当成当前不可用。语音本身就是回复，不重复同句文字或补回执；收藏/改签也不报操作流水。失败、结果不明、还需回答时继续处理。正文与caption不重复写同一段话。';

export const SINGLE_REPLY_GUIDANCE = '【一次完成回复】普通纯文字直接回复即可。已经决定完整回复、这轮还确实需要附带一个原生表情、默记新事实或微调情绪时，优先一次qq_reply提交text及可选face_id/memories/mood_adjust；正文不在工具外重复，沿用原先内容优先、表情点缀和记忆范围的标准。不要为了用这个入口增加表情、记忆、情绪调整或说话次数。qq_mood只有adjust可用finish_turn=true收尾，read仍需看结果；明确[不回]且仅有已完成的记忆/情绪微调也可结束，无需额外确认。尚需查询、看图、检查操作结果或继续回答时先完成那些事，不能提前结束。原图片/语音/查询/管理工具照常可用。';

export class ChatFlow {
    constructor(bridge, faceRuntime) {
        this.faceRuntime = faceRuntime;
        this.bridge = bridge; this.steps = new Map(); this.turns = new Map();
        bridge.__chatCaptionReceipts ??= new Map();
    }

    onAssistant(session, event, chatId) {
        if (this.bridge.effectiveInterim(chatId)) return false;
        if (Number.isInteger(event.data.turn)) {
            const prior = this.turns.get(session.id);
            if (!prior || prior.turn !== event.data.turn || prior.chatId !== chatId) {
                this.bridge.__chatCaptionReceipts.delete(session.id);
                this.turns.set(session.id, { turn: event.data.turn, chatId });
                if (this.turns.size > 128) {
                    const old = this.turns.keys().next().value;
                    this.turns.delete(old); this.bridge.__chatCaptionReceipts.delete(old);
                }
            }
        }
        const fastDelivery = chatId.startsWith('group:');
        const message = event.data.message;
        const calls = message.content.filter(block => block.type === 'tool-call');
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
        const faceLabelInTool = BARE_FACE.test(text) && calls.some(call =>
            ['qq_send_face', 'qq_send_image', 'qq_send_voice'].includes(call.name)
            || (call.name === 'qq_reply' && Number.isInteger(argumentsOf(call).face_id)));
        const echoedCaption = faceLabelInTool || calls.some(call => sameReply(text,
            call.name === 'qq_reply' ? argumentsOf(call).text
                : call.name === 'qq_send_voice' ? argumentsOf(call).text
                : ['qq_send_face', 'qq_send_image'].includes(call.name) ? argumentsOf(call).caption : ''));
        // Read/management tools retain the existing final-response path. Their
        // results can change the answer, so no transport shortcut applies.
        if (calls.some(call => !finishableCall(call))) {
            this.steps.delete(session.id);
            // A query still needs its result and cannot conclude early, but
            // its companion reply/caption already owns this exact text.
            return echoedCaption;
        }
        const plain = text.replace(/\[\[(?:reply|wait):[^\]\n]*\]\]/g, '').trim();
        const silentChoice = SILENT.test(plain);
        const visibleText = plain !== '' && !silentChoice;
        const privateReplyEcho = !fastDelivery && calls.some(call => ['qq_reply', 'qq_send_voice'].includes(call.name) && sameReply(text, argumentsOf(call).text));
        const replyInTool = calls.some(call => {
            const args = argumentsOf(call);
            return ['qq_reply', 'qq_send_voice'].includes(call.name) ? String(args.text ?? '').trim() !== ''
                : ['qq_send_face', 'qq_send_image'].includes(call.name) && String(args.caption ?? '').trim() !== '';
        });
        const state = { messageId: message.id, calls: new Map(calls.map(call => [call.id, call])),
            results: new Map(), failed: false, requested: calls.some(call => call.name === 'qq_reply' || argumentsOf(call).finish_turn === true),
            delivery: Promise.resolve(false), chatId, silentChoice, handled: (fastDelivery && (visibleText || replyInTool)) || privateReplyEcho || faceLabelInTool };
        // Session updates must never send the same committed message twice.
        if (message.id && this.steps.get(session.id)?.messageId === message.id) return this.steps.get(session.id).handled;
        this.steps.set(session.id, state);
        // Only an entire, committed assistant face reply is a legacy QQ-face
        // intent. Quotes, prose, files, voice labels and real tool calls stay
        // on their existing paths. Never parse incoming/user text here.
        const bareFace = calls.length === 0 ? BARE_FACE.exec(text) : null;
        if (bareFace) {
            state.handled = true;
            state.delivery = this.deliverBareFace(chatId, text, bareFace[1]).catch(error => {
                this.bridge.deps.log('warn', 'bare face delivery failed: ' + String(error));
                return false;
            });
            return true;
        }
        if (!fastDelivery) return state.handled;
        if (visibleText && !echoedCaption) {
            const readyAt = Date.now();
            state.delivery = Promise.resolve().then(() => this.bridge.sendToChat(chatId, text, { queuable: true, modelReply: true }))
                .then(ids => {
                    const delivered = Array.isArray(ids) && ids.length > 0;
                    this.bridge.deps.log('info', 'chat flow delivery: ' + chatId + ' turn=' + event.data.turn
                        + ' step=' + event.data.step + ' sendMs=' + (Date.now() - readyAt) + ' delivered=' + delivered);
                    return delivered;
                }).catch(error => {
                    this.bridge.deps.log('warn', 'chat flow delivery failed: ' + String(error));
                    return false;
                });
        }
        // Silence is not a replacement answer. Let the deferred-text tracker
        // retain any earlier authored response from an unknown/query tool step.
        return state.handled;
    }

    async deliverBareFace(chatId, text, label) {
        const runtime = this.faceRuntime ?? await Promise.all([import('./cq.js'), import('./reactions.js')])
            .then(([cq, reactions]) => ({ faceToEmoji: cq.faceToEmoji, sendReaction: reactions.sendReaction }));
        let id = /^\d{1,3}$/.test(label) ? Number(label) : null;
        if (id === null) {
            // Reuse the installed QQ label table; do not invent an emoji map.
            for (let candidate = 0; candidate < 1000; candidate++) {
                if (runtime.faceToEmoji(String(candidate)) === text) { id = candidate; break; }
            }
        }
        if (id === null) {
            const ids = await this.bridge.sendToChat(chatId, text, { queuable: true, modelReply: true });
            return Array.isArray(ids) && ids.length > 0;
        }
        if (this.bridge.stopping) return false;
        const result = await runtime.sendReaction(this.bridge, chatId, { response_mode: 'reaction_only' },
            () => this.bridge.sendSegments(chatId, [{ type: 'face', data: { id: String(id) } }]), 1);
        const delivered = result?.sent === true && Boolean(result.messageId);
        this.bridge.deps.log(delivered ? 'info' : 'debug',
            'bare face delivery: ' + chatId + ' face=' + id + ' delivered=' + delivered
            + (result?.code ? ' reason=' + result.code : ''));
        return delivered;
    }

    wrapTool(tool) {
        if (!FINISHABLE.has(tool.name)) return tool;
        const flow = this;
        const output = tool.name !== 'qq_mood' ? tool.output : { ...tool.output, render(args, value) {
            // An adjustment acknowledgement needs the updated scalars, not
            // everyone's affection map and historical events on every call.
            // Explicit reads retain the original complete result contract.
            if (args?.action === 'read' || !Number.isFinite(value?.mood) || !Number.isFinite(value?.energy))
                return tool.output.render(args, value);
            const state = { ok: true, mood: value.mood, energy: value.energy };
            if (args?.user_id && Number.isFinite(value.affection?.[args.user_id])) state.affection = value.affection[args.user_id];
            return [{ type: 'text', text: JSON.stringify(state) }];
        } };
        return { ...tool, output, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
            finish_turn: { type: 'boolean', description: '本轮回复已完整且操作后无需再补话时设true；成功后直接结束，失败仍继续。需要查询结果或继续回答时不设。' } } },
            async execute(args, exec) {
                const { finish_turn, ...originalArgs } = args ?? {};
                const state = flow.steps.get(exec.agent?.session?.id);
                const turn = flow.turns.get(exec.agent?.session?.id);
                try {
                    const result = await tool.execute(originalArgs, exec);
                    if (turn && flow.turns.get(exec.agent?.session?.id) === turn
                        && ['qq_send_face', 'qq_send_image', 'qq_draw'].includes(tool.name) && result?.sent === true
                        && result.textSent === true && result.messageId && String(originalArgs.caption ?? '').trim()) {
                        flow.bridge.__chatCaptionReceipts.set(exec.agent.session.id,
                            { chatId: turn.chatId, text: originalArgs.caption, messageId: String(result.messageId) });
                    }
                    if (state && state === flow.steps.get(exec.agent?.session?.id) && state.calls.has(exec.callId)) {
                        const success = ['qq_remember', 'qq_add_sticker'].includes(tool.name) ? result?.ok === true
                            : tool.name === 'qq_self_expression' ? result?.changed === true || ['same', 'cooldown'].includes(result?.reason)
                            : tool.name === 'qq_mood' ? Number.isFinite(result?.mood) && Number.isFinite(result?.energy)
                            : result?.sent === true && Boolean(result.messageId) && result?.ok !== false;
                        state.results.set(exec.callId, success);
                        if (!success) state.failed = true;
                        if (state.requested && !state.failed && state.results.size === state.calls.size
                            && !exec.signal?.aborted && !flow.bridge.stopping) {
                            // Await accepted text delivery so a failed/offline send
                            // cannot silently conclude a memory-only reply.
                            const textDelivered = await state.delivery;
                            const mediaDelivered = [...state.calls.values()].some(call => ['qq_send_face', 'qq_send_image', 'qq_send_voice', 'qq_draw', 'qq_sing', 'qq_reply'].includes(call.name) && state.results.get(call.id));
                            if (textDelivered || mediaDelivered || state.silentChoice) exec.concludeTurn?.();
                        }
                    }
                    return result;
                } catch (error) {
                    if (state) state.failed = true;
                    throw error;
                }
            } };
    }
}

export function chatFlowFor(bridge) {
    let flow = instances.get(bridge);
    if (!flow) { flow = new ChatFlow(bridge); instances.set(bridge, flow); }
    return flow;
}
