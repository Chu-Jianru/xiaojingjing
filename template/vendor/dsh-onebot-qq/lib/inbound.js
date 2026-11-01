/**
 * Inbound pipeline (M2-D1-PR4): the OneBot-11 → agent-turn path. Two pieces:
 * `normalizeOneBot11`, the pure protocol-adaptation seam that reduces one
 * raw message event to a neutral NormalizedInbound (null = not processable),
 * and `InboundPipeline`, which runs the normalized message through the
 * policy gate → mention gate → command router → media resolution →
 * quote/forward expansion → rate limit → turn dispatch. Extracted verbatim
 * from bridge.ts — gate order, prefix assembly, media annotation and
 * rate-limit behavior are identical; the bridge keeps same-name facade
 * methods so the onFrame call site, the command table and the M2-T0
 * pipeline-order overrides keep working unchanged.
 * @module dsh-onebot/inbound
 */
import { readFile, writeFile } from 'node:fs/promises';
import { GROUP_BATCH, explicitGroupAddress } from './group-conversation.js';
import { extForInboundName } from './media.js';
import { transcriptLabel } from './stt.js';
import { cqUnescape, detectMention, parseMessage, segmentText } from './cq.js';
import { buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, groupAllowed, RESTRICTED_PREFIX, sanitizeNickname, wrapUserMessage, } from './chat.js';
import { describeError } from './errors.js';
import { noteMessage, renderMood } from './mood.js';
import { computeStatus, loadSleep } from './sleep.js';
import { renderRules } from './rules.js';
import { renderProfileBlock } from './profiles.js';
import { transcribeVoice, nativeTranscript } from './voice-fallback.js';
import { renderCommitments } from './companionship.js';
import { noteForAutoLearn } from './auto-learn.js';
import { noteImage, lookImage, rememberImage, unseenImageAnnotation } from './vision.js';
import { ocrImageFile } from './ocr.js';
import { matchSticker } from './sticker-index.js';
import { recallHotMemes } from './meme-recall.js';
import { currentTrace, TRACE_REASONS } from './trace.js';
import { appendMemory, notesBlock, recallMemoryBlock } from './memory-store.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = (() => {
    let d = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(d, 'bot-home')) && existsSync(join(d, 'qq-persona'))) return d;
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    return d;
})();

const OCR_CACHE = new Map();
const OCR_CACHE_MS = 60_000;

/**
 * Reduce one raw OneBot 11 event to the neutral inbound shape, or null when
 * the event is not a processable chat message (notice/recall, meta, unknown
 * message_type, or a missing sender id). Pure: no I/O, no state — the
 * connection's self_id learning stays in the transport layer and the
 * ignoreSelf comparison stays in the pipeline (both are runtime state).
 */
export function normalizeOneBot11(event) {
    const messageType = event.message_type;
    if (messageType !== 'private' && messageType !== 'group')
        return null;
    const userId = String(event.user_id ?? '');
    if (userId === '')
        return null;
    const kind = messageType === 'private' ? 'private' : 'group';
    const groupId = kind === 'group' ? String(event.group_id ?? '') : '';
    const chatId = buildChatId(kind, kind === 'private' ? userId : groupId);
    const segments = Array.isArray(event.message) ? event.message : undefined;
    const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '');
    const messageId = event.message_id === undefined || event.message_id === null
        ? undefined
        : String(event.message_id);
    const parsed = parseMessage(segments, raw);
    const sender = event.sender ?? {};
    const nickname = typeof sender.card === 'string' && sender.card !== ''
        ? sender.card
        : typeof sender.nickname === 'string' && sender.nickname !== ''
            ? sender.nickname
            : userId;
    return {
        kind,
        userId,
        groupId,
        chatId,
        segments,
        raw,
        text: parsed.text,
        media: parsed.media,
        replyId: parsed.replyId,
        forwardId: parsed.forwardId,
        messageId,
        nickname,
        voiceCallAlive: typeof event.dshVoiceCallAlive === 'function' ? event.dshVoiceCallAlive : undefined,
        catchup: event.catchup === true,
        groupBatch: event[GROUP_BATCH],
        listeningRevision: Number.isInteger(event.dshListeningRevision) ? event.dshListeningRevision : undefined,
        listeningBuffered: event.dshListeningReleased === true,
        listeningMergedIds: Array.isArray(event.dshListeningMergedIds) ? event.dshListeningMergedIds.map(String) : [],
        catchupSaidAtMs: event.catchup === true ? (Number(event?.time) || 0) * 1000 : 0,
    };
}
/** W2-②: default (chatId, message_id) dedup window, aligned with the MIT
 * competitor's dedupWindowSeconds (300s). */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** [dsh-p1] v2.11 防雪崩限流：队列积压到这么多回合才丢新消息（唯一丢弃条件）。
 * 15 轮按她的回合耗时约等于连续 5 分钟回不完；双人快聊的突发（≤10 条）
 * 永远够不着，@ 刷屏雪崩才生效。 */
export const PENDING_TURN_CAP = 15;
/** W2-②: max entries kept in the dedup window map (LRU-evicted beyond this)
 * so a flood of distinct message_ids cannot grow memory unbounded. */
export const DEDUP_MAX_ENTRIES = 4096;
/**
 * The inbound pipeline: one normalized OneBot event → one agent turn.
 * Owns media resolution, quote/forward expansion and the B7 rate limit;
 * turn dispatch stays behind the context callback.
 */
export class InboundPipeline {
    ctx;
    /** W2-② dedup knobs (see InboundPipelineOptions). */
    dedupMaxEntries;
    now;
    /** W2-② dedup window state: "chatId#messageId" → first-seen epoch ms, in
     * insertion order (Map) so the oldest entry is the LRU victim. */
    seenMessages = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.dedupMaxEntries = options.dedupMaxEntries ?? DEDUP_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
    }
    /** W1/T5 health snapshot: how many message_ids are currently held in the
     * dedup window (LRU-capped; see DEDUP_MAX_ENTRIES). */
    get dedupWindowEntries() {
        return this.seenMessages.size;
    }
    async processInbound(inbound) {
        // [dsh-p1] delivery result: release dedup reservations on rejection/error.
        if (inbound.messageId === undefined || inbound.messageId === null || inbound.messageId === '')
            return await this.processInboundBody(inbound);
        const key = inbound.chatId + '#' + inbound.messageId;
        this.pendingDeliveries ??= new Set();
        if (this.pendingDeliveries.has(key))
            return false;
        if (this.duplicated(inbound))
            return;
        this.pendingDeliveries.add(key);
        try {
            const handled = await this.processInboundBody(inbound);
            if (handled === false)
                this.seenMessages.delete(key);
            return handled;
        }
        catch (error) {
            this.seenMessages.delete(key);
            throw error;
        }
        finally {
            this.pendingDeliveries.delete(key);
        }
    }
    async processInboundBody(inbound) {
        const { kind, userId, groupId, chatId } = inbound;
        if (this.ctx.config.ignoreSelf && this.ctx.selfId() !== '' && userId === this.ctx.selfId()) {
            // pipeline-hooks.md #5: this drop used to be fully silent.
            this.ctx.log('debug', '机器人自己的消息已忽略: ' + chatId);
            currentTrace()?.emit('self', { ok: false, reason: TRACE_REASONS.inboundSelf });
            return;
        }
        const policy = this.ctx.policy;
        if (kind === 'private') {
            // [dsh-p1] friends can DM: admins as before, plus anyone on the
            // bot's friend list (cached; fail-closed when the query fails).
            if (!dmAllowed(userId, policy) && !(await isFriendSender(this.ctx, userId))) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                // v2.23 contract: false = "dropped, NOT handled" — the catch-up
                // water mark must not record it (a gate-dropped message that
                // got marked seen could never be replayed again).
                return false;
            }
        }
        else {
            if (!groupAllowed(groupId, policy)) {
                this.ctx.log('debug', 'ignoring group message from non-allowed group ' + groupId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundGroupBlocked });
                return false;
            }
        }
        // [dsh-p1] being called by name counts as being addressed ("小鲸鲸""鲸鱼""小鱼"…)
        const NAME_CALLS = ['小鲸鲸', '鲸鱼娘', '小鲸鱼', '蓝鲸鱼', '蓝鲸', '鲸鱼', '鲸鲸', '小鲸', '小鱼', '臭鱼'];
        const calledByName = kind === 'group' && NAME_CALLS.some(name => inbound.text.includes(name) || inbound.raw.includes(name));
        // [dsh-p1] 「鱼」单独喊也算叫她；避开摸鱼/钓鱼/鱼丸这类日常词。
        const FISH_TRAPS = ['摸鱼', '钓鱼', '鱼丸', '鱼香', '鱼片', '鱼塘', '咸鱼', '飞鱼', '鱼刺', '鱼头', '鱼尾', '鱼缸', '鱼干', '鱼鳞', '鱼饵', '鲸鱼', '鱿鱼', '金鱼', '木鱼', '酸菜鱼', '水煮鱼', '鱼豆腐', '鱼块', '鱼粉', '鱼饼'];
        const fishCall = kind === 'group' && (() => {
            const text = inbound.text.trim();
            if (!text.includes('鱼') || FISH_TRAPS.some(word => text.includes(word)))
                return false;
            return text.length <= 8 || text.startsWith('鱼') || text.endsWith('鱼');
        })();
        const mentioned = detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ) || calledByName || fishCall;
        const addressedDirectly = kind === 'group' ? explicitGroupAddress(inbound, this.ctx.selfId(), this.ctx.config.botQQ) || calledByName || fishCall : mentioned;
        // [dsh-p1] rules are relevance too: a trigger match alone lets the message in.
        const rulesBlockPreview = await renderRules(this.ctx.config.mediaDir, { text: inbound.text, chatId });
        let followUpFlag = false;
        const groupAdmins = [...new Set([
            ...(Array.isArray(this.ctx.config?.adminUsers) ? this.ctx.config.adminUsers : []),
            ...(Array.isArray(this.ctx.policy?.adminUsers) ? this.ctx.policy.adminUsers : []),
        ].map(String))];
        if (kind === 'group') {
            if (mentioned || addressedDirectly) {
                noteGroupMention(chatId);
                // [dsh-p1] the person who just called her will very likely continue
                // talking TO her: let their next two messages through even if the
                // wake window is used up by others.
                followUpCaller.set(chatId, { userId, at: Date.now(), left: 4 }); // v2.51: @ 完通常还会接着说，给 4 条
            }
            else if (inbound.catchup === true) {
                // [dsh-p1] v2.24: replayed backlog context rides with its anchor —
                // catch-up already selected it (anchor ± context window); peek /
                // turn-cap would drop exactly the context the replay exists to
                // provide, and backlog must not spend the live hourly budget.
                this.ctx.log('debug', 'catch-up context in ' + groupId + ': replayed non-mention message rides with its anchor');
                currentTrace()?.emit('mention', { ok: true, reason: '补回上下文：随锚点放行' });
            }
            else {
                // [dsh-p1] turn cap: hourly budget for undirected passes (wake window /
                // follow-up / rule trigger / random peek). Direct mentions and
                // the admin never pass through here, so they are never capped.
                if (!groupAdmins.includes(String(userId)) && !turnCapAllows(groupId)) {
                    this.ctx.log('debug', 'turn cap reached in ' + groupId);
                    currentTrace()?.emit('mention', { ok: false, reason: '群回合上限：本小时放行额度用完' });
                    return;
                }
                const follow = followUpCaller.get(chatId);
                const continuing = follow !== undefined && follow.userId === userId
                    && follow.left > 0 && Date.now() - follow.at < 120_000;
                if (continuing) {
                    follow.left -= 1;
                    followUpFlag = true;
                    this.ctx.log('debug', 'follow-up from caller in ' + groupId);
                    currentTrace()?.emit('mention', { ok: true, reason: '续话：刚 @ 她的人接着说' });
                }
                else if (rulesBlockPreview !== '') {
                    // [dsh-p1] a rule trigger is relevance: let it through even un-@.
                    this.ctx.log('debug', 'rule trigger: unmentioned group message let through in ' + groupId);
                    currentTrace()?.emit('mention', { ok: true, reason: '规则触发：放行未 @ 的群消息' });
                }
                else if (groupAdmins.includes(String(userId))) {
                    // [dsh-p1] the admin talking in the group always reaches her,
                    // even without an @ — otherwise a normal back-and-forth dies.
                    this.ctx.log('debug', 'admin message in group let through in ' + groupId);
                    currentTrace()?.emit('mention', { ok: true, reason: '老大在群里说话：放行' });
                }
                else if (this.ctx.config.requireMention && !peekAllows(this.ctx, chatId, userId, inbound.text)) {
                    this.ctx.log('debug', 'ignoring unmentioned group message in ' + groupId);
                    currentTrace()?.emit('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned });
                    return;
                }
                else {
                    // [dsh-p1] group peek: let the agent decide whether to answer.
                    this.ctx.log('debug', 'peek: unmentioned group message let through in ' + groupId);
                    currentTrace()?.emit('mention', { ok: true, reason: '旁听：放行未 @ 的群消息' });
                }
            }
        }
        // M3-D5 identity whitelist: the sanitized nickname feeds the single-line
        // prefix, the <user_message> attribute and lastNickname — one value,
        // provably line-safe and markup-free for all three surfaces.
        const nickname = sanitizeNickname(inbound.nickname);
        // B8c: lazy idle eviction before processing each inbound message (flush →
        // dispose → remove; the mapping is kept so the chat can resume).
        await this.ctx.sweepIdleChats();
        // A new user message starts a fresh reply cycle: drop any unmerged loop
        // residue from the previous cycle so interims never merge across turns.
        const priorChat = this.ctx.getChat(chatId);
        if (priorChat !== undefined) {
            priorChat.loopBuffer = [];
            priorChat.loopPending = null;
        }
        // Fire-and-forget temp cleanup on each inbound.
        void this.ctx.media.cleanupExpired();
        // C6a: route slash commands BEFORE any media/quote I/O — a message that
        // happens to carry media must not pay for downloads or get_msg calls just
        // to be consumed as a command (admin-only; unknown /-words still fall
        // through to the model). The most recent inbound image is registered from
        // parsed.media up front so /ocr still sees it (resolved lazily there).
        for (const ref of inbound.media) {
            if (ref.kind === 'image')
                this.ctx.getSettings(chatId).pendingImageRef = ref;
        }
        if (await this.ctx.tryHandleCommand(chatId, inbound.text, userId, nickname)) {
            currentTrace()?.emit('command', { ok: true, reason: TRACE_REASONS.inboundCommand });
            return;
        }
        const body = await this.ctx.buildBody(inbound.text, inbound.media, chatId, inbound.messageId);
        let quote = '';
        if (inbound.replyId !== undefined) {
            quote = await this.ctx.expandQuote(inbound.replyId);
        }
        let forward = '';
        if (inbound.forwardId !== undefined) {
            const expansion = await this.expandForward(inbound.forwardId);
            forward = expansion.text;
            if (expansion.media.length > 0) {
                // Forward-embedded images ride the same buildBody pipeline (their
                // '[图片]' placeholders are inline in the expansion text). Preserve
                // the pre-routing /ocr ref so a direct image in the same message
                // stays the /ocr target.
                const pending = this.ctx.getSettings(chatId).pendingImageRef;
                forward = await this.ctx.buildBody(expansion.text, expansion.media, chatId, '');
                this.ctx.getSettings(chatId).pendingImageRef = pending;
            }
        }
        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';
        // [dsh-p1] `记住：…` in the admin DM stores a shared note for every chat.
        if (kind === 'private' && isAdmin && await teachSharedNote(this.ctx, inbound.text))
            return;
        if (this.rateLimited(chatId, { isAdmin, catchup: inbound.catchup === true }))
            return false;
        // M3-D5: the whole sender-controlled payload (body + quote/forward
        // expansions) enters the prompt inside the <user_message> boundary, so
        // forged prefix lines, restricted-member tags and system-prompt-like text
        // stay pure data. The framework-generated group prefix and
        // RESTRICTED_PREFIX remain outside — the only trusted metadata.
        const content = [forward, quote, body].filter(part => part !== '').join('\n');
        if (content.trim() === '') {
            // pipeline-hooks.md #17: this drop used to be fully silent.
            this.ctx.log('debug', '消息展开后无有效文本内容，已丢弃: ' + chatId);
            currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.inboundEmptyContent });
            return;
        }
        let final = wrapUserMessage(content, userId, nickname);
        // [dsh-p1] shared notes ride outside the user boundary (trusted metadata).
        const sharedNotes = await getSharedNotes(this.ctx.config.mediaDir);
        if (sharedNotes !== '')
            final = '[共同记忆]\n' + sharedNotes + '\n[/共同记忆]\n' + final;
        // [dsh-p1] long-term memory v2: isolated recall; kind=note rides [共同记忆] instead.
        const recalled = await recallMemoryBlock(this.ctx.config.mediaDir, chatId, inbound.text);
        if (recalled !== '')
            final = '[记忆]\n' + recalled + '\n[/记忆]\n' + final;
        // [dsh-p1] hot memes: inject only the entries this message hits.
        const memed = await recallHotMemes(inbound.text);
        if (memed !== '')
            final = '[梗]\n' + memed + '\n[/梗]\n' + final;
        // [dsh-p1] mood: a continuous state, not a per-turn act. Update it from
        // the message itself (insults/praise/everyday chat), then inject it.
        await noteMessage(this.ctx.config.mediaDir, inbound.text, userId, { chatId });
        const moodBlock = await renderMood(this.ctx.config.mediaDir, userId, { chatId });
        if (moodBlock !== '')
            final = moodBlock + '\n' + final;
        // [dsh-p1] sleep phase, plus how tired she plausibly is right now.
        const sleepNow = await loadSleep(this.ctx.config.mediaDir);
        const sleepPhase = computeStatus(sleepNow, Date.now());
        let sleepLabel = sleepPhase === 'asleep' ? '睡觉中'
            : sleepPhase === 'falling' ? '正犯困，快睡着了'
                : (sleepPhase === 'winding' ? '睡前时段' : '醒着');
        const justSlept = Number(sleepNow.justSleptAt) > 0 && Date.now() - Number(sleepNow.justSleptAt) < 60_000;
        if (sleepPhase === 'asleep' && justSlept) {
            sleepLabel = '刚被叫去睡';
        }
        let sleepNote = '';
        // [dsh-p1] v2.48: 原来这段嵌在 sleepPhase !== 'asleep' 里，永远进不来，
        // 睡前那一轮反而拿不到「回一句晚安就安静」，于是她照样写一长段。
        if (sleepPhase === 'asleep') {
            if (justSlept)
                sleepNote = '（回一句晚安就安静，不用长）';
        }
        else if (sleepPhase === 'falling')
            sleepNote = '（你正在入睡，十分钟内没人打扰就睡着了；这一句有人说话就把你弄醒了，正常接）';
        else if (Number(sleepNow.noSleepUntil) > Date.now())
            sleepNote = '（老大说今天不睡，少提困）';
        else if (Number(sleepNow.wokenAt) > 0 && Date.now() - Number(sleepNow.wokenAt) < 30 * 60_000)
            sleepNote = '（刚被叫醒，可以迷糊、说困）';
        else if (Number(sleepNow.wakeAt) > 0 && Date.now() - Number(sleepNow.wakeAt) > 3 * 3_600_000)
            sleepNote = '（醒挺久了，可以说想睡，也可以不说）';
        final = '[作息] 现在：' + sleepLabel + sleepNote + '\n' + final;
        // [dsh-p1] reply rhythm: explicit per-turn bubble-count suggestion.
        const rhythm = inbound.groupBatch ? '' : rhythmHint();
        if (rhythm !== '')
            final = '[节奏] ' + rhythm + '\n' + final;
        const listeningHint = this.ctx.listeningHint?.(chatId, inbound.text, inbound.listeningBuffered) ?? '';
        if (listeningHint !== '') final = listeningHint + '\n' + final;
        // [dsh-p1] reaction context: break repeated face/sticker-only replies.
        const reactionHint = this.ctx.reactionHint?.(chatId, isAdmin) ?? '';
        if (reactionHint !== '') final = reactionHint + '\n' + final;
        // [dsh-p1] rules: trusted instructions the admin set through chat.
        const rulesBlock = kind === 'group'
            ? rulesBlockPreview
            : await renderRules(this.ctx.config.mediaDir, { text: inbound.text, chatId });
        if (rulesBlock !== '')
            final = rulesBlock + '\n' + final;
        // [dsh-p1] this message continues what the caller just said to her.
        if (followUpFlag)
            final = '[接着你的话]\n' + final;
        // [dsh-p1] per-person profile: what you already know about this speaker.
        const profileBlock = await renderProfileBlock(this.ctx.config.mediaDir, userId, nickname);
        const commitments = await renderCommitments(this.ctx.config.mediaDir, chatId, userId);
        if (commitments) final = commitments + "\n" + final;
        if (profileBlock !== '')
            final = profileBlock + '\n' + final;
        // [dsh-p1] light auto-learning (pure rules, no model call): a style summary
        // every 8 messages, plus explicit first-person facts into memories.
        // Fire-and-forget: never blocks or fails the turn.
        void noteForAutoLearn(this.ctx.config.mediaDir, {
            chatId,
            userId,
            nickname,
            text: inbound.text,
            isGroup: kind === 'group',
            isAdmin,
            hasFace: inbound.segments !== undefined
                && inbound.segments.some(seg => seg?.type === 'face' || seg?.type === 'mface'),
            hasMedia: inbound.segments !== undefined
                && inbound.segments.some(seg => ['face', 'mface', 'image', 'record', 'video'].includes(seg?.type)),
        }, message => this.ctx.log('info', message));
        // [dsh-p1] reply support: expose this message's id for [[reply:<id>]].
        if (inbound.messageId !== undefined && inbound.messageId !== '')
            final = '[本条ID:' + inbound.messageId + ']\n' + final;
        // [dsh-p1] catch-up source tag; quoting is a contextual choice.
        if (inbound.catchup === true)
            final = '[补回]\n' + final;
        // [dsh-p1] affective nicknames: 「臭鱼」是轻微赌气/撒娇的爱称，不是真骂。
        if (inbound.text.includes('臭鱼'))
            final = '[称呼:臭鱼｜轻微赌气或撒娇的爱称，不是真骂]\n' + final;
        if (kind === 'group') {
            final = buildGroupMessagePrefix(nickname, userId, addressedDirectly, inbound.catchupSaidAtMs) + final;
            if (!isAdmin && this.ctx.config.restrictedMemberPrefix) {
                final = RESTRICTED_PREFIX + final;
            }
        }
        const role = isAdmin ? 'admin' : 'member';
        // T2 (P1): the busy-turn policy seam runs AFTER every gate above (dedup /
        // self / policy / mention / command / rate-limit) and only around the
        // final dispatch — a queued or steered message has already paid for its
        // rate-limit slot and passed the whole pipeline. `plain` = no media, no
        // quote, no forward: the only shape eligible for steer (media-bearing
        // messages always queue so the full media pipeline runs for their own
        // turn). Seam absent = pre-T2 behavior (straight dispatch).
        if (inbound.voiceCallAlive && !inbound.voiceCallAlive()) return false;
        this.ctx.observeJournal?.(inbound);
        // [dsh-p1] collect prepared, sender-scoped group content before dispatch.
        if (kind === 'group' && inbound.groupBatch) {
            inbound.groupBatch.parts.push({ final, role, nickname, userId, messageId: String(inbound.messageId), addressed: addressedDirectly });
            return true;
        }
        const plain = inbound.media.length === 0 && inbound.replyId === undefined && inbound.forwardId === undefined;
        if (this.ctx.interceptBusyTurn !== undefined
            && await this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain, inbound.listeningRevision, userId)) {
            return;
        }
        await this.ctx.dispatchFollowup(chatId, final, role, nickname, inbound.listeningRevision, userId);
        return true;
    }
    /** W2-②: (chatId, message_id) sliding-window dedup against OneBot
     * re-delivery (reconnect replay / ws retry). Runs before every other gate
     * so a redelivered message can neither re-trigger a command nor reset the
     * loop residue; only events that normalize to processable chat messages
     * reach this — notice/meta/request events never enter the pipeline (see
     * docs/m1-characterization/pipeline-hooks.md #1/#3). Events without a
     * message_id are not deduped (nothing to key on). Window entries live in
     * an LRU-capped map: hits refresh recency (keeping the first-seen time, so
     * the window opens at first delivery), the oldest entry is evicted beyond
     * the cap. Returns true when the delivery must be silently skipped. */
    duplicated(inbound) {
        const windowSeconds = this.ctx.config.dedupWindowSeconds ?? DEFAULT_DEDUP_WINDOW_SECONDS;
        if (windowSeconds <= 0)
            return false;
        if (inbound.messageId === undefined || inbound.messageId === '')
            return false;
        const now = this.now();
        const key = inbound.chatId + '#' + inbound.messageId;
        const seenAt = this.seenMessages.get(key);
        if (seenAt !== undefined && now - seenAt < windowSeconds * 1000) {
            this.seenMessages.delete(key);
            this.seenMessages.set(key, seenAt);
            this.ctx.log('debug', 'dedup hit in ' + inbound.chatId + ': message_id ' + inbound.messageId
                + ' redelivered within ' + windowSeconds + 's window, message skipped');
            currentTrace()?.emit('dedup', { ok: false, reason: TRACE_REASONS.inboundDedup });
            return true;
        }
        this.seenMessages.delete(key);
        while (this.seenMessages.size >= this.dedupMaxEntries) {
            const oldest = this.seenMessages.keys().next().value;
            if (oldest === undefined)
                break;
            this.seenMessages.delete(oldest);
        }
        this.seenMessages.set(key, now);
        return false;
    }
    /** [dsh-p1] v2.11 防雪崩限流（4.37）：按分钟丢消息退役——线上阈值 10 条/分钟，
     * 正常快聊就会越线，越线后的消息被静默漏掉还播报「慢点慢点」固定话术。
     * 现在唯一的丢弃条件是排队积压：pendingTurnRoles 已积到 PENDING_TURN_CAP
     * 轮（她连续 5 分钟以上回不完）才丢最新一条，防 @ 刷屏把回合队列打穿。
     * 补回消息（catchup）和老大永不丢；丢弃只记 trace，不发任何提示。 */
    rateLimited(chatId, options = {}) {
        if (options.catchup === true || options.isAdmin === true)
            return false;
        const chat = this.ctx.getChat(chatId);
        if (chat === undefined)
            return false;
        const pending = chat.pendingTurnRoles?.length ?? 0;
        if (pending < PENDING_TURN_CAP)
            return false;
        currentTrace()?.emit('ratelimit', { ok: false, reason: '积压 ' + pending + ' 轮，防雪崩丢弃新消息' });
        return true;
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    async buildBody(text, media, chatId, messageId = '') {
        if (media.length === 0)
            return text;
        let out = text;
        // 一条消息最多自动 OCR 两张图，别让相册把 turn 拖死。
        let ocrBudget = 2;
        for (const ref of media) {
            const placeholder = placeholderFor(ref);
            const idx = out.indexOf(placeholder);
            const autoOcr = ref.kind === 'image' && ocrBudget > 0;
            if (autoOcr) ocrBudget -= 1;
            const annotation = await this.resolveMediaRef(ref, chatId, messageId, { autoOcr });
            if (idx >= 0 && annotation !== '') {
                out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length);
            }
            else if (idx >= 0) {
                // pipeline-hooks.md #10: a failed resolution used to leave the
                // placeholder silently unresolved.
                this.ctx.log('debug', '媒体解析失败，占位符保留原文: ' + placeholder);
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.mediaResolveFailed });
            }
        }
        return out;
    }
    /** Resolve one media ref to a text annotation with a local path. */
    async resolveMediaRef(ref, chatId, messageId = '', options = {}) {
        if (ref.kind === 'file') {
            return await this.resolveNasFile(ref);
        }
        // [dsh-p1] voice: prefer QQ's own speech-to-text, fall back to whisper.
        if (ref.kind === 'voice' && messageId !== '') {
            try {
                const ptt = await Promise.race([this.ctx.call('fetch_ptt_text', { message_id: messageId }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('native_stt_timeout')), 3500); timer.unref?.(); })]);
                const spoken = nativeTranscript(ptt);
                if (spoken !== '')
                    return '[语音]「' + spoken + '」';
            }
            catch (error) {
                this.ctx.log('debug', 'fetch_ptt_text failed: ' + describeError(error));
            }
        }
        const resolved = await this.ctx.media.resolve(ref, async (kind, file) => {
            if (kind === 'image') {
                const data = await this.ctx.call('get_image', { file });
                return { url: data.url, file: data.file };
            }
            if (kind === 'voice') {
                const data = await this.ctx.call('get_record', { file, out_format: 'mp3' });
                return { file: data.file };
            }
            return undefined;
        });
        if (resolved === undefined)
            return '';
        switch (resolved.kind) {
            case 'image': {
                // Remember the most recent inbound image for /ocr (survives /new);
                // consume the pre-routing pending ref so /ocr never re-resolves it.
                const settings = this.ctx.getSettings(chatId);
                settings.lastImagePath = resolved.path;
                settings.pendingImageRef = undefined;
                rememberImage(chatId, resolved.path);
                let autoVision = false;
                if (options.autoOcr !== false) {
                    const sticker = await this.tryMatchSticker(resolved.path);
                    if (sticker !== null) {
                        const meaning = String(sticker.meaning ?? '').trim();
                        return '[图片:' + resolved.path + ']（你认出来了：这是你的表情包「'
                            + sticker.name + '」'
                            + (meaning === '' ? '' : '，含义：' + meaning)
                            + '）';
                    }
                    // [dsh-p1] vision (P3): background-describe this image
                    // (fire-and-forget, never blocks the turn)
                    autoVision = noteImage(chatId, resolved.path, (level, message) => this.ctx.log(level, message));
                    const ocr = await this.tryOcrImage(resolved.path);
                    if (ocr !== '') {
                        // [dsh-p1] v2.61: 别让 OCR 抢跑——先等画面描述，字只作补充
                        // （否则她只会念到一个 “K”，然后过一会儿才“哦原来是小白猪”）
                        try {
                            const seenWithOcr = await lookImage(chatId, resolved.path, (level, message) => this.ctx.log(level, message));
                            if (seenWithOcr && seenWithOcr.text)
                                return '[图片:' + resolved.path + ']（你看过这张图，画的是：' + seenWithOcr.text + '；图里的字：' + ocr + '）';
                        }
                        catch { /* vision down: fall back to the OCR-only note */ }
                        return unseenImageAnnotation(resolved.path, ocr);
                    }
                }
                // [dsh-p1] v2.09b: local vision — answer rides the annotation.
                // Cache hit is instant; a miss waits briefly (first describe of
                // a fresh image is already running in the background via
                // noteImage, so this usually only pays the tail of it).
                if (autoVision) {
                    try {
                        const seen = await lookImage(chatId, resolved.path, (level, message) => this.ctx.log(level, message));
                        if (seen && seen.text)
                            return '[图片:' + resolved.path + ']（你看过这张图，画的是：' + seen.text + '）';
                    }
                    catch { /* vision down: fall through to the bare annotation */ }
                }
                return unseenImageAnnotation(resolved.path);
            }
            case 'voice': {
                try {
                    const spoken = await transcribeVoice(resolved.path, this.ctx.config.mediaDir);
                    if (spoken) return '[语音]「' + spoken + '」';
                } catch { this.ctx.log('debug', 'local voice recognition unavailable'); }
                return '[语音：这条未识别出内容，不能据此判断永久听不到语音]';
            }
            case 'video':
                return '[视频:' + resolved.path + ']';
            default:
                return '[文件:' + resolved.path + ']';
        }
    }
    /** 认表情包指纹；命中返回 {file,name,meaning,distance}，否则 null。 */
    async tryMatchSticker(path) {
        try {
            const matched = await matchSticker({
                path,
                mediaDir: this.ctx.config.mediaDir,
                personaDir: process.env.DSH_PERSONA_DIR ?? join(REPO, 'qq-persona', 'p1'),
                ocr: candidate => this.ocrTextOf(candidate),
            });
            if (matched !== null)
                this.ctx.log('debug', 'sticker match: ' + matched.file + ' (d=' + matched.distance + ')');
            return matched;
        }
        catch (error) {
            this.ctx.log('debug', 'sticker match failed: ' + describeError(error));
            return null;
        }
    }
    /** OCR 一张图并缓存 60 秒（指纹消歧和自动 OCR 共用，避免同一张图跑两遍）。 */
    async ocrTextOf(path) {
        const now = Date.now();
        const hit = OCR_CACHE.get(path);
        if (hit !== undefined && now - hit.at < OCR_CACHE_MS)
            return hit.text;
        try {
            const maxBytes = Number(this.ctx.config.maxImageBytes) > 0
                ? Number(this.ctx.config.maxImageBytes)
                : 8 * 1024 * 1024;
            const text = await ocrImageFile({
                path,
                maxBytes,
                call: (action, params) => this.ctx.call(action, params),
                timeoutMs: 12_000,
            });
            const normalized = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
            OCR_CACHE.set(path, { at: now, text: normalized });
            return normalized;
        }
        catch (error) {
            OCR_CACHE.set(path, { at: now, text: '' });
            this.ctx.log('debug', 'ocr failed: ' + describeError(error));
            return '';
        }
    }
    /** 自动 OCR 一张入站图片；失败/空文本返回 ''（不打扰聊天）。 */
    async tryOcrImage(path) {
        const compact = await this.ocrTextOf(path);
        if (compact !== '')
            this.ctx.log('debug', 'ocr auto: ' + compact.slice(0, 60));
        return compact;
    }
    /** M3-D4c: transcribe in the background and deliver the labeled transcript
     * into the chat's turn (steer at the running turn's nearest step boundary,
     * or a new turn when the agent is idle). Failure keeps [语音] as final. */
    async transcribeLater(path, chatId) {
        try {
            const text = await this.ctx.transcriber.transcribe(path);
            if (transcriptLabel(text) === '') {
                this.ctx.log('debug', '语音转写结果为空: ' + path);
                currentTrace()?.emit('transcribe', { ok: false, reason: TRACE_REASONS.sttEmpty });
                return;
            }
            this.ctx.steerTranscript(chatId, text);
        }
        catch (error) {
            this.ctx.log('warn', 'STT failed: ' + describeError(error));
            currentTrace()?.emit('transcribe', { ok: false, reason: '语音转写失败: ' + describeError(error) });
        }
    }
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    async expandQuote(messageId) {
        try {
            const data = await this.ctx.call('get_msg', { message_id: Number(messageId) });
            const segments = Array.isArray(data.message) ? data.message : undefined;
            const raw = typeof data.raw_message === 'string' ? data.raw_message : '';
            const text = cqUnescape(segmentText(segments, raw));
            if (text.trim() === '')
                return '';
            const name = data.sender?.nickname ?? '';
            const quotedId = data.message_id === undefined || data.message_id === null ? '' : String(data.message_id);
            return '[引用' + (quotedId === '' ? '' : ' id=' + quotedId) + ']' + (name !== '' ? name + ': ' : '') + text;
        }
        catch (error) {
            this.ctx.log('debug', 'quote expansion failed: ' + describeError(error));
            currentTrace()?.emit('quote', { ok: false, reason: '引用消息展开失败，已降级为空引用: ' + describeError(error) });
            return '';
        }
    }
    /**
     * Fetch an inbound QQ file to a local path. NapCat's get_file may return
     * container-internal paths unreachable from this host, so:
     *   1. prefer the private-file direct link (get_private_file_url → HTTP
     *      CDN download, works for private chats);
     *   2. fall back to get_file base64 / http-url payloads.
     * Returns the [文件:path] annotation, or '' when disabled/failed.
     */
    async resolveNasFile(ref) {
        const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file';
        // The sender-controlled name never becomes the on-disk path (it could
        // otherwise overwrite chat-sessions.json etc.); only a whitelisted
        // extension survives into the fresh media_* name.
        const ext = extForInboundName(name);
        // Streaming size cap for both URL branches below (0 = uncapped).
        const maxBytes = this.ctx.config.maxInboundFileBytes > 0 ? this.ctx.config.maxInboundFileBytes : undefined;
        const fid = ref.fileId ?? ref.file ?? '';
        if (fid === '')
            return '';
        try {
            // 1. Private-chat direct link (works without any container access).
            const direct = await this.ctx.call('get_private_file_url', { file_id: fid });
            if (direct.url !== undefined && direct.url !== '') {
                try {
                    const localPath = await this.ctx.media.downloadUrl(direct.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via direct link: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_private_file_url failed (falling back to get_file): ' + describeError(error));
        }
        // 2. get_file: with NapCat's file server enabled it returns a `base64`
        //    payload or an http(s) `url`; otherwise a container path we cannot reach.
        try {
            const data = await this.ctx.call('get_file', { file: fid });
            const size = Number(data.file_size ?? 0);
            if (this.ctx.config.maxInboundFileBytes > 0 && size > this.ctx.config.maxInboundFileBytes) {
                this.ctx.log('warn', 'qq file too large (' + size + 'B), skipping fetch');
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileTooLarge });
                return '';
            }
            if (data.base64 !== undefined && data.base64 !== '') {
                const localPath = await this.writeMediaFile(Buffer.from(data.base64, 'base64'), ext);
                if (localPath !== '') {
                    this.ctx.log('info', 'qq file fetched via get_file base64: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
            }
            if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
                try {
                    const localPath = await this.ctx.media.downloadUrl(data.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via get_file url: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_file base64/url path failed: ' + describeError(error));
        }
        this.ctx.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid);
        currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileFailed });
        return '';
    }
    /** Write bytes into the media dir under a fresh unpredictable name; returns the path or ''. */
    async writeMediaFile(buffer, ext) {
        try {
            // freshPath mints media_<ts>_<uuid><ext>: inbound data can never land
            // on a known name (chat-sessions.json etc.) no matter what the sender
            // chose as the file name.
            await this.ctx.media.ensure();
            const localPath = this.ctx.media.freshPath(ext);
            await writeFile(localPath, buffer);
            return localPath;
        }
        catch (error) {
            this.ctx.log('warn', 'media write failed: ' + describeError(error));
            return '';
        }
    }
    /**
     * Expand a combined-forward id into "name: content" lines, collecting
     * embedded image segments into the media list (they flow through the same
     * buildBody pipeline as inbound media). Failure or an empty expansion no
     * longer returns a silent placeholder: the resId plus a short reason
     * (api-error / empty-response / no-text-nodes) stays in the model context
     * so it can self-serve via the whitelisted get_forward_msg tool.
     */
    async expandForward(forwardId) {
        try {
            // NapCat's get_forward_msg accepts `message_id` or `id`; sending both
            // also covers go-cqhttp-style implementations. Response node shapes
            // seen in the wild:
            //   - NapCat 4.x: full message objects `{ sender: {...}, message: [...] }`
            //     (the node list is parseMultiMessageContent output) — the content
            //     lives at node.message, NOT node.data.message;
            //   - OneBot node segments `{ type: 'node', data: { nickname, user_id,
            //     message: [...] } }`;
            //   - flat `{ sender, content }` for go-cqhttp-style builds.
            // [dsh-p1] v2.14: reading only node.data.* made every NapCat 4.x node
            // extract empty → whole expansion died as 'no-text-nodes' (4.40).
            const data = await this.ctx.call('get_forward_msg', { id: forwardId, message_id: forwardId });
            const nodes = data.messages ?? [];
            const lines = [];
            const media = [];
            for (const node of nodes) {
                const nodeData = node.data;
                const name = nodeData?.nickname ?? node.sender?.nickname
                    ?? String(nodeData?.user_id ?? node.sender?.user_id ?? '未知');
                const text = nodeContentText(nodeData?.message ?? nodeData?.content ?? node.message ?? node.content, name, media, lines);
                if (text !== '')
                    lines.push(name + ': ' + text);
            }
            if (lines.length === 0) {
                const reason = nodes.length === 0 ? 'empty-response' : 'no-text-nodes';
                currentTrace()?.emit('forward', { ok: false, reason: '合并转发未展开: ' + reason });
                return { text: '[合并转发 id=' + forwardId + ' 未展开: ' + reason + ']', media };
            }
            return { text: '[合并转发]\n' + lines.join('\n'), media };
        }
        catch (error) {
            this.ctx.log('info', 'forward expansion failed: resId=' + forwardId + ': ' + describeError(error));
            currentTrace()?.emit('forward', { ok: false, reason: '合并转发展开失败: ' + describeError(error) });
            return { text: '[合并转发 id=' + forwardId + ' 未展开: api-error]', media: [] };
        }
    }
}
/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref) {
    switch (ref.kind) {
        case 'image': return '[图片]';
        case 'voice': return '[语音]';
        case 'video': return '[视频]';
        default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]';
    }
}
/**
 * Extract text from a forward-node content (segment array or CQ string).
 * Image segments are collected into `media` and contribute a '[图片]'
 * placeholder (annotated by buildBody like inbound media, `name` carries the
 * owning node's nickname). Nested node segments recurse: their text joins
 * `lines` as their own "name: text" entry instead of being swallowed as
 * '[非文本]'.
 */
function nodeContentText(content, ownerName, media, lines) {
    if (Array.isArray(content)) {
        return content
            .map(seg => {
            const s = seg;
            if (s?.type === 'text')
                return String(s.data?.text ?? '');
            if (s?.type === 'face')
                return '😀';
            if (s?.type === 'image') {
                media.push({
                    kind: 'image',
                    url: typeof s.data?.url === 'string' && s.data.url !== '' ? s.data.url : undefined,
                    file: typeof s.data?.file === 'string' && s.data.file !== '' ? s.data.file : undefined,
                    name: ownerName,
                });
                return '[图片]';
            }
            if (s?.type === 'node' && typeof s.data === 'object' && s.data !== null) {
                const nested = s.data;
                const nestedName = nested.nickname ?? String(nested.user_id ?? ownerName);
                const nestedText = nodeContentText(nested.message ?? nested.content, nestedName, media, lines);
                if (nestedText !== '')
                    lines.push(nestedName + ': ' + nestedText);
                return '';
            }
            return '[非文本]';
        })
            .join('')
            .trim();
    }
    if (typeof content === 'string')
        return content.trim();
    return '';
}

// -- [dsh-p1] reply rhythm ------------------------------------------------------------
// Her replies had collapsed into a fixed "two bubbles, long then short"
// pattern no matter what §3 said. A concrete per-turn suggestion beats a
// static rule: sampled each turn, injected as [节奏], '' = no hint.
export function rhythmHint(random = Math.random) {
    const roll = random();
    if (roll < 0.50)
        return '这轮尽量一条说完';
    if (roll < 0.70)
        return '这轮可以拆两条：先短后长';
    if (roll < 0.85)
        return '这轮拆两条，都短点';
    // [dsh-p1] v2.12：8% 「配一张表情」桶退役——她本来就被人格规则推着发表情，
    // [节奏] 再点一把火就成了逢回必带（4.38）；表情频率归人格层管，节奏只管条数。
    return '';
}

// -- [dsh-p1] group peek ------------------------------------------------------------
// After an @, the next few group messages are delivered (awake window); the
// agent answers only what it wants, `[不回]` otherwise. Outside the window we
// randomly peek: admin messages more often than other members, with a cooldown
// and an hourly cap. Every peeked message gets the `[旁听]` prefix (chat.js).
const PEEK_AWAKE_ROUNDS = 3;
// [dsh-p1] v2.02: random-peek tightened (3.40 data: group = 90% of tokens)
const PEEK_ADMIN_CHANCE = 0.03;
const PEEK_MEMBER_CHANCE = 0.005;
const PEEK_COOLDOWN_MS = 900_000;
const PEEK_MAX_PER_HOUR = 3;
const PEEK_MIN_CHARS = 4;
// [dsh-p1] turn cap: total non-@/non-admin group turns per rolling hour; busy spam is
// capped while normal conversation (~1 msg / 2 min) never hits it.
const TURN_CAP_PER_HOUR = 30;
const turnCapState = new Map();

export function turnCapAllows(groupId, cap = TURN_CAP_PER_HOUR, now = Date.now()) {
    let st = turnCapState.get(groupId);
    if (st === undefined) {
        st = { hourStart: now, count: 0 };
        turnCapState.set(groupId, st);
    }
    if (now - st.hourStart > 3_600_000) {
        st.hourStart = now;
        st.count = 0;
    }
    if (st.count >= cap)
        return false;
    st.count += 1;
    return true;
}
const peekState = new Map();
// [dsh-p1] who was just talking to her: their next two messages are follow-ups.
const followUpCaller = new Map();

function peekStat(chatId) {
    let st = peekState.get(chatId);
    if (st === undefined) {
        st = { awakeLeft: 0, lastPeekAt: 0, hourStart: 0, peekCount: 0 };
        peekState.set(chatId, st);
    }
    return st;
}

function noteGroupMention(chatId) {
    peekStat(chatId).awakeLeft = PEEK_AWAKE_ROUNDS;
}

/** [dsh-p1] active chat: her own group reply keeps the conversation awake — the next
 *  PEEK_AWAKE_ROUNDS group messages pass the gate even without an @, so a
 *  flowing back-and-forth never dies mid-thread ("聊着聊着不回了",
 *  2026-10-25: her replies refreshed nothing, the wake window was consumed
 *  by intervening messages and a follow-up question was silently gated). */
export function noteSelfSent(chatId) {
    const st = peekStat(chatId);
    st.awakeLeft = Math.max(st.awakeLeft, PEEK_AWAKE_ROUNDS);
}

export function peekAllows(ctx, chatId, userId, text) {
    const st = peekStat(chatId);
    if (st.awakeLeft > 0) {
        st.awakeLeft -= 1;
        return true;
    }
    const now = Date.now();
    if (now - st.lastPeekAt < PEEK_COOLDOWN_MS)
        return false;
    if (now - st.hourStart > 3_600_000) {
        st.hourStart = now;
        st.peekCount = 0;
    }
    if (st.peekCount >= PEEK_MAX_PER_HOUR)
        return false;
    const body = String(text ?? '').trim();
    if (body.length < PEEK_MIN_CHARS)
        return false;
    const admins = Array.isArray(ctx.config.adminUsers) ? ctx.config.adminUsers : [];
    const chance = admins.includes(userId) ? PEEK_ADMIN_CHANCE : PEEK_MEMBER_CHANCE;
    if (Math.random() >= chance)
        return false;
    st.lastPeekAt = now;
    st.peekCount += 1;
    return true;
}

// -- [dsh-p1] friends can DM -----------------------------------------------------------
// QQ has no "friends may DM" policy in this plugin; check get_friend_list with
// a 10-minute cache. Failure keeps the set empty => admins only (fail-closed).
const friendCache = { at: 0, ids: new Set() };
const FRIEND_CACHE_MS = 600_000;
// v2.20: a cache miss no longer means "not a friend" — the sender may have
// been approved after the cache was loaded, and until the TTL refresh their
// messages were silently dropped (江璐's first DMs). Re-fetch once on a miss,
// throttled so stranger spam cannot hammer get_friend_list.
const FRIEND_RECHECK_MS = 30_000;

async function refreshFriendCache(ctx) {
    try {
        const res = await ctx.call('get_friend_list', {});
        const list = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
        const ids = new Set();
        for (const friend of list) {
            const id = String(friend?.user_id ?? friend?.uin ?? '');
            if (id !== '')
                ids.add(id);
        }
        friendCache.ids = ids;
    }
    catch (error) {
        ctx.log('warn', 'get_friend_list failed, friends-only DM stays closed: ' + String(error));
    }
}

async function isFriendSender(ctx, userId) {
    const now = Date.now();
    if (now - friendCache.at > FRIEND_CACHE_MS) {
        friendCache.at = now;
        await refreshFriendCache(ctx);
        return friendCache.ids.has(String(userId));
    }
    if (friendCache.ids.has(String(userId)))
        return true;
    if (now - friendCache.at > FRIEND_RECHECK_MS) {
        friendCache.at = now;
        await refreshFriendCache(ctx);
    }
    return friendCache.ids.has(String(userId));
}
export { isFriendSender, friendCache, FRIEND_CACHE_MS, FRIEND_RECHECK_MS };

/** [dsh-p1] v2.20: an approval just succeeded — admit the new friend
 * immediately instead of waiting out the cache TTL. */
export function noteFriendAdded(userId) {
    const id = String(userId ?? '');
    if (id !== '')
        friendCache.ids.add(id);
}

// -- [dsh-p1] shared notes (v2: stored in memory/memories.jsonl as kind=note, scope=global) ----
// The "记住：…" phrases taught in the admin DM. They live in the same store as
// qq_remember memories now (the old shared-notes.md was migrated once by the
// patch); notesBlock() renders the [共同记忆] block from them.
async function getSharedNotes(mediaDir) {
    return await notesBlock(mediaDir);
}

async function teachSharedNote(ctx, text) {
    const match = String(text ?? '').trim().match(/^记住[：:，,\s]+(.{1,200})$/);
    if (match === null)
        return false;
    try {
        await appendMemory(ctx.config.mediaDir, { chat: '', kind: 'note', scope: 'global', text: match[1] });
        const adminChat = 'private:' + String(ctx.policy?.adminUsers?.[0] ?? '');
        await ctx.sendToChat(adminChat, '记住了：' + match[1].trim());
    }
    catch (error) {
        ctx.log('warn', 'shared note write failed: ' + String(error));
        return false;
    }
    return true;
}

// -- [dsh-p1] long-term memory v2 ------------------------------------------------------------
// Recall / forget / list live in ./memory-store.js (source:
// tools/onebot_memory2.js). Records are chat-scoped by default; only
// scope=global crosses chats, so a private-DM memory can never surface in a
// group prompt. qq_forget archives removed records to memory/removed.jsonl.
