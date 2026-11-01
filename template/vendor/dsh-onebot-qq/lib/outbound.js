/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / plain
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitChatId } from './chat.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { extractForwardBlocks, scanSensitive, stripMarkdown } from './split.js';
import { renderTextImage } from './t2i/index.js';
import { describeError } from './errors.js';
import { TRACE_REASONS } from './trace.js';
import { parseReplyTiming, defaultReplyDelayMs, bubbleDelayMs, replyIsCurrent, waitForReply } from './reply-timing.js';
/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000;
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20;
/** W2-③: default bridge-wide proactive-write caps, aligned with the MIT
 * competitor's actionRatePerMinute(20) / actionRatePerDay(500). */
export const DEFAULT_ACTION_RATE_PER_MINUTE = 20;
export const DEFAULT_ACTION_RATE_PER_DAY = 500;
/** W2-③: proactive-write audit file name, appended under mediaDir (jsonl). */
export const ACTION_AUDIT_FILE = 'qq-actions.log';
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
    ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). */
    pendingSends = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        // Lazy default: read Date.now through a wrapper so an injected clock is
        // optional and callers without one keep the dynamic global lookup (fake
        // timers in tests must keep influencing the wall-clock path).
        this.now = options.now ?? (() => Date.now());
        this.replyRandom = options.random ?? Math.random;
        this.replyWait = options.wait ?? waitForReply;
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        // [dsh-p1] model-selected reply timing
        const parsedTiming = parseReplyTiming(text);
        text = parsedTiming.text;
        const timing = options.replyTiming;
        const guard = { ...timing, isStopping: () => this.ctx.isStopping?.() === true };
        if (timing) {
            const delay = timing.context?.urgent ? 0
                : parsedTiming.waitMs ?? defaultReplyDelayMs(text, timing.context, this.replyRandom);
            options = { ...options, replyTiming: { ...timing,
                bypassPeerWait: parsedTiming.waitMs === 0,
                notBefore: Number.isFinite(timing.notBefore) ? timing.notBefore : this.now() + delay } };
            this.ctx.log('debug', 'reply pacing: chat=' + chatId + ' waitMs=' + Math.max(0, options.replyTiming.notBefore - this.now()));
        }
        const cancelled = sentCount => {
            timing?.onCancelled?.({ chatId, text, sentCount });
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '新消息或停止取消待发回复', data: { segments: sentCount } });
        };
        // [dsh-p1] QQ 回复: a leading [[reply:<message_id>]] turns the first
        // bubble into a real QQ reply and is stripped from the text.
        const replyMarker = /^\s*\[\[reply:(\d{5,})\]\]\s*/.exec(String(text ?? ''));
        if (replyMarker !== null) {
            text = String(text).slice(replyMarker[0].length);
            options = { ...options, replyTo: replyMarker[1] };
        }
        return this.enqueue(chatId, async () => {
            if (!replyIsCurrent(guard)) { cancelled(0); return []; }
            if (text === '' || /^(?:\[不回\]|（不回）|【不回】)$/.test(text.trim())) return [];
            if (timing && !await this.replyWait(Math.max(0, options.replyTiming.notBefore - this.now()), guard)) {
                cancelled(0);
                return [];
            }
            if (!replyIsCurrent(guard)) { cancelled(0); return []; }
            if (!this.ctx.connected()) {
                if (options.queuable === true) {
                    // pipeline-hooks.md #23: the park used to be silent.
                    this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
                    this.queuePendingSend(chatId, text, options);
                    return [];
                }
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected });
                throw new OneBotNotConnectedError();
            }
            const hits = scanSensitive(text, this.ctx.config.sensitivePatterns);
            if (hits.length > 0) {
                this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSensitive, data: { hits: hits.slice(0, 5) } });
            }
            const ids = [];
            let { body, nodes } = extractForwardBlocks(text, '助手');
            // [dsh-p1] splice-leak guard (4.35): drop inbound lines that the
            // followup-splice merged into this reply before they reach anyone.
            const leakGuard = stripSpliceLeaks(body);
            if (leakGuard.removed > 0) {
                this.ctx.log('warn', 'splice-leak guard removed ' + leakGuard.removed + ' line(s) in ' + chatId);
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '剥离拼接泄漏行: ' + leakGuard.removed });
            }
            body = leakGuard.text;
            if (nodes.length > 0) {
                // Passive reply path: [[qq_forward]] blocks inside a turn reply are
                // NOT gated as proactive writes (see the W2-③ 口径 note).
                await this.sendForwardNodes(chatId, nodes);
                ids.push('forward');
            }
            let sentCard = false;
            const threshold = this.ctx.config.textImageThreshold;
            if (threshold > 0 && body.length > threshold) {
                try {
                    const chat = this.ctx.getChat(chatId);
                    const title = chat !== undefined && chat.lastNickname !== ''
                        ? 'To ' + chat.lastNickname
                        : undefined;
                    // [dsh-p1] residue guard (4.46): markers must not bake into the card image.
                    const cardBody = stripMarkerResidue(body);
                    if (cardBody.removed > 0) {
                        this.ctx.log('warn', 'marker-residue guard removed ' + cardBody.removed + ' marker(s) from t2i card in ' + chatId);
                        this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '剥离协议记号残留: ' + cardBody.removed });
                    }
                    const png = renderTextImage(cardBody.text, {
                        title,
                        footerBrand: this.ctx.config.cardFooter,
                        fontFiles: this.ctx.config.fontFiles,
                        fontFamilies: this.ctx.config.fontFamilies,
                    });
                    const b64 = 'base64://' + png.toString('base64');
                    if (b64.length <= this.ctx.config.maxImageBytes) {
                        const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options);
                        if (id !== undefined)
                            ids.push(id);
                        sentCard = true;
                    }
                    else {
                        this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text');
                        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundCardTooLarge });
                    }
                }
                catch (error) {
                    this.ctx.log('warn', 't2i render failed, falling back to text: ' + describeError(error));
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '文字图卡片渲染失败，已降级为文本: ' + describeError(error) });
                }
            }
            if (!sentCard) {
                const plain = stripMarkdown(body);
                if (plain !== '') {
                    // [dsh-p1] A3 bubble split: one line = one bubble, 0.8-1.5s apart.
                    const bubbles = splitBubbles(plain);
                    for (let bi = 0; bi < bubbles.length; bi++) {
                        if (bi > 0 && !await this.replyWait(bubbleDelayMs(bubbles[bi], this.replyRandom), guard)) {
                            cancelled(ids.length);
                            return ids;
                        }
                        if (!replyIsCurrent(guard)) { cancelled(ids.length); return ids; }
                        // [dsh-p1] per-bubble [[reply:id]]: a bubble can quote its own message.
                        let bubbleText = bubbles[bi];
                        let bubbleReply = bi === 0 ? options.replyTo : undefined;
                        const bubbleMarker = /^\s*\[\[reply:(\d{5,})\]\]\s*/.exec(bubbleText);
                        if (bubbleMarker !== null) {
                            bubbleText = bubbleText.slice(bubbleMarker[0].length);
                            bubbleReply = bubbleMarker[1];
                        }
                        // [dsh-p1] residue guard (4.46): no [[reply]]/[[wait]]/[[qq_forward]]
                        // marker may reach a bubble — malformed or misplaced alike.
                        const guarded = stripMarkerResidue(bubbleText);
                        if (guarded.removed > 0) {
                            this.ctx.log('warn', 'marker-residue guard removed ' + guarded.removed + ' marker(s) in ' + chatId);
                            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '剥离协议记号残留: ' + guarded.removed });
                        }
                        bubbleText = guarded.text;
                        if (bubbleText === '')
                            continue;
                        const bubbleOptions = { ...options, replyTo: bubbleReply };
                        const bubbleId = await this.sendMsg(chatId, [{ type: 'text', data: { text: bubbleText } }], bubbleOptions);
                        if (bubbleId !== undefined)
                            ids.push(bubbleId);
                    }
                }
                else {
                    // pipeline-hooks.md #30: the empty-body skip used to be silent.
                    this.ctx.log('debug', '正文为空，未发送: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText });
                }
            }
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '回复已发送', data: { segments: ids.length } });
            return ids;
        });
    }
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    queuePendingSend(chatId, text, options = {}) {
        const queue = this.pendingSends.get(chatId) ?? [];
        if (queue.length >= PENDING_SEND_MAX) {
            queue.shift();
            this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest');
            this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull });
        }
        queue.push({ text, options, sentAt: this.now() });
        this.pendingSends.set(chatId, queue);
    }
    // ── W2-③ proactive-write gate (minute/day caps + audit) ─────────────────
    // 口径（per outbound.ts structure）：「主动写」= 模型/命令经 qq_* 工具发起、
    // 不属于某个入站回合回复链的出站写 —— 即 sendSegments（qq_send_image/voice/
    // video/file/segments）与公开 sendForward（qq_send_forward）。被动回复不受此
    // 闸：sendToChat 整条链（最终回复/interim/错误与命令通知、[[qq_forward]] 块，
    // 后者走未设闸的 sendForwardNodes）由入站 rateLimitPerMinute + B6 队列上限
    // 约束。两类计数都是全桥合计（不分会话）。
    /** Sliding-60s timestamps of allowed proactive writes (bridge-wide). */
    writeActionTimes = [];
    /** Calendar-day (local) counter of allowed proactive writes. */
    writeDayKey = '';
    writeDayCount = 0;
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    auditChain = Promise.resolve();
    /** W1/T5 health snapshot: the write gate's current usage against its
     * limits (minute sliding window pruned at read time; day counter). */
    writeGateStats() {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        const now = this.now();
        const minuteUsed = perMinute > 0
            ? this.writeActionTimes.filter(t => now - t < 60_000).length
            : 0;
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const dayUsed = perDay > 0 && this.writeDayKey === dayKey ? this.writeDayCount : 0;
        return { minuteUsed, minuteLimit: perMinute, dayUsed, dayLimit: perDay };
    }
    /** W2-③: check + consume one proactive-write slot. Returns a non-empty
     * Chinese rejection reason when the write must be dropped (a warn with the
     * chatId and the limit name is logged and the rejection is audited);
     * returns null when allowed (slot consumed). Rejected attempts do not
     * consume quota. */
    writeGateRejectReason(chatId, action) {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        if (perMinute <= 0 && perDay <= 0)
            return null;
        const now = this.now();
        this.writeActionTimes = this.writeActionTimes.filter(t => now - t < 60_000);
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (this.writeDayKey !== dayKey) {
            this.writeDayKey = dayKey;
            this.writeDayCount = 0;
        }
        if (perMinute > 0 && this.writeActionTimes.length >= perMinute) {
            const reason = '写操作频率超限：60 秒内主动写已达 ' + perMinute + ' 次上限（actionRatePerMinute=' + perMinute + '），请稍后再试';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        if (perDay > 0 && this.writeDayCount >= perDay) {
            const reason = '写操作次数超限：今日主动写已达 ' + perDay + ' 次上限（actionRatePerDay=' + perDay + '），明日自动恢复';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        this.writeActionTimes.push(now);
        this.writeDayCount += 1;
        return null;
    }
    /** W2-③: append one proactive-write (or rejection / send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    auditWrite(chatId, action, ok, reason) {
        if (this.ctx.config.actionAuditEnabled === false)
            return;
        const dir = this.ctx.config.mediaDir;
        if (dir === undefined || dir === '')
            return;
        const line = JSON.stringify({ ts: this.now(), chatId, action, ok, reason }) + '\n';
        this.auditChain = this.auditChain.then(async () => {
            await mkdir(dir, { recursive: true });
            await appendFile(join(dir, ACTION_AUDIT_FILE), line, 'utf8');
        }).catch(error => {
            this.ctx.log('warn', '写操作审计写入失败: ' + describeError(error));
        });
    }
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends() {
        if (this.ctx.isStopping())
            return;
        const now = this.now();
        const batch = [];
        for (const [chatId, queue] of this.pendingSends) {
            this.pendingSends.delete(chatId);
            for (const item of queue) {
                if (now - item.sentAt < PENDING_SEND_TTL_MS) {
                    batch.push({ chatId, text: item.text, options: item.options });
                }
                else {
                    // pipeline-hooks.md #25: the TTL drop used to be silent.
                    this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                }
            }
        }
        for (const { chatId, text, options } of batch) {
            void this.sendToChat(chatId, text, { ...options, queuable: true }).catch((error) => {
                this.ctx.log('warn', 'queued resend failed: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) });
            });
        }
    }
    /**
     * Send raw OneBot segments (used by the media tools). W2-③: counts as a
     * proactive write — subject to the minute/day caps and audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments, options = {}) {
        return this.enqueue(chatId, async () => {
            const conversationalMedia = segments.some(s => ['image','record','face','mface'].includes(s.type))
                && segments.every(s => ['text','image','record','face','mface'].includes(s.type));
            const reject = conversationalMedia ? null : this.writeGateRejectReason(chatId, 'send_msg');
            if (reject !== null)
                throw new OneBotActionError(reject);
            try {
                const id = await this.sendMsg(chatId, segments, options);
                this.auditWrite(chatId, 'send_msg', true, '发送成功');
                return id;
            }
            catch (error) {
                this.auditWrite(chatId, 'send_msg', false, '发送失败: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
                throw error;
            }
        });
    }
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    sendChains = new Map();
    /** Serialize work on one chat's send chain. */
    enqueue(chatId, work) {
        const chain = this.sendChains.get(chatId) ?? Promise.resolve();
        const run = chain.then(work, work);
        const tail = run.catch(() => undefined);
        this.sendChains.set(chatId, tail);
        void tail.then(() => {
            if (this.sendChains.get(chatId) === tail)
                this.sendChains.delete(chatId);
        });
        return run;
    }
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId) {
        return this.sendChains.get(chatId) ?? Promise.resolve();
    }
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        // [dsh-p1] check fresh peer-input state before every text/media bubble.
        if (options.replyTiming?.beforeSend && !await options.replyTiming.beforeSend({ immediate: options.replyTiming.bypassPeerWait === true })) {
            options.replyTiming.onCancelled?.();
            if (options.throwIfSuperseded) throw new Error('reply_superseded_by_followup');
            return undefined;
        }
        const ref = splitChatId(chatId);
        const params = {};
        let target;
        try {
            target = Number(ref.target);
            if (!Number.isFinite(target))
                throw new Error('bad target');
        }
        catch {
            throw new OneBotActionError('invalid chat target: ' + chatId);
        }
        if (ref.kind === 'group')
            params.group_id = target;
        else
            params.user_id = target;
        params.message = segments;
        if (options.replyTo !== undefined) {
            params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments];
        }
        const data = await this.ctx.call('send_msg', params, chatId);
        this.ctx.onTextSent?.(chatId, segments);
        const id = data.message_id !== undefined ? String(data.message_id) : undefined;
        if (id !== undefined)
            this.ctx.recordSent?.(chatId, id);
        return id;
    }
    /** Send [[qq_forward]] nodes as a merged-forward message (proactive write
     * from the qq_send_forward tool). W2-③: subject to the minute/day caps
     * and audited; the passive [[qq_forward]] blocks inside sendToChat bypass
     * this gate via sendForwardNodes. */
    async sendForward(chatId, nodes) {
        const reject = this.writeGateRejectReason(chatId, 'send_forward_msg');
        if (reject !== null)
            throw new OneBotActionError(reject);
        try {
            await this.sendForwardNodes(chatId, nodes);
            this.auditWrite(chatId, 'send_forward_msg', true, '发送成功');
        }
        catch (error) {
            this.auditWrite(chatId, 'send_forward_msg', false, '发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
            throw error;
        }
    }
    /** Ungated merged-forward send (shared by the gated tool path and the
     * passive [[qq_forward]] blocks inside sendToChat). */
    async sendForwardNodes(chatId, nodes) {
        const ref = splitChatId(chatId);
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        // [dsh-p1] residue guard (4.46): protocol markers must not ride inside
        // forward node content either (gated tool path and passive blocks).
        const cleaned = [];
        for (const node of nodes) {
            const stripped = stripMarkerResidue(node.content);
            if (stripped.removed > 0)
                this.ctx.log('warn', 'marker-residue guard removed ' + stripped.removed + ' marker(s) from forward node in ' + chatId);
            if (stripped.text !== '')
                cleaned.push({ ...node, content: stripped.text });
        }
        const messages = cleaned.map(node => ({
            type: 'node',
            data: {
                uin: this.ctx.selfId() || this.ctx.config.botQQ,
                name: node.name.slice(0, 24),
                content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
            },
        }));
        if (ref.kind === 'group') {
            await this.ctx.call('send_forward_msg', { group_id: target, messages }, chatId);
        }
        else {
            await this.ctx.call('send_private_forward_msg', { user_id: target, messages }, chatId);
        }
    }
}

// -- [dsh-p1] A3 bubble split -----------------------------------------------------------
// A reply line = one QQ bubble. The persona asks the model to split emotional
// replies into 2-3 lines; here each line is sent separately, 0.8-1.5s apart.
// Blank lines are dropped, at most 4 bubbles are sent (the rest merge into the
// last one), and replyTo only rides on the first bubble.
import { stripSpliceLeaks } from './splice-guard.js';
const BUBBLE_MAX = 4;
const BUBBLE_DELAY_MIN_MS = 800;
const BUBBLE_DELAY_MAX_MS = 1500;

// -- [dsh-p1] protocol-marker residue guard (v2.23, 4.46) --------------------------------
// [[reply…]] / [[wait…]] / [[qq_forward…]] are plugin protocol, never bubble
// text. Well-formed leading forms are parsed earlier (reply-to before the
// enqueue, parseReplyTiming for wait, extractForwardBlocks for forward
// blocks); ANY marker still in the text — malformed like the 2026-10-25
// `[[reply]]— no need.` leak, or well-formed but misplaced mid-text — is
// stripped here so a control marker can never reach a bubble, a t2i card or
// a forward node.
const MARKER_RESIDUE_LEADING_RE = /^[ \t]*\[\[\/?(?:reply|wait|qq_forward)(?::[^\]\n]*)?\]\][ \t]*/gim;
const MARKER_RESIDUE_RE = /\[\[\/?(?:reply|wait|qq_forward)(?::[^\]\n]*)?\]\]/gi;
export function stripMarkerResidue(text) {
    const raw = String(text ?? '');
    let removed = 0;
    let out = raw.replace(MARKER_RESIDUE_LEADING_RE, () => { removed += 1; return ''; });
    out = out.replace(MARKER_RESIDUE_RE, () => { removed += 1; return ''; });
    return { text: out, removed };
}

export function splitBubbles(text) {
    const raw = String(text).trim();
    // [dsh-p1] the persona may choose not to answer at all; send nothing.
    if (raw === '[不回]' || raw === '（不回）' || raw === '【不回】')
        return [];
    const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    if (lines.length === 0)
        return [];
    if (lines.length === 1)
        return [lines[0]];
    const bubbles = lines.slice(0, BUBBLE_MAX);
    if (lines.length > BUBBLE_MAX)
        bubbles[BUBBLE_MAX - 1] += '\n' + lines.slice(BUBBLE_MAX).join('\n');
    return bubbles;
}

function randomDelayMs(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function bubbleSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
