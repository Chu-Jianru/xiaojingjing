/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installWorkingContext } from './working-context.js';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { transcriptLabel } from './stt.js';
import { buildChatId, classifyUserRole, splitChatId } from './chat.js';
import { buildPlatformPrompt } from './prompt.js';
import { gate as sleepGate, tick as sleepTick, loadSleep, saveSleep, noteMessage as sleepNote, isAdminSettleText, dispatchSleepGreeting } from './sleep.js';
import { registerTools } from './tools.js';
import { tryHandleCommand as routeCommand } from './commands.js';
import { relayHostCards as relayCards } from './card-relay.js';
import { OutboundPipeline } from './outbound.js';
import { ChatRegistry } from './registry.js';
import { InboundPipeline, normalizeOneBot11, noteSelfSent, noteFriendAdded } from './inbound.js';
import { callsFor } from './calls.js';
import { stopSinging } from './singing.js';
import { helperSessionEvent } from './helper.js';
import { InterimTracker } from './interim.js';
import { chatFlowFor, CHAT_FLOW_GUIDANCE, SINGLE_REPLY_GUIDANCE } from './chat-flow.js';
import { GROUP_CONVERSATION_GUIDANCE } from './group-conversation.js';
import { DeferredDelivery } from './deferred.js';
import { DEFAULT_DEFERRED_TIMEOUT_MS } from './deferred.js';
import { describeError, errorStack } from './errors.js';
import { currentTrace, newTraceId, runWithTrace, TRACE_REASONS } from './trace.js';
import { runInjectRound, currentInjectRound, isWriteAction, INTERCEPTED_MESSAGE_ID } from './inject.js';
import { healthReport, exportDiagnostics } from './health.js';
import { CatchUp } from './catchup.js';
import { listeningFor } from './listening.js';
import { GROUP_BATCH, groupConversationFor } from './group-conversation.js';
import { reactionPolicy } from './reactions.js';
import { journalFor, observeJournal, journalSessionEvent, startJournal, stopJournal } from './journal-runner.js';
import { FriendRequestStore } from './friend-store.js';
import { friendNotificationsFor } from './friend-notifications.js';
import { FailureRefRegistry, failureRefSuffix } from './ref.js';
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export const QUEUE_NOTICE_TEXT = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。';
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export class ChatBridge {
    deps;
    /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
    outbound;
    /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
     * persistence pair, per-chat settings and the create/resume assembly. */
    registry;
    /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
     * dispatch path; the same-name bridge methods below delegate here. */
    inbound;
    /** Interim domain (D1-PR5): the assistant/message interim routing, the
     * per-message recall timers and the turn/end settlement. */
    interim;
    /** T3 (P2): the deferred-delivery tracker (超时补发) — timeout timers, the
     * JSONL registry, bounded send retries and restart recovery. */
    deferred;
    /** T4 (P3): the bounded registry of recent fault references — every minted
     * QQ-CONN-/MF- number is recorded here for the /healthcheck report and the
     * diagnostics archive file name. */
    failureRefs = new FailureRefRegistry();
    /** Live registry indexes — the inbound/outbound/interim/turn links keep
     * reading them through these same-name views. */
    get chats() { return this.registry.chats; }
    get bySession() { return this.registry.bySession; }
    sessionEventOff;
    sessionFlushOff;
    /** W1: chat-level traceId association table — session events arrive on a
     * different async chain than the inbound pipeline, so dispatchFollowup
     * records the initiating traceId per chat here and onSessionEvent reads it
     * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
     * dropped when the chat is removed. Not cleared at turn/end: the interim
     * settle loop sends the final reply AFTER turn/end, and clearing there
     * would orphan exactly that reply's outbound events. One entry per chat
     * id (bounded by the chat population), so growth is not a concern. */
    traceByChat = new Map();
    /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
     * (independent of the trace sink, so the dry-run guard covers the async
     * agent reply even with tracing off). Cleared by a real dispatch to the
     * chat or when the chat is removed. */
    injectRoundByChat = new Map();
    /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
     * running turn (one notice per turn; cleared at turn/end and on chat
     * removal — bounded by the chat population). */
    queueNoticeChats = new Set();
    /** Plugin version + git commit, read once for /ver. */
    pluginVersion;
    pluginCommit;
    stopping = false;
    constructor(deps) {
        this.deps = deps;
        // [dsh-p1] last message she sent per chat, for qq_recall.
        this.lastSentByChat = new Map();
        // [dsh-p1] id of the message the current inbound replies to (if any).
        this.lastQuotedId = '';
        // [dsh-p1] short fragments that look unfinished: hold them briefly so
        // the rest of the thought lands in the same turn.
        this.pendingFragments = new Map();
        // [dsh-p1] messages that arrive while she sleeps: replay on waking.
        this.sleepBacklog = new Map();
        this.registry = new ChatRegistry({
            agents: deps.agents,
            sessions: deps.sessions,
            sessionPersistence: deps.sessionPersistence,
            workspaceRegistry: deps.workspaceRegistry,
            agentPresets: deps.agentPresets,
            defaultModel: deps.defaultModel,
            config: deps.config,
            log: (level, message) => deps.log(level, message),
            isStopping: () => this.stopping,
            onChatRemoved: chat => {
                this.stopTyping(chat);
                // W1/T5: forget the chat's injected round (and its trace mapping).
                this.deps.config.inject?.clearChat(chat.chatId);
                this.traceByChat.delete(chat.chatId);
                this.injectRoundByChat.delete(chat.chatId);
                this.queueNoticeChats.delete(chat.chatId);
            },
            installChannelScope: agentCtx => this.installChannelScope(agentCtx),
        });
        this.outbound = new OutboundPipeline({
            getChat: chatId => this.chats.get(chatId),
            connected: () => this.deps.connection.connected,
            selfId: () => this.deps.connection.selfId,
            call: (action, params, chatId) => this.guardedConnectionCall(action, params, chatId),
            isStopping: () => this.stopping,
            log: (level, message) => this.deps.log(level, message),
            recordSent: (chatId, id) => this.lastSentByChat.set(chatId, String(id)),
            onTextSent: (chatId, segments) => reactionPolicy(this).noteText(chatId, segments),
            config: deps.config,
            // W1: outbound decision events ride the chat's initiating traceId; a
            // write with no mapped trace (proactive tool sends) starts a fresh one.
            trace: (chatId, event) => {
                const sink = deps.config.trace;
                if (sink === undefined || !sink.enabled)
                    return;
                const mapped = this.traceByChat.get(chatId);
                sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event });
            },
        });
        // [dsh-p1] P0 catch-up: replay messages missed while offline.
        this.catchup = new CatchUp({
            mediaDir: () => deps.config.mediaDir,
            selfId: () => this.deps.connection.selfId,
            connected: () => this.deps.connection.connected,
            call: (action, params) => this.guardedConnectionCall(action, params),
            handleEvent: event => this.handleInbound(event),
            handleGroupBatch: events => groupConversationFor(this).deliver(events),
            // [dsh-p1] v2.21: registry alone misses friends whose first
            // messages were dropped before any session existed (DM gate /
            // outage) — enumerate the whole friend list so their backlog
            // replays too. maxChats raised: the default 8 would slice
            // appended friends off whenever the registry is busy.
            maxChats: 48,
            listChats: async () => {
                const chats = [...this.chats.values()]
                    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
                    .map(chat => chat.chatId);
                const known = new Set(chats);
                try {
                    const res = await this.guardedConnectionCall('get_friend_list', {});
                    const rows = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
                    const selfId = String(this.deps.connection.selfId ?? '');
                    for (const row of rows) {
                        const uin = String(row?.user_id ?? '');
                        const chatId = 'private:' + uin;
                        if (uin === '' || uin === selfId || known.has(chatId))
                            continue;
                        known.add(chatId);
                        chats.push(chatId);
                    }
                }
                catch { /* registry-only when the friend list is unavailable */ }
                return chats;
            },
            ready: () => this.registry.mappingLoaded,
            // [dsh-p1] v2.24: group replay anchor — the admin's group messages
            // always reach her live; the replay must not drop them either.
            isAdmin: userId => {
                const admins = [
                    ...(Array.isArray(deps.policy?.adminUsers) ? deps.policy.adminUsers : []),
                    ...(Array.isArray(deps.config?.adminUsers) ? deps.config.adminUsers : []),
                ].map(String);
                return admins.includes(String(userId));
            },
            log: (level, message) => this.deps.log(level, message),
        });
        this.inbound = new InboundPipeline({
            call: (action, params) => this.guardedConnectionCall(action, params),
            selfId: () => this.deps.connection.selfId,
            policy: deps.policy,
            getChat: chatId => this.chats.get(chatId),
            getSettings: chatId => this.registry.getSettings(chatId),
            sweepIdleChats: () => this.registry.sweepIdleChats(),
            media: deps.media,
            transcriber: deps.transcriber,
            steerTranscript: (chatId, text) => this.steerTranscript(chatId, text),
            tryHandleCommand: (chatId, text, userId, nickname) => this.tryHandleCommand(chatId, text, userId, nickname),
            buildBody: (text, media, chatId) => this.buildBody(text, media, chatId),
            expandQuote: messageId => this.expandQuote(messageId),
            dispatchFollowup: (chatId, text, role, nickname, revision, userId) => this.dispatchFollowup(chatId, text, role, nickname, revision, userId),
            interceptBusyTurn: (chatId, text, role, nickname, plain, revision, userId) => this.interceptBusyTurn(chatId, text, role, nickname, plain, revision, userId),
            observeJournal: inbound => observeJournal(this, inbound),
            reactionHint: (chatId, isOwner = false) => isOwner ? String() : reactionPolicy(this).hint(chatId),
            listeningHint: (chatId, body, buffered) => listeningFor(this).hint(chatId, body, buffered),
            sendToChat: (chatId, text) => this.sendToChat(chatId, text),
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
        });
        this.interim = new InterimTracker({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, { ...options, modelReply: true }),
            sendMsg: (chatId, segments, options) => this.sendMsg(chatId, segments, options),
            call: (action, params) => this.guardedConnectionCall(action, params),
            chainTail: chatId => this.outbound.chainTail(chatId),
            relayHostCards: (chatId, content) => this.relayHostCards(chatId, content),
            effectiveInterim: chatId => this.effectiveInterim(chatId),
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
        });
        this.deferred = new DeferredDelivery({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, { ...options, modelReply: true }),
            isTurnRunning: chatId => this.chats.get(chatId)?.agent.status === 'running',
            takePendingText: chatId => {
                const chat = this.chats.get(chatId);
                if (chat === undefined || chat.loopPending === null)
                    return null;
                const text = chat.loopPending;
                chat.loopPending = null;
                return text;
            },
            traceIdFor: chatId => this.traceByChat.get(chatId),
            log: (level, message) => this.deps.log(level, message),
            trace: (chatId, event) => {
                const sink = deps.config.trace;
                if (sink === undefined || !sink.enabled)
                    return;
                const mapped = this.traceByChat.get(chatId);
                sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event });
            },
            mediaDir: deps.config.mediaDir,
            timeoutMs: deps.config.deferredTimeoutMs ?? DEFAULT_DEFERRED_TIMEOUT_MS,
            isStopping: () => this.stopping,
        });
    }
    /** Start listening: wire connection handlers and the session event feed. */
    start() {
        const { connection, ctx: sessionEvents } = this.deps;
        connection.selfId = this.deps.config.botQQ;
        this.sessionEventOff = sessionEvents.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        this.sessionFlushOff = sessionEvents.on('session/flush', (session) => {
            void this.onSessionFlush(session);
        });
        connection.onStatus = (connected) => {
            this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'));
            if (connected)
                this.outbound.drainPendingSends();
            // [dsh-p1] P0 catch-up: the module decides whether the gap is real.
            if (connected) {
                void this.catchup.onConnected();
                // [dsh-p1] buddy watch: check the dump right away on every (re)connect.
                void buddyWatchTick(this);
                // [dsh-p1] roster: refresh the friend snapshot after (re)connect.
                void syncRoster(this, 'sync');
            }
            else {
                this.catchup.onDisconnected();
            }
        };
        // [dsh-p1] friend store: load pending requests early so the log shows
        // what survived a restart (approval also loads lazily).
        void friendStore(this).ensureLoaded();
        // [dsh-p1] buddy watch: read NapCat's buddy-request dump and tell the admin.
        startBuddyWatch(this);
        startRosterSync(this);
        // [dsh-p1] poke watch: NapCat dumps gray-tip pokes (no OneBot notice).
        startPokeWatch(this);
        startSleepWatch(this);
        // If a previous sleep window was never recovered (restart during/after
        // sleep), do it once now.
        void this.recoverSleepGapIfNeeded();
        this.registry.mappingLoaded = this.ready().then(async () => {
            await this.registry.loadRetired();
            await this.registry.loadSwitchable();
            await this.registry.loadMapping();
            // T3 (P2): restore deferred-delivery tracking（未完结条目在该会话的
            // 下一次 turn/end 兑现；损坏行降级跳过）。
            await this.deferred.loadPersisted();
        }).then(() => {
            if (this.stopping)
                return;
            startJournal(this, createUserMessage);
            void callsFor(this).start().catch(() => this.deps.log('warn', 'voice call transport unavailable'));
            this.deps.log('info', 'bridge ready (' + this.registry.chats.size + ' resumed chat(s))');
        });
    }
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    async stop() {
        this.stopping = true;
        stopSinging(this);
        listeningFor(this).stop();
        await callsFor(this).stop();
        groupConversationFor(this).stop();
        await stopJournal(this);
        // [dsh-p1] P0 catch-up: flush the watermark before the chats go.
        await this.catchup.stop();
        stopBuddyWatch(this);
        stopRosterSync(this);
        stopPokeWatch(this);
        stopSleepWatch(this);
        if (this.sessionEventOff !== undefined) {
            this.sessionEventOff();
            this.sessionEventOff = undefined;
        }
        if (this.sessionFlushOff !== undefined) {
            this.sessionFlushOff();
            this.sessionFlushOff = undefined;
        }
        await this.registry.stop();
        // T3 (P2): disarm the deferred silent-wait timers（pending 条目已落盘，
        // 重启后 loadPersisted 恢复跟踪续投）。
        this.deferred.stopAll();
    }
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId) {
        return this.bySession.get(sessionId);
    }
    /** Whether a caller backing an agent session may perform file edits. QQ chats
     * require the currently running turn's initiator to be an admin (role frozen
     * from the dispatch queue at turn/start); non-QQ sessions (Web and other
     * channels) are trusted by default (A1 scoping). Unknown states fail closed
     * as member. */
    canEditFiles(sessionId) {
        const chatId = this.bySession.get(sessionId);
        if (chatId === undefined)
            return true;
        return this.chats.get(chatId)?.activeTurnRole === 'admin';
    }
    /**
     * Outbound media fence roots for one agent session's current turn (M1-A3b):
     * the plugin media dir always, plus the chat's workspace directory when the
     * running turn's initiator is an admin. The role reuses the M1-A2 turn-level
     * semantics (canEditFiles: frozen at turn/start, fail-closed member); a
     * session with no known chat stays mediaDir-only even though canEditFiles
     * would trust it — the media gate itself fails closed. Roots are
     * realpath-normalized here; the MediaStore fence re-checks containment
     * (the double check is harmless).
     */
    async mediaSendRoots(sessionId) {
        const isTurnAdmin = sessionId !== undefined && this.canEditFiles(sessionId);
        const chatId = sessionId !== undefined ? this.bySession.get(sessionId) : undefined;
        const candidates = [this.deps.config.mediaDir];
        if (chatId !== undefined && isTurnAdmin)
            candidates.push(this.effectiveCwd(chatId));
        const roots = [];
        for (const root of candidates) {
            try {
                roots.push(await realpath(root));
            }
            catch {
                roots.push(root); // missing root: kept as-is; the fence skips it (cannot contain anything)
            }
        }
        return { roots, isTurnAdmin };
    }
    /** Whether the connection is usable for sends. */
    get connected() {
        return this.deps.connection.connected;
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    /** Wait until the chat's turn is finished (so backlog messages don't merge). */
    async waitChatIdle(chatId) {
        for (let i = 0; i < 80; i++) {
            const chat = this.chats.get(chatId);
            if (chat === undefined || chat.agent?.status !== 'running')
                return;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    /** Replay the messages that arrived while she was asleep, one turn each. */
    async flushSleepBacklog() {
        if (this.sleepBacklog.size === 0)
            return;
        // [dsh-p1] backlog/catchup dedup (v2.27): a reconnect between queueing
        // and waking replays these through catchup first (they were never seen
        // when the sleep gate queued them) — skip what it already delivered so
        // she never answers the same message twice.
        const backlog = [...this.sleepBacklog.values()].flat();
        const pending = backlog.filter(event => {
            // [dsh-p1] v2.63: 群消息不补发——醒来逐条回旧群聊会冒出「晚安」这种错位发言
            if (event.group_id !== undefined && event.group_id !== null && String(event.group_id) !== '')
                return false;
            const chatId = 'private:' + String(event.user_id);
            const id = String(event?.message_id ?? '');
            return id === '' || !this.catchup?.hasSeen?.(chatId, id);
        });
        if (backlog.length > pending.length)
            this.deps.log('info', 'sleep backlog: skipped ' + (backlog.length - pending.length) + ' message(s) already replayed by catchup');
        this.sleepBacklog.clear();
        for (const event of pending.slice(0, 20)) {
            const chatId = event.group_id !== undefined && event.group_id !== null && String(event.group_id) !== ''
                ? 'group:' + String(event.group_id)
                : 'private:' + String(event.user_id);
            try {
                // Let the previous turn finish first; otherwise DSH merges the
                // next message into it and she answers several questions at once
                // without knowing which is which.
                await this.waitChatIdle(chatId);
                await this.handleInboundOnce(event);
                await this.waitChatIdle(chatId);
            }
            catch (error) {
                this.deps.log('warn', 'sleep backlog replay failed: ' + describeError(error));
            }
        }
        this.deps.log('info', 'sleep: replayed ' + Math.min(pending.length, 20) + ' backlog message(s)');
    }

    async recoverSleepGapIfNeeded() {
        try {
            const sleepState = await loadSleep(this.deps.config.mediaDir);
            if (String(sleepState.status) !== 'awake')
                return;
            if (Number(sleepState.asleepAt) > Number(sleepState.gapRecoveredFor ?? 0))
                await this.recoverSleepGap();
        }
        catch (error) {
            this.deps.log('warn', 'sleep gap check failed: ' + describeError(error));
        }
    }

    /** On waking: replay the in-memory queue, then pull recent history for
     *  messages that were dropped before the queue existed (or during a restart). */
    async recoverSleepGap(fromOverride = 0) {
        await this.flushSleepBacklog();
        try {
            await this.catchup.load?.();
            const sleepState = await loadSleep(this.deps.config.mediaDir);
            const asleepAt = Number(sleepState.asleepAt) || (Date.now() - 2 * 3_600_000);
            const pendingFrom = Number(sleepState.pendingRecoverFrom) || 0;
            const from = fromOverride > 0 ? fromOverride : Math.min(asleepAt, pendingFrom > 0 ? pendingFrom : asleepAt);
            if (fromOverride === 0 && Number(sleepState.gapRecoveredFor) === asleepAt)
                return;
            const oldFetch = this.catchup.opt?.fetchCount;
            if (this.catchup.opt !== undefined)
                this.catchup.opt.fetchCount = Math.max(Number(oldFetch) || 20, 50);
            const chats = [...this.chats.keys()].filter(id => id.startsWith('private:')).slice(0, 8);
            for (const chatId of chats) {
                // Rewind the per-chat watermark to when she fell asleep: messages
                // from the sleep window were dropped before noteSeen, so the
                // normal catch-up (which starts at the watermark) would skip them.
                const st = this.catchup.state?.chats?.[chatId];
                if (st !== undefined && Number(st.lastTime) > from)
                    st.lastTime = from;
                await this.catchup.catchUpChat(chatId, false, 5);
            }
            if (this.catchup.opt !== undefined && oldFetch !== undefined)
                this.catchup.opt.fetchCount = oldFetch;
            sleepState.gapRecoveredFor = asleepAt;
            sleepState.pendingRecoverFrom = 0;
            await saveSleep(this.deps.config.mediaDir, sleepState);
            this.deps.log('info', 'sleep gap: recovered since ' + new Date(from).toLocaleTimeString('zh-CN'));
        }
        catch (error) {
            this.deps.log('warn', 'sleep gap recovery failed: ' + describeError(error));
        }
    }

    /** Heuristic: does this fragment read like the speaker is not done yet? */
    looksIncomplete(text) {
        const body = String(text ?? '').trim();
        if (body === '')
            return false;
        if (/(\.\.\.|…|，|,|、)$/.test(body))
            return true;
        return /(忽然|突然|然后|接着|后来|结果|但是|但|可是|因为|所以|如果|不过|而且|就是|还有|以及|我|你|他|她|它|这|那|就|还|也|才|刚|本来|其实|于是|跟|和)$/.test(body);
    }

    sendToChat(chatId, text, options = {}) {
        const voice = callsFor(this).routeText(chatId, text, options);
        if (voice !== null) return voice;
        // [dsh-p1] active chat: her own group message refreshes the wake window, so the
        // conversation she just participated in keeps reaching her.
        if (typeof chatId === 'string' && chatId.startsWith('group:'))
            noteSelfSent(chatId);
        const timing = options.modelReply ? listeningFor(this).timing(chatId) : null;
        const send = this.outbound.sendToChat(chatId, text, timing ? { ...options, replyTiming: timing } : options);
        return timing ? send.finally(() => timing.dispose()) : send;
    }
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        const voice = callsFor(this).routeSegments(chatId, segments);
        if (voice !== null) return voice;
        const controller = listeningFor(this);
        const timing = chatId.startsWith('private:') && controller.state(chatId).running ? controller.timing(chatId) : null;
        const send = this.outbound.sendSegments(chatId, segments, timing ? { replyTiming: timing, throwIfSuperseded: true } : {});
        return timing ? send.finally(() => timing.dispose()) : send;
    }
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    async ready() {
        await this.deps.hostReady?.();
    }
    // ------------------------------------------------------------ inbound
    /**
     * Inbound OneBot message event → agent turn. All policy and media work is
     * contained: a failure here logs and drops the message, never the host.
     * W1: the whole inbound chain runs inside one trace scope (ALS), so every
     * pipeline decision point can attribute its event to this message's
     * traceId; disabled = no scope, no id, 0.6.0 behavior. W1/T5: injected
     * events (opts.injected) run inside their inject round (ALS) so the
     * dry-run guard covers the whole synchronous chain, and real events are
     * recorded by the inbound recorder when recordInbound is on (injected
     * events are never recorded — no inject→record→replay feedback loop).
     */
    async handleInbound(event, opts = {}) {
        const run = () => this.handleInboundOnce(event, opts.injected === true);
        return opts.injected === true
            ? runInjectRound({ traceId: newTraceId(), intercepted: 0 }, run)
            : run();
    }
    async handleInboundOnce(event, injected) {
        if (!injected) callsFor(this).onRealInbound(event);
        // Recording: skipped for injected events (they would otherwise feed the
        // injector again through replay) and skipped when no recorder exists.
        const recorder = injected || event.dshVoiceCall === true ? undefined : this.deps.config.recorder;
        const session = recorder?.begin(event) ?? undefined;
        const trace = this.beginInboundTrace(event);
        const scope = trace !== undefined
            ? (session !== undefined ? session.wrapScope(trace) : trace)
            : session?.captureScope();
        try {
            return await runWithTrace(scope, async () => {
                if (this.stopping) {
                    this.deps.log('debug', '插件停止中，入站消息丢弃');
                    scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping });
                    return false;
                }
                // [dsh-p1] QQ 戳一戳: a poke aimed at us becomes a tiny turn.
                // [dsh-p1] peer typing is state, not a model/user message.
                const listening = listeningFor(this);
                const selfId = this.deps.connection?.selfId ?? this.deps.config.botQQ ?? '';
                if (listening.typing(event, selfId)) return;
                const immediate = isAdminSettleText(String(event.raw_message ?? ''));
                if (await listening.receive(event, { injected, immediate, selfId })) return false;
                if (await groupConversationFor(this).receive(event, { injected, selfId })) return false;
                if (event.post_type === 'notice')
                    this.deps.log('info', 'notice event: ' + String(event.notice_type) + '/' + String(event.sub_type) + ' user=' + String(event.user_id ?? '') + ' target=' + String(event.target_id ?? '') + ' group=' + String(event.group_id ?? ''));
                if (event.post_type === 'notice' && event.notice_type === 'notify'
                    && event.sub_type === 'poke' && await handlePokeNotice(this, event))
                    return;
                // [dsh-p1] QQ 戳一戳: a poke aimed at us becomes a tiny turn.
                if (event.post_type === 'notice' && event.notice_type === 'notify'
                    && event.sub_type === 'poke' && await handlePokeNotice(this, event))
                    return;
                // [dsh-p1] remember which message this inbound quotes (qq_recall uses it).
                if (event.post_type === 'message') {
                    const replySeg = Array.isArray(event.message) ? event.message.find(seg => seg?.type === 'reply') : undefined;
                    const replyId = replySeg?.data?.id ?? (/\[CQ:reply,id=(\d+)\]/.exec(String(event.raw_message ?? ''))?.[1] ?? '');
                    this.lastQuotedId = replyId === '' || replyId === undefined ? '' : String(replyId);
                }
                // [dsh-p1] don't answer a thought that is obviously unfinished:
                // hold it ~12s; if the rest arrives, merge; otherwise process it.
                if (event.post_type === 'message') {
                    const fragText = String(event.raw_message ?? '');
                    const key = String(event.group_id ?? event.user_id ?? '');
                    const pending = this.pendingFragments.get(key);
                    // [dsh-p1] 只压一次：12 秒到点后必须放行，否则「…我/…你」结尾的
                    // 消息会被定时器自己反复重新挂起（戳一戳的「戳了戳你」就踩过这个坑）。
                    if (event.dshFragmentReleased !== true && this.looksIncomplete(fragText)) {
                        if (pending !== undefined) {
                            clearTimeout(pending.timer);
                            this.pendingFragments.delete(key);
                            mergeFragmentText(event, pending.text);
                        }
                        else {
                            const pendingEvent = event;
                            const timer = setTimeout(() => {
                                this.pendingFragments.delete(key);
                                pendingEvent.dshFragmentReleased = true;
                                void this.handleInboundOnce(pendingEvent).catch(() => undefined);
                            }, 12_000);
                            timer.unref?.();
                            this.pendingFragments.set(key, { text: fragText, timer });
                            return false;
                        }
                    }
                    else if (pending !== undefined) {
                        clearTimeout(pending.timer);
                        this.pendingFragments.delete(key);
                        mergeFragmentText(event, pending.text);
                    }
                }
                // [dsh-p1] sleep schedule: drop messages while asleep, unless 老大 wakes her.
                if (event.post_type === 'message') {
                    const mediaDir = this.deps.config.mediaDir;
                    const admins = Array.isArray(this.deps.policy?.adminUsers) ? this.deps.policy.adminUsers : [];
                    const sleepState = await loadSleep(mediaDir);
                    // [dsh-p1] sleep settle passthrough (v2.27): 同意/拒绝 <QQ> from
                    // the admin is an action on a pending request, not chat — it
                    // must settle while she is asleep (handleFriendApprovalReply
                    // answers it) and must not wake her.
                    const settlePassthrough = admins.map(String).includes(String(event.user_id))
                        && isAdminSettleText(String(event.raw_message ?? ''));
                    const verdict = settlePassthrough
                        ? { drop: false, wake: false }
                        : sleepGate(sleepState, Date.now(), event.user_id, String(event.raw_message ?? ''), admins);
                    if (verdict.drop) {
                        // Asleep means asleep for everyone, but keep the message
                        // so she can go through it after waking.
                        const backKey = String(event.group_id ?? event.user_id ?? '');
                        const queue = this.sleepBacklog.get(backKey) ?? [];
                        queue.push(event);
                        if (queue.length > 20)
                            queue.shift();
                        this.sleepBacklog.set(backKey, queue);
                        this.deps.log('info', 'sleep: queued a message from ' + String(event.user_id) + ' while asleep');
                        return false;
                    }
                    if (verdict.wake) {
                        sleepState.status = 'awake';
                        // Stay awake until the morning; otherwise the 01:00–07:00
                        // window would put her straight back to sleep.
                        const wakeAt = new Date();
                        wakeAt.setHours(7, 0, 0, 0);
                        if (wakeAt.getTime() <= Date.now())
                            wakeAt.setDate(wakeAt.getDate() + 1);
                        sleepState.overrideUntil = wakeAt.getTime();
                        sleepState.wokenAt = Date.now();
                        this.deps.log('info', 'sleep: woken by admin (until 07:00)');
                        void this.recoverSleepGap();
                    }
                    // 老大 can keep her up for the night, or send her to bed.
                    const sleepAdmin = admins.map(String).includes(String(event.user_id));
                    const bodyText = String(event.raw_message ?? '');
                    if (sleepAdmin && /(补消息|漏了什么|看看漏的|补一下消息)/.test(bodyText)) {
                        void this.recoverSleepGap(Date.now() - 6 * 3_600_000);
                        this.deps.log('info', 'sleep gap: manual recovery requested');
                    }
                    if (sleepAdmin && /(今天别睡|别睡了|不睡了|一起玩|通宵|陪我熬夜|保持精神|精神点)/.test(bodyText)) {
                        sleepState.status = 'awake';
                        const wake = new Date();
                        wake.setHours(7, 0, 0, 0);
                        if (wake.getTime() <= Date.now())
                            wake.setDate(wake.getDate() + 1);
                        sleepState.overrideUntil = wake.getTime();
                        if (/(今天不睡|不睡了|通宵)/.test(bodyText))
                            sleepState.noSleepUntil = wake.getTime();
                        this.deps.log('info', 'sleep: admin keeps her awake until 07:00');
                    }
                    else if (sleepAdmin && /(去睡|睡觉|睡吧|该睡了|(?:立刻|立马|现在|马上|赶紧|这就|现在就)\s*睡(?:了吧|吧|啦|呀)?\s*[。！!~～]?\s*$)/.test(bodyText)
                        && /(立刻|立马|现在|马上|赶紧|这就|现在就)/.test(bodyText)
                        && !/(别睡|不睡)/.test(bodyText)) {
                        // 只有即时词（立刻/立马/现在/马上/赶紧/这就）才把她送去睡；
                        // 光说「睡觉」是提醒，「快睡/快睡觉吧」也不算命令（老大 2026-10-25 要求）。
                        // 尾锚 + 「睡醒/了吗」等不匹配，避免「你现在睡了吗」被当成命令。
                        sleepState.status = 'asleep';
                        sleepState.asleepAt = Date.now();
                        // An explicit bedtime clears any earlier keep-awake override
                        // (set by a wake or by "don't sleep today").
                        sleepState.overrideUntil = 0;
                        sleepState.noSleepUntil = 0;
                        sleepState.justSleptAt = Date.now();
                        this.deps.log('info', 'sleep: admin sent her to bed now');
                    }
                    sleepNote(sleepState, Date.now(), event.user_id, bodyText, admins);
                    sleepState.lastChatId = (event.group_id !== undefined && event.group_id !== null && String(event.group_id) !== '')
                        ? 'group:' + String(event.group_id) : 'private:' + String(event.user_id);
                    await saveSleep(mediaDir, sleepState);
                }
                const inbound = normalizeOneBot11(event);
                // [dsh-p1] friend requests are not messages: forward them to the admin.
                if (inbound === null && await handleFriendRequestEvent(this, event))
                    return;
                if (inbound === null) {
                    this.deps.log('debug', '非聊天消息事件，不处理（post_type=' + String(event.post_type) + '）');
                    scope?.emit('normalize', { ok: false, reason: TRACE_REASONS.inboundNotChat });
                    return;
                }
                // [dsh-p1] `同意 <QQ>` / `拒绝 <QQ>` from the admin settles a pending request;
                // a QQ reply to one notification settles that specific request.
                if (inbound.kind === 'private'
                    && await handleFriendApprovalReply(this, inbound.text, inbound.userId, inbound.replyId))
                    return;
                const handled = await this.processInbound(inbound);
                if (inbound.groupBatch) return handled;
                // [dsh-p1] P0 catch-up: remember the id so a reconnect never
                // replays a message this process already handled. v2.23: the
                // pipeline reports false on a DROP (gate / backlog) — marking
                // dropped messages seen is what made them unrecoverable.
                if (!injected && event.dshVoiceCall !== true && handled !== false)
                    this.catchup.noteSeen(inbound);
                if (!injected && event.dshVoiceCall !== true && handled === false)
                    this.catchup.noteDeferred(inbound);
                // Every merged bubble keeps its delivery ledger entry.
                if (!injected) for (const id of inbound.listeningMergedIds ?? []) {
                    const item = { chatId: inbound.chatId, messageId: id };
                    if (handled === false) this.catchup.noteDeferred(item);
                    else this.catchup.noteSeen(item);
                }
                return handled;
            });
        }
        catch (error) {
            scope?.emit('dispatch', { ok: false, reason: '入站处理失败: ' + describeError(error) });
            this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error));
            return false;
        }
        finally {
            session?.end();
        }
    }
    /** W1: mint the inbound traceId + scope and record the first (收到消息)
     * event; undefined when tracing is off (zero overhead, zero difference).
     * W1/T5: an injected event REUSES its inject round's traceId, so the whole
     * injected round (pipeline decisions + intercepted outbound calls) shares
     * one traceId in the trace stream. */
    beginInboundTrace(event) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const kind = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined;
        const chatId = kind !== undefined
            ? buildChatId(kind, String(kind === 'group' ? event.group_id ?? '' : event.user_id ?? ''))
            : '';
        const messageId = event.message_id === undefined || event.message_id === null ? undefined : String(event.message_id);
        const traceId = currentInjectRound()?.traceId ?? newTraceId(sink.now());
        const scope = sink.scope(traceId, chatId, messageId);
        sink.emit({ traceId: scope.traceId, stage: 'inbound', ok: true, chatId, messageId, data: { messageType: String(event.message_type ?? '') } });
        return scope;
    }
    async processInbound(inbound) {
        return await this.inbound.processInbound(inbound);
    }
    /** Feed one user message into a chat's agent (create on demand). Records
     * the base text for /retry, queues the initiator's turn role, and applies
     * per-chat /goal + /plan prefixes. */
    async dispatchFollowup(chatId, text, role, nickname, listeningRevision, userId) {
        const listeningStamp = listeningRevision ?? (chatId.startsWith('private:') ? listeningFor(this).state(chatId).revision : undefined);
        const final = callsFor(this).decorate(chatId, this.prefixTurn(chatId, text));
        const fallback = this.chats.get(chatId)?.lastNickname ?? '';
        const chat = await this.ensureChat(chatId, nickname ?? fallback);
        if (nickname !== undefined && nickname !== '')
            chat.lastNickname = nickname;
        chat.lastFollowup = text;
        chat.lastActivityAt = Date.now();
        // M3-D2a: a dispatched user turn starts a fresh interim cycle (the
        // inbound residue reset already cleared the loop fields directly).
        this.interim.onNewUserTurn(chat);
        // Queue this turn's initiator role; the host's turn/start freezes it as
        // the running turn's role (M1-A2). Push and followup happen synchronously,
        // so the role cannot interleave with another dispatch.
        chat.pendingTurnRoles.push(role);
        (chat.pendingTurnActors ??= []).push(String(userId ?? (chatId.startsWith('private:') ? chatId.slice(8) : '')));
        listeningFor(this).dispatch(chatId, listeningStamp);
        this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120));
        // Plugin-originated user message: the session log attributes QQ inbound
        // messages to this plugin's own producer-owned source kind, keeping them
        // distinguishable from host/web UI inputs.
        chat.agent.followup(createUserMessage({
            content: [{ type: 'text', text: final }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        // W1 cross-stream join: the turn's session events arrive on a different
        // async chain, so record this dispatch's traceId per chat for
        // onSessionEvent to pick up (runs inside the inbound ALS scope — command
        // dispatches reach here through the same await chain).
        const trace = currentTrace();
        if (trace !== undefined) {
            this.traceByChat.set(chatId, trace.traceId);
            trace.emit('dispatch', { ok: true, reason: '消息已投递给模型' });
        }
        // W1/T5 inject bookkeeping: an injected dispatch registers its round for
        // this chat (the async reply stays attributable — INDEPENDENT of tracing,
        // so the dry-run guard also works with the trace sink off); a real
        // dispatch clears any leftover injected round so real users are never
        // collaterally intercepted by the dry-run guard.
        const injectedRound = currentInjectRound();
        if (injectedRound !== undefined)
            this.injectRoundByChat.set(chatId, injectedRound.traceId);
        else
            this.injectRoundByChat.delete(chatId);
        this.deps.config.inject?.noteDispatch(chatId);
        this.startTyping(chat);
    }
    /** Prepend per-chat context directives (/goal reminder) to a turn's user
     * text. Plan mode is host-owned now (/plan forwards to the host command),
     * so the agent's own plan-mode instruction section governs planning. */
    prefixTurn(chatId, text) {
        let out = text;
        const goal = this.registry.getSettings(chatId).goal;
        if (goal !== undefined && goal.trim() !== '') {
            out = '【当前目标】' + goal + '\n' + out;
        }
        return out.trim();
    }
    /** Per-chat outbound-mode override (/mode), falling back to the global config. */
    effectiveInterim(chatId) {
        return this.registry.getSettings(chatId).interimOverride ?? this.deps.config.interimMessages;
    }
    /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
    relayHostCards(chatId, content) {
        relayCards(this.cardRelayCtx, chatId, content);
    }
    /** The CardRelayContext handed to the card relay (D1-PR2): the outbound
     * send path plus the bridge log — the only capabilities the relay touches. */
    get cardRelayCtx() {
        return {
            sendToChat: (chatId, text) => this.sendToChat(chatId, text),
            log: (level, message) => this.deps.log(level, message),
        };
    }
    /**
     * Slash-command router. Commands are admin-only (the Hermes member
     * slash-command block) and are matched on the first word; a leading
     * @mention glued to the command (QQ group at + text) is stripped first.
     * A path like /tmp/x is never a command (command words are
     * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
     * message reaches the model, matching the Hermes "fall through" behavior.
     * @param chatId - the chat the command arrived in.
     * @param text - parsed inbound text.
     * @param userId - sender QQ number.
     * @param nickname - sender display name (pre-sanitized; T9-A /steer boundary).
     * @returns true when the message was consumed by a command.
     */
    tryHandleCommand(chatId, text, userId, nickname) {
        return routeCommand(this.commandCtx, chatId, text, userId, nickname);
    }
    /**
     * The CommandContext handed to the command table (D1-PR1): exposes exactly
     * the bridge capabilities the routed commands use, resolved live per
     * invocation (the llm catalog especially must stay a live service lookup).
     */
    get commandCtx() {
        const bridge = this;
        return {
            sendToChat: (chatId, text) => bridge.sendToChat(chatId, text),
            log: (level, message) => bridge.deps.log(level, message),
            isAdmin: userId => classifyUserRole(userId, bridge.deps.policy.adminUsers) === 'admin',
            getChat: chatId => bridge.chats.get(chatId),
            hasChat: chatId => bridge.chats.has(chatId),
            resetChat: chatId => bridge.resetChat(chatId),
            dispatchFollowup: (chatId, text, role, nickname) => bridge.dispatchFollowup(chatId, text, role, nickname),
            // T3 (P2): /stop 也显式终止该聊天的超时补发跟踪（其他聊天不受影响）。
            stopDeferredTracking: chatId => bridge.deferred.cancelChat(chatId),
            // T2 (P1): /steer — the bridge-owned steer core keeps the createUserMessage
            // source write point in bridge.ts (producer-owned kind, session-v4 guard).
            steerRunningTurn: (chatId, text) => bridge.steerMessage(chatId, text),
            effectiveCwd: chatId => bridge.effectiveCwd(chatId),
            sessionIdFromMapping: chatId => bridge.sessionIdFromMapping(chatId),
            resolvePresetId: chatId => bridge.resolvePresetId(chatId),
            // T3: /workspace persists with the chat mapping (debounced). When the
            // chat is not live, noteWorkspaceOverride snapshots it into the registry
            // so the flush actually reaches the mapping file instead of being
            // dropped by the chats/evictedChats-only rewrite.
            setChatWorkspacePath: (chatId, path) => {
                bridge.registry.getSettings(chatId).workspacePath = path;
                bridge.registry.noteWorkspaceOverride(chatId);
                bridge.registry.saveMappingDebounced();
            },
            presetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride,
            setPresetOverride: (chatId, id) => { bridge.registry.getSettings(chatId).presetOverride = id; },
            hasPresetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride !== undefined,
            interimOverride: chatId => bridge.registry.getSettings(chatId).interimOverride,
            // D4b: /mode and /goal persist with the chat mapping (debounced).
            setInterimOverride: (chatId, value) => { bridge.registry.getSettings(chatId).interimOverride = value; bridge.registry.saveMappingDebounced(); },
            goal: chatId => bridge.registry.getSettings(chatId).goal,
            setGoal: (chatId, value) => { bridge.registry.getSettings(chatId).goal = value; bridge.registry.saveMappingDebounced(); },
            deleteGoal: chatId => { bridge.registry.getSettings(chatId).goal = undefined; bridge.registry.saveMappingDebounced(); },
            lastImagePath: chatId => bridge.registry.getSettings(chatId).lastImagePath,
            // R2: pending serial-number selection snapshot (lazy TTL lives in commands).
            pendingSelection: chatId => bridge.registry.getSettings(chatId).pendingSelection,
            setPendingSelection: (chatId, value) => { bridge.registry.getSettings(chatId).pendingSelection = value; },
            // /session: the per-chat switchable history and the switch itself.
            switchableSessions: chatId => bridge.registry.switchableSessions(chatId),
            switchSession: (chatId, targetSessionId) => bridge.registry.switchSession(chatId, targetSessionId),
            // /session list previews: cold-read each retired session's first user
            // input through the persistence port (read handle, small prefix).
            sessionPersistence: bridge.deps.sessionPersistence,
            takePendingImageRef: chatId => {
                const settings = bridge.registry.getSettings(chatId);
                const ref = settings.pendingImageRef;
                if (ref !== undefined)
                    settings.pendingImageRef = undefined;
                return ref;
            },
            resolveMediaRef: (ref, chatId) => bridge.resolveMediaRef(ref, chatId),
            llmCatalog: bridge.deps.llmCatalog,
            workspaceRegistry: bridge.deps.workspaceRegistry,
            agentDefaultModel: bridge.deps.agentDefaultModel,
            agentPresets: bridge.deps.agentPresets,
            commands: bridge.deps.commands,
            connection: bridge.deps.connection,
            dshHome: bridge.deps.dshHome,
            // W1/T5: the healthcheck command renders/packs through the bridge.
            healthReport: () => bridge.buildHealthReport(),
            // T4 (P3): export takes an optional trigger reference (file-name stamp).
            exportDiagnostics: triggerRef => bridge.exportDiagnosticsPackage(triggerRef),
            // T4 (P3): command-plane failures (/retry) mint an MF- reference through
            // the bridge's single entry point (registry + trace + structured log).
            reportFailure: (chatId, stage, detail) => bridge.registerMessageFailure(chatId, stage, detail),
            config: { interimMessages: bridge.deps.config.interimMessages, maxImageBytes: bridge.deps.config.maxImageBytes, unknownCommand: bridge.deps.config.unknownCommand },
        };
    }
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    async sessionIdFromMapping(chatId) {
        return this.registry.sessionIdFromMapping(chatId);
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    buildBody(text, media, chatId) {
        return this.inbound.buildBody(text, media, chatId);
    }
    /** Resolve one media ref to a text annotation with a local path. */
    resolveMediaRef(ref, chatId) {
        return this.inbound.resolveMediaRef(ref, chatId);
    }
    /** M3-D4c: steer a completed voice transcript into the chat's agent — the
     * running turn consumes it at its nearest step boundary; an idle agent
     * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
    steerTranscript(chatId, text) {
        if (this.steerMessage(chatId, transcriptLabel(text)))
            return;
        this.deps.log('debug', 'voice transcript dropped (no live chat): ' + chatId);
        currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.transcriptNoChat });
    }
    /** T2 (P1): the single agent.steer write point — one createUserMessage with
     * the producer-owned source kind (the session-v4 guard counts the source
     * write points; this and dispatchFollowup are the only two). Shared by the
     * voice transcript path (steerTranscript), the 'steer' policy and /steer.
     * Returns false when the chat has no live agent (nothing was steered). */
    steerMessage(chatId, text, listeningRevision) {
        const chat = this.chats.get(chatId);
        if (chat === undefined)
            return false;
        listeningFor(this).adopt(chatId, listeningRevision);
        chat.agent.steer(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        return true;
    }
    /**
     * T2 (P1): the busy-turn policy seam (inbound ctx.interceptBusyTurn).
     * Called for every non-command message AFTER all gates, only when deciding
     * what to do with it while the chat's task is running:
     * - no running turn → false (caller dispatches normally; the 0.8.1 path,
     *   byte-identical — also the path for newMessagePolicy缺省 idle traffic);
     * - 'steer' policy + plain text + non-restricted sender + autoSteerPolicy
     *   eligibility ('admin' 档缺省 = 仅管理员；'all' 档不限，T9-B 用户裁决
     *   2026-10-12) → the message is submitted into the running turn via the
     *   steerMessage kernel (consumed at the nearest step boundary, NO new turn)
     *   and a submit notice goes out;
     * - otherwise (queue policy default / media-quote-forward message /
     *   restricted group member / 不具备自动插话资格) → the 0.8.1 dispatch path
     *   (agent.followup queues it as the next turn: consumed after the current
     *   turn ends, in arrival order) plus the queue notice at most once per
     *   running turn.
     * The running check reads the agent's own lifecycle state — the same
     * authoritative signal /stop uses; chat.busy (turn/start..turn/end view)
     * can lag the host driver and is deliberately NOT consulted.
     */
    async interceptBusyTurn(chatId, text, role, nickname, plain, listeningRevision, userId) {
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.agent.status !== 'running')
            return false;
        // The restricted-member soft limit ([受限用户:仅问答]) is never widened by
        // the steer policy: restricted senders' messages queue like everyone
        // else's media. The condition mirrors the RESTRICTED_PREFIX application
        // in the inbound pipeline (group + non-admin + restrictedMemberPrefix).
        const restricted = splitChatId(chatId).kind === 'group'
            && role !== 'admin' && this.deps.config.restrictedMemberPrefix;
        // T9-B: auto-steer eligibility (user ruling 2026-10-12) — 'admin' (缺省)
        // = admins only; 'all' = anyone. Restricted members stay excluded under
        // both; /steer remains admin-only regardless of this knob; queue mode is
        // untouched.
        const autoSteerAllowed = (this.deps.config.autoSteerPolicy ?? 'admin') === 'all' || role === 'admin';
        if ((this.deps.config.newMessagePolicy ?? 'queue') === 'steer' && plain && !restricted && autoSteerAllowed) {
            this.steerMessage(chatId, text, listeningRevision);
            currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnSteered });
            // [dsh-p1] v2.11 quiet steer（4.37）：插话被当前回合吃进去就行，
            // 不再播报「✅ 已作为补充指令提交…」这类系统公告（/steer 显式命令的
            // 回执保留在 commands.js，不受影响）。
            return true;
        }
        await this.dispatchFollowup(chatId, text, role, nickname, listeningRevision, userId);
        currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnQueued });
        // [dsh-p1] quiet notices: queue silently; a human does not announce it.
        return true;
    }
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    expandQuote(messageId) {
        return this.inbound.expandQuote(messageId);
    }
    // ------------------------------------------------------------ outbound
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        return this.outbound.sendMsg(chatId, segments, options);
    }
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    async sendForward(chatId, nodes) {
        return this.outbound.sendForward(chatId, nodes);
    }
    // ------------------------------------------------------------ inject dry-run guard
    /**
     * W1/T5: the single connection-call gate every bridge pipeline
     * (inbound/outbound/interim/typing) routes through. In inject dry-run
     * mode, WRITE actions of an injected round are intercepted at this
     * outbound action layer: counted, traced with the original text, resolved
     * with the marker message id — the real OneBot connection never sees them.
     * Attribution: (a) the synchronous chain via the inject round's ALS, (b)
     * the async agent reply via the chat→round association (injectRoundByChat,
     * independent of the trace sink), (c) recalls of already-intercepted sends
     * via the marker message id (a real OneBot id is never negative).
     */
    guardedConnectionCall(action, params, chatId) {
        const inject = this.deps.config.inject;
        if (inject === undefined || !inject.intercepting || !isWriteAction(action)) {
            return this.deps.connection.call(action, params);
        }
        const alsRound = currentInjectRound();
        if (alsRound !== undefined)
            return inject.intercept(alsRound, action, params);
        if (chatId !== undefined) {
            const round = inject.activeRoundFor(chatId);
            if (round !== undefined && this.injectRoundByChat.get(chatId) === round.traceId) {
                return inject.intercept(round, action, params);
            }
        }
        if (params.message_id === INTERCEPTED_MESSAGE_ID) {
            // Recall of an intercepted send (interim path has no chatId): count it
            // on the marker rule even without a resolvable round.
            return inject.intercept(undefined, action, params);
        }
        return this.deps.connection.call(action, params);
    }
    // ------------------------------------------------------------ health (W1/T5)
    /** The health deps the /healthcheck command renders from (resolved live). */
    healthDeps() {
        const conn = this.deps.connection;
        const transport = conn.config ?? {};
        const recorder = this.deps.config.recorder;
        const inject = this.deps.config.inject;
        return {
            mediaDir: this.deps.config.mediaDir,
            connection: { connected: this.deps.connection.connected, selfId: this.deps.connection.selfId },
            transport: { mode: String(transport.mode ?? '未知'), host: String(transport.host ?? ''), port: Number(transport.port ?? 0) },
            retryState: {
                reverseRetryAttempts: conn.reverseRetryAttempts,
                reconnectAttempts: conn.reconnectAttempts,
                selfHealing: conn.selfHealing,
            },
            dedup: {
                entries: this.inbound.dedupWindowEntries,
                // The W2-② window key rides as an optional intersection member.
                windowSeconds: this.deps.config.dedupWindowSeconds ?? 300,
            },
            writeGate: this.outbound.writeGateStats(),
            ...(recorder !== undefined
                ? { recorder: { enabled: true, redact: recorder.redact, written: recorder.getStats().written } }
                : {}),
            ...(inject !== undefined
                ? {
                    inject: {
                        enabled: true, dryRun: inject.intercepting,
                        consumed: inject.getStats().consumed, intercepted: inject.getStats().intercepted,
                        skippedHistory: inject.getStats().skippedHistory,
                    },
                }
                : {}),
            configSnapshot: this.deps.configSnapshot?.() ?? {},
            // T4 (P3): the recent fault references for the report section.
            failureRefs: () => this.failureRefs.recent(),
            log: (level, message) => this.deps.log(level, message),
        };
    }
    /** /healthcheck: render the health summary. */
    async buildHealthReport() {
        return healthReport(this.healthDeps());
    }
    /** /healthcheck export: pack the redacted diagnostics archive. T4 (P3): the
     * file name carries the trigger reference — the explicit command argument,
     * or the most recent recorded fault reference when omitted. */
    async exportDiagnosticsPackage(triggerRef) {
        const deps = this.healthDeps();
        return exportDiagnostics({ ...deps, triggerRef: triggerRef ?? this.failureRefs.recent(1)[0]?.ref });
    }
    // ------------------------------------------------------------ session events
    onSessionEvent(session, event) {
        if (helperSessionEvent(this, session, event)) return;
        if (journalSessionEvent(this, session, event)) return;
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined) {
            // pipeline-hooks.md #20: non-QQ sessions (web/host) ride this same bus;
            // keep the early exit visible at debug without emitting any trace.
            this.deps.log('debug', 'session 事件早退：无 chat 映射（session=' + session.id + ' type=' + String(event.type) + '）');
            return;
        }
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.sessionId !== session.id)
            return;
        const trace = this.traceForChat(chatId);
        callsFor(this).onSessionEvent(chatId, event);
        if (event.type === 'turn/start') {
            listeningFor(this).beginTurn(chatId);
            reactionPolicy(this).beginTurn(chatId);
            trace?.emit('agent', { ok: true, reason: '模型回合开始' });
            // B8: a new turn begins — prune the previous turn's recalled-id
            // residue (see InterimTracker.onTurnStart for the safety analysis).
            this.interim.onTurnStart(chat);
            // Freeze the running turn's initiator role from the dispatch FIFO
            // (M1-A2): turns the plugin did not dispatch (host/web input) find an
            // empty queue and fail closed as member.
            chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member';
            chat.activeTurnUserId = chat.pendingTurnActors?.shift() ?? '';
            chat.activeTurnSequence = (chat.activeTurnSequence ?? 0) + 1;
            chat.lastActivityAt = Date.now();
            chat.busy = true;
            // T3 (P2): arm the deferred silent-wait window for this turn（每次模型
            // 输出重置；turn/end 解除；deferredTimeoutMs<=0 时为 no-op）。
            this.deferred.onTurnStart(chatId, session.id);
            return;
        }
        if (event.type === 'assistant/message') {
            // T3 (P2): a deferred-registered (timed-out) turn is muted — its text
            // messages are captured for the final补发 only（不插播 interim、不转
            // 审批/提问卡：超时后只补最终文字与终态通知）。
            if (this.deferred.onAssistantMessage(chatId, session.id, event.data.message))
                return;
            if (chatFlowFor(this).onAssistant(session, event, chatId)) { chat.loopPending = null; return; }
            this.interim.onAssistantMessage(chatId, chat, event.data.message);
            return;
        }
        if (event.type === 'turn/end') {
            listeningFor(this).endTurn(chatId);
            const reason = event.data.reason;
            // T4 (P3): a message-turn fault mints ONE MF- reference before any
            // consumer runs — the trace event (data.ref), the structured log line,
            // the ⚠️ notice tail and the deferred terminal text all carry the same
            // number. Normal (completed/cancelled) turns mint nothing.
            const errorRef = reason.kind === 'error'
                ? this.mintFailureRef('msg', 'agent', '模型回合出错: ' + reason.error.message, { chatId })
                : undefined;
            // T3 (P2): complete a deferred entry（补发异步进行）；true = the turn was
            // under deferred tracking — the terminal-state notice rides the补发
            // path, so the normal error notice below is suppressed（同一故障不双发）.
            const deferredTracked = this.deferred.onTurnEnd(chatId, session.id, reason, errorRef);
            this.interim.onTurnEnd(chatId, chat);
            if (reason.kind === 'error') {
                // T4: the ok:false agent event is emitted by mintFailureRef (with
                // data.ref) — no second event for the same decision point.
            }
            else {
                trace?.emit('agent', { ok: true, reason: '模型回合结束（' + reason.kind + '）' });
            }
            if (reason.kind === 'error') {
                const message = reason.error.message;
                // 基线语义保持：碰撞自愈原本挂在 sendErrorNotice 分支内；deferred
                // 回合的终态走补发通道，也必须自愈，故闸为 sendErrorNotice || deferredTracked。
                if ((this.deps.config.sendErrorNotice || deferredTracked)
                    && /persisted log on disk that does not match this live session|id collision/i.test(message)) {
                    void this.healSessionCollision(chatId);
                }
                if (!deferredTracked && this.deps.config.sendErrorNotice) {
                    this.sendToChat(chatId, '⚠️ 运行出错：' + message + failureRefSuffix(errorRef), { queuable: true }).catch((error) => {
                        // pipeline-hooks.md #21: the send failure used to be swallowed.
                        this.deps.log('debug', '错误通知发送失败: ' + describeError(error));
                        trace?.emit('notice', { ok: false, reason: TRACE_REASONS.noticeErrorSendFailed });
                    });
                }
            }
            this.stopTyping(chat);
            chat.lastActivityAt = Date.now();
            chat.busy = false;
            // T2 (P1): the turn that armed the queue notice is over — a later
            // running turn notifies again.
            this.queueNoticeChats.delete(chatId);
            this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind);
            // Durable: flush the session so a later restart can resume it.
            void this.deps.sessions.flush(chat.agent.session).catch((error) => {
                this.deps.log('warn', 'session flush failed: ' + String(error));
                trace?.emit('notice', { ok: false, reason: '会话落盘失败: ' + String(error) });
            });
            void this.saveMappingDebounced();
        }
    }
    /** W1: the trace scope for one chat's session events, resolved through the
     * chat-level association table; undefined when tracing is off or the chat
     * has no recorded dispatch (host-initiated turns stay untraced). */
    traceForChat(chatId) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const traceId = this.traceByChat.get(chatId);
        return traceId !== undefined ? sink.scope(traceId, chatId) : undefined;
    }
    // ------------------------------------------------------ failure references (W3/T4)
    /**
     * T4 (P3): the single fault-reference entry point. Mints one QQ-CONN-/MF-
     * number, records it in the bounded registry, emits the ok:false trace
     * event carrying `data.ref` (traceId = the chat's mapped id, or a fresh id
     * for chat-less connection faults), and writes the structured error log
     * line — every surface of the fault shares this one number. Called only on
     * fault events: normal traffic mints nothing (zero overhead).
     */
    mintFailureRef(kind, stage, detail, opts = {}) {
        const ref = this.failureRefs.mint(kind);
        const traceId = opts.chatId !== undefined ? this.traceByChat.get(opts.chatId) : undefined;
        this.failureRefs.record({ ref, kind, ts: Date.now(), stage, detail, traceId });
        const sink = this.deps.config.trace;
        if (sink !== undefined && sink.enabled) {
            sink.emit({
                traceId: traceId ?? newTraceId(sink.now()),
                chatId: opts.chatId,
                stage,
                ok: false,
                reason: detail,
                data: { ref, refKind: kind },
            });
        }
        this.deps.log('error', '故障参考号 ' + ref + ' [' + stage + ']: ' + detail);
        return ref;
    }
    /** T4: connection-fault reference entry (wired from index.ts via
     * `connection.onFailure`); the returned reference is appended to the
     * transport's own log line. */
    registerConnectionFailure(stage, detail) {
        return this.mintFailureRef('conn', 'connection', detail);
    }
    /** T4: message-fault reference entry for command-plane failures (e.g. the
     * /retry dispatch throw); the caller appends the returned reference to the
     * user-visible ⚠️ notice. */
    registerMessageFailure(chatId, stage, detail) {
        return this.mintFailureRef('msg', stage, detail, { chatId });
    }
    async onSessionFlush(session) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined)
            return;
        // M1-E2: arbitrary session flushes debounce like turn/end — stop() still
        // forces the final saveMapping directly.
        this.saveMappingDebounced();
    }
    // ------------------------------------------------------------ registry facades
    /** Same-name delegations to the chat registry (D1-PR3): the command table's
     * ctx, the interim/turn event links and the outbound pipeline keep calling
     * the bridge exactly as before the split. */
    /** Get (or create) the agent for a chat. */
    ensureChat(chatId, nickname) {
        return this.registry.ensureChat(chatId, nickname);
    }
    effectiveCwd(chatId) {
        return this.registry.effectiveCwd(chatId);
    }
    resolvePresetId(chatId) {
        return this.registry.resolvePresetId(chatId);
    }
    saveMappingDebounced() {
        this.registry.saveMappingDebounced();
    }
    healSessionCollision(chatId) {
        return this.registry.healSessionCollision(chatId);
    }
    /**
     * /new: the registry disposes the agent and retires its session id so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The confirmation is sent directly through
     * the outbound pipeline since no agent is left to reply.
     */
    async resetChat(chatId) {
        await this.registry.resetChat(chatId);
        this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。').catch((error) => {
            this.deps.log('warn', 'reset notice send failed: ' + String(error));
        });
    }
    /**
     * Compose the QQ channel's scoped world for one agent: the QQ platform
     * prompt section and the qq_* tools. Registered on `agentCtx` (the agent's
     * own scope) instead of the plugin context, so Web/local sessions never see
     * the channel instructions or the media tools — they cannot (and should
     * not) push messages to QQ.
     */
    installChannelScope(agentCtx) {
        this.makeUserMessage = createUserMessage;
        installWorkingContext(agentCtx, this, createUserMessage);
        agentCtx.systemPrompt.section({ name: 'channel:single-reply', order: 92, text: SINGLE_REPLY_GUIDANCE });
        agentCtx.systemPrompt.section({ name: 'channel:chat-flow', order: 91, text: GROUP_CONVERSATION_GUIDANCE + '\n' + CHAT_FLOW_GUIDANCE });
        agentCtx.systemPrompt.section({
            name: 'channel:dsh-onebot',
            order: 90,
            text: buildPlatformPrompt(this.deps.config.restrictedMemberPrefix),
        });
        registerTools(agentCtx, this, this.deps.connection, {
            maxImageBytes: this.deps.config.maxImageBytes,
            maxVoiceBytes: this.deps.config.maxVoiceBytes,
            maxFileBytes: this.deps.config.maxFileBytes,
        });
    }
    // ------------------------------------------------------------ typing
    /** Start the NapCat typing indicator (private chats only). */
    startTyping(chat) {
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        this.stopTyping(chat);
        const pulse = () => {
            if (this.stopping)
                return;
            void this.guardedConnectionCall('set_input_status', {
                user_id: Number(ref.target),
                event_type: 1,
            }, chat.chatId).catch(() => undefined);
        };
        pulse();
        chat.typingTimer = setInterval(pulse, 5_000).unref();
    }
    /** Stop the typing indicator. */
    stopTyping(chat) {
        if (chat.typingTimer !== undefined) {
            clearInterval(chat.typingTimer);
            chat.typingTimer = undefined;
        }
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        void this.guardedConnectionCall('set_input_status', {
            user_id: Number(ref.target),
            event_type: 0,
        }, chat.chatId).catch(() => undefined);
    }
}
export { OneBotNotConnectedError, OneBotActionError } from './connection.js';

// -- [dsh-p1] friend requests ------------------------------------------------------------
// QQ friend requests arrive as post_type=request / request_type=friend; the
// inbound pipeline normally drops them. Forward to the admin, then let the
// admin settle them with `同意 <QQ>` / `拒绝 <QQ>` (never sent to the model).
//
// [dsh-p1] friend store: pending requests persist in
// <mediaDir>/friend-requests.json (24h TTL), so a DSH restart no longer
// forgets a request the admin has not answered yet.
const FRIEND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const friendStores = new WeakMap();

function friendStore(bridge) {
    let store = friendStores.get(bridge);
    if (store === undefined) {
        store = new FriendRequestStore({
            mediaDir: bridge?.deps?.config?.mediaDir ?? '',
            ttlMs: FRIEND_REQUEST_TTL_MS,
            log: (level, message) => {
                try {
                    bridge?.deps?.log(level, message);
                }
                catch { /* logging must never break the bridge */ }
            },
        });
        friendStores.set(bridge, store);
    }
    return store;
}

function friendAdminList(bridge) {
    const admins = bridge?.deps?.policy?.adminUsers;
    return Array.isArray(admins) ? admins.map(String) : [];
}

async function handleFriendRequestEvent(bridge, event) {
    // [dsh-p1] friend store: see every request event, even ones we cannot settle.
    if (event?.post_type === 'request')
        bridge.deps.log('info', 'request event: request_type=' + String(event.request_type ?? '') + ' user=' + String(event.user_id ?? '') + ' flag=' + (event.flag ? 'yes' : 'no'));
    if (event?.post_type !== 'request' || event?.request_type !== 'friend')
        return false;
    const userId = String(event.user_id ?? '');
    const flag = String(event.flag ?? '');
    if (userId === '' || flag === '')
        return false;
    const admins = friendAdminList(bridge);
    if (admins.length === 0)
        return false;
    // [dsh-p1] durable friend notifications: live events and scans share history.
    try { await friendNotificationsFor(bridge, friendStore(bridge)).event(event); }
    catch (error) { bridge.deps.log('warn', 'friend request: ' + describeError(error)); }
    return true;
}

async function handleFriendApprovalReply(bridge, text, userId, replyId) {
    const admins = friendAdminList(bridge);
    if (!admins.includes(String(userId)))
        return false;
    // Tolerate the shapes an admin actually types: 「同意 123」, "同意123",
    // 同意QQ123, 同意：123 — and a bare 同意/拒绝 when exactly one request is
    // pending, or when the message is a QQ reply to ONE notification (then the
    // quoted message id says which request he means).
    const cleaned = String(text ?? '').trim()
        // A QQ reply segment makes parseMessage prefix the body with [引用].
        .replace(/^\[(引用|回复)\]\s*/, '')
        .replace(/^[\s「『"'“”‘’（(【\[]+/, '')
        .replace(/[\s」』"'“”‘’）)】\]]+$/, '');
    const match = cleaned.match(/^\/?(同意|通过|拒绝|不同意)\s*(?:QQ|qq)?\s*[:：]?\s*(\d{5,})$/);
    const store = friendStore(bridge);
    const ttl = FRIEND_REQUEST_TTL_MS;
    let approve = false;
    let target = '';
    let pending;
    if (match !== null) {
        approve = match[1] === '同意' || match[1] === '通过';
        target = match[2];
    }
    else {
        const bare = cleaned.match(/^\/?(同意|通过|拒绝|不同意)(?:这个|这条|一下)?$/);
        if (bare === null)
            return false;
        approve = bare[1] === '同意' || bare[1] === '通过';
        let pendingList = [];
        try {
            pendingList = (await store.list()).filter(row => Date.now() - Number(row.at ?? 0) <= ttl);
        }
        catch {
            return false;
        }
        // 1) reply-quoted notification: that exact request
        if (replyId !== undefined && replyId !== '') {
            const quoted = pendingList.find(row => String(row.notifyId ?? '') === String(replyId));
            if (quoted !== undefined) {
                target = quoted.userId;
                pending = quoted;
            }
            else {
                // 1b) id mapping missing (old notification, restart, adapter id
                // shape): read the quoted message and take the QQ number in it.
                try {
                    const quotedMsg = await bridge.guardedConnectionCall('get_msg', { message_id: Number(replyId) });
                    const quotedText = String(quotedMsg?.raw_message ?? quotedMsg?.message ?? '');
                    const hit = quotedText.match(/QQ\s*(\d{5,})/);
                    if (hit !== null) {
                        const row = pendingList.find(item => String(item.userId) === hit[1]);
                        if (row !== undefined) {
                            target = row.userId;
                            pending = row;
                        }
                    }
                }
                catch { /* fall through to the unambiguous case */ }
            }
        }
        // 2) a quoted notification that no longer matches is NOT a licence to
        // guess another request (it was probably already settled) — say so.
        if (target === '' && replyId !== undefined && replyId !== '') {
            bridge.deps.log('info', 'friend approval stale quote: replyId=' + String(replyId));
            await bridge.sendToChat('private:' + userId, '这条申请已经处理过了，或者找不到对应的人。');
            return true;
        }
        // 3) nothing quoted: only safe when there is exactly one pending
        if (target === '' && pendingList.length === 1) {
            target = pendingList[0].userId;
            pending = pendingList[0];
        }
        if (target === '') {
            bridge.deps.log('info', 'friend approval ambiguous: replyId=' + String(replyId ?? '') + ' pending=' + pendingList.length);
            await bridge.sendToChat('private:' + userId, pendingList.length === 0
                ? '现在没有待处理的好友申请。'
                : '有 ' + pendingList.length + ' 条待处理，引用那条申请回我「同意/拒绝」，或者发「同意 QQ」。');
            return true;
        }
    }
    if (pending === undefined)
        pending = await store.get(target);
    bridge.deps.log('info', 'friend approval: text=' + cleaned + ' replyId=' + String(replyId ?? '') + ' target=' + (target === '' ? '?' : target));
    if (pending === undefined) {
        await bridge.sendToChat('private:' + userId, '没有找到 QQ ' + target + ' 的好友请求，可能已经处理过或已过期。');
        return true;
    }
    try {
        await bridge.guardedConnectionCall('set_friend_add_request', { flag: pending.flag, approve });
        await store.settle(target, pending.flag);
        if (approve)
            await recordFriendAdded(bridge, target, pending.comment ?? '');
        await bridge.sendToChat('private:' + userId, (approve ? '已经同意 ' : '已经拒绝 ') + target + ' 的好友请求。');
    }
    catch (error) {
        await bridge.sendToChat('private:' + userId, '处理 ' + target + ' 的好友请求失败：' + (error?.message ?? String(error)));
    }
    return true;
}

// -- [dsh-p1] buddy watch ------------------------------------------------------------
// NapCat exposes no OneBot API that lists friend requests, and its `request`
// event only fires for unread entries. tools/patch_napcat_buddy_dump.py makes
// NapCat dump FriendApi.getBuddyReq() to media/onebot/buddy-requests.json every
// 30s; this watcher forwards new entries to the admin (same flow/message as the
// event path, flag = reqTime so 同意/拒绝 still works).
const BUDDY_WATCH_MS = 10_000;
const buddyWatchTimers = new WeakMap();

async function buddyWatchTick(bridge) {
    try { await friendNotificationsFor(bridge, friendStore(bridge)).scan(); }
    catch (error) { bridge.deps.log('warn', 'buddy watch: ' + describeError(error)); }
    return '';
}

function startBuddyWatch(bridge) {
    if (buddyWatchTimers.has(bridge))
        return;
    const timer = setInterval(() => { void buddyWatchTick(bridge).catch(() => undefined); }, BUDDY_WATCH_MS);
    timer.unref?.();
    buddyWatchTimers.set(bridge, timer);
    void buddyWatchTick(bridge).catch(() => undefined);
}

function stopBuddyWatch(bridge) {
    const timer = buddyWatchTimers.get(bridge);
    if (timer !== undefined) {
        clearInterval(timer);
        buddyWatchTimers.delete(bridge);
    }
}

// -- [dsh-p1] profiles + poke: 戳一戳 -------------------------------------------
const pokeTurnAt = new Map();
const pokeTextAt = new Map();

async function pokeBack(bridge, isGroup, groupRaw, userId) {
    try {
        if (isGroup)
            await bridge.guardedConnectionCall('group_poke', { group_id: Number(groupRaw), user_id: Number(userId) });
        else
            await bridge.guardedConnectionCall('friend_poke', { user_id: Number(userId) });
    }
    catch (error) {
        bridge.deps.log('warn', 'poke back failed: ' + describeError(error));
    }
}

async function handlePokeNotice(bridge, event) {
    const selfId = String(bridge?.deps?.connection?.selfId ?? '');
    const userId = String(event?.user_id ?? '');
    const target = String(event?.target_id ?? '');
    if (selfId === '' || userId === '' || target !== selfId)
        return false;
    const groupRaw = event?.group_id === undefined || event?.group_id === null ? '' : String(event.group_id);
    const isGroup = groupRaw !== '' && groupRaw !== '0';
    const chatId = isGroup ? 'group:' + groupRaw : 'private:' + userId;
    const now = Date.now();
    // [dsh-p1] every poke is processed; the 2s guard only merges the SAME poke
    // seen twice (gray-tip watcher + OneBot notice), not successive pokes.
    if (now - (pokeTurnAt.get(chatId) ?? 0) < 2_000)
        return true;
    pokeTurnAt.set(chatId, now);
    // Within 30s of the last text-capable poke turn, answer silently: just poke back.
    if (now - (pokeTextAt.get(chatId) ?? 0) < 30_000) {
        await pokeBack(bridge, isGroup, groupRaw, userId);
        bridge.deps.log('info', 'poke (silent back) in ' + chatId + ' from ' + userId);
        return true;
    }
    pokeTextAt.set(chatId, now);
    // [dsh-p1] active chat: poke back deterministically before the model turn, so the
    // action needs no narration. The synth text below tells her it already
    // happened; the prompt keeps her from poking twice or announcing it.
    await pokeBack(bridge, isGroup, groupRaw, userId);
    let nickname = String(event?.sender?.nickname ?? '');
    if (nickname === '') {
        try {
            const info = await bridge.guardedConnectionCall('get_stranger_info', { user_id: Number(userId) });
            nickname = String(info?.nickname ?? info?.data?.nickname ?? '');
        }
        catch { /* nickname is optional */ }
    }
    // 句尾用「戳了你一下」而不是「戳了戳你」：后者以「你」结尾，会被碎片识别
    // 当成「话没说完」压 12 秒（2026-10-25 群友戳她没反应的根因）。
    const text = '[戳一戳] ' + (nickname === '' ? '有人' : nickname) + ' 戳了你一下（你已经自动戳回去了，别再戳同一个人）';
    const synth = {
        post_type: 'message',
        message_type: isGroup ? 'group' : 'private',
        time: event?.time,
        self_id: selfId,
        message_id: undefined,
        user_id: Number(userId),
        message: isGroup
            ? [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text } }]
            : [{ type: 'text', data: { text } }],
        raw_message: isGroup ? '[CQ:at,qq=' + selfId + ']' + text : text,
        sender: { user_id: Number(userId), nickname },
    };
    if (isGroup)
        synth.group_id = Number(groupRaw);
    bridge.deps.log('info', 'poke notice: ' + chatId + ' from ' + userId);
    await bridge.handleInbound(synth);
    return true;
}

// -- [dsh-p1] roster -----------------------------------------------------------
// QQ exposes no add time/source for friends, so keep our own roster: approvals
// record it exactly; a periodic sync marks unknown additions honestly.
const ROSTER_SYNC_MS = 5 * 60_000;
const rosterTimers = new WeakMap();

function rosterPath(bridge) {
    return (bridge?.deps?.config?.mediaDir ?? '') + '/roster.json';
}

async function readRoster(bridge) {
    try {
        const raw = await readFile(rosterPath(bridge), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch { return {}; }
}

async function writeRoster(bridge, roster) {
    try {
        await writeFile(rosterPath(bridge), JSON.stringify(roster, null, 1), 'utf8');
    }
    catch (error) {
        bridge.deps.log('warn', 'roster write failed: ' + describeError(error));
    }
}

async function recordFriendAdded(bridge, uin, comment) {
    const key = String(uin);
    if (key === '')
        return;
    noteFriendAdded(key);
    const roster = await readRoster(bridge);
    const now = Date.now();
    const cur = roster[key] ?? {};
    roster[key] = {
        ...cur,
        nickname: cur.nickname ?? '',
        remark: cur.remark ?? '',
        firstSeen: cur.firstSeen ?? now,
        addAt: now,
        source: comment !== '' ? comment : '好友申请（无验证消息）',
        verification: comment,
        how: '她批准',
        seenAt: now,
    };
    await writeRoster(bridge, roster);
}

async function syncRoster(bridge, reason) {
    let list;
    try {
        const r = await bridge.guardedConnectionCall('get_friend_list', {});
        list = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []);
    }
    catch { return; }
    const roster = await readRoster(bridge);
    // First ever sync = everything already there predates the feature; mark it
    // honestly as unknown instead of "added just now".
    const effectiveReason = Object.keys(roster).length === 0 ? 'startup' : reason;
    const now = Date.now();
    const selfId = String(bridge?.deps?.connection?.selfId ?? '');
    let changed = false;
    for (const row of list) {
        const uin = String(row.user_id ?? '');
        if (uin === '' || uin === selfId)
            continue;
        const nickname = typeof row.nickname === 'string' ? row.nickname : '';
        const remark = typeof row.remark === 'string' ? row.remark : '';
        const cur = roster[uin];
        if (cur === undefined) {
            roster[uin] = {
                nickname,
                remark,
                firstSeen: now,
                addAt: effectiveReason === 'startup' ? null : now,
                source: effectiveReason === 'startup' ? '未知（启用记录前就已是好友）' : '未知（自动发现，可能是老大手动加的）',
                verification: '',
                how: effectiveReason === 'startup' ? '' : '自动发现',
                seenAt: now,
            };
            changed = true;
            continue;
        }
        if (cur.nickname !== nickname || cur.remark !== remark) {
            cur.nickname = nickname;
            cur.remark = remark;
            changed = true;
        }
        cur.seenAt = now;
    }
    if (changed)
        await writeRoster(bridge, roster);
}

function startRosterSync(bridge) {
    if (rosterTimers.has(bridge))
        return;
    void syncRoster(bridge, 'startup');
    const timer = setInterval(() => void syncRoster(bridge, 'sync'), ROSTER_SYNC_MS);
    timer.unref?.();
    rosterTimers.set(bridge, timer);
}

function stopRosterSync(bridge) {
    const timer = rosterTimers.get(bridge);
    if (timer !== undefined) {
        clearInterval(timer);
        rosterTimers.delete(bridge);
    }
}

// -- [dsh-p1] poke watch --------------------------------------------------------
// NapCat does not emit the OneBot poke notice on this setup, but it does receive
// the gray tip (busiId 1061). patch_napcat_poke_dump.py writes the resolved
// poker/target QQ numbers to poke-raw.jsonl; here we turn new lines into the
// same poke turn the notice handler would have produced.
const POKE_WATCH_MS = 5_000;
const pokeWatchState = new WeakMap();
const pokeWatchTimers = new WeakMap();

function pokeWatchPath(bridge) {
    return (bridge?.deps?.config?.mediaDir ?? '') + '/poke-raw.jsonl';
}

async function pokeWatchTick(bridge) {
    const st = pokeWatchState.get(bridge);
    if (st === undefined || st.offset < 0)
        return;
    let buf;
    try { buf = await readFile(pokeWatchPath(bridge)); }
    catch { return; }
    if (buf.length < st.offset)
        st.offset = 0;
    if (buf.length === st.offset)
        return;
    const chunk = buf.subarray(st.offset).toString('utf8');
    const nl = chunk.lastIndexOf('\n');
    if (nl === -1)
        return;
    const complete = chunk.slice(0, nl + 1);
    st.offset += Buffer.byteLength(complete, 'utf8');
    const selfId = String(bridge?.deps?.connection?.selfId ?? '');
    if (selfId === '')
        return;
    for (const line of complete.split('\n')) {
        if (line.trim() === '')
            continue;
        let entry;
        try { entry = JSON.parse(line); }
        catch { continue; }
        if (String(entry?.targetUin ?? '') !== selfId)
            continue;
        const userUin = String(entry?.userUin ?? '');
        if (userUin === '')
            continue;
        const chatType = Number(entry?.chatType);
        const groupId = chatType === 2 ? String(entry?.peerUid ?? '') : '';
        const evt = {
            post_type: 'notice',
            notice_type: 'notify',
            sub_type: 'poke',
            user_id: userUin,
            target_id: selfId,
            sender: { user_id: userUin, nickname: '' },
        };
        if (groupId !== '')
            evt.group_id = groupId;
        bridge.deps.log('info', 'poke gray-tip: ' + (groupId === '' ? 'private' : 'group:' + groupId) + ' from ' + userUin);
        await handlePokeNotice(bridge, evt);
    }
}

function startPokeWatch(bridge) {
    if (pokeWatchState.has(bridge))
        return;
    const st = { offset: -1 };
    pokeWatchState.set(bridge, st);
    const timer = setInterval(() => void pokeWatchTick(bridge).catch(() => undefined), POKE_WATCH_MS);
    timer.unref?.();
    pokeWatchTimers.set(bridge, timer);
    void (async () => {
        try { st.offset = (await readFile(pokeWatchPath(bridge))).length; }
        catch { st.offset = 0; }
    })();
}

function stopPokeWatch(bridge) {
    const timer = pokeWatchTimers.get(bridge);
    if (timer !== undefined) {
        clearInterval(timer);
        pokeWatchTimers.delete(bridge);
    }
    pokeWatchState.delete(bridge);
}

// -- [dsh-p1] sleep ------------------------------------------------------------
// 23:00–01:00 wind-down (goodnight when she lies down, hard stop at 01:00),
// 01:00–07:00 sleep (messages dropped), 07:00 wake.
const sleepTimers = new WeakMap();

async function sleepWatchTick(bridge) {
    const mediaDir = bridge.deps?.config?.mediaDir ?? '';
    if (mediaDir === '')
        return;
    const state = await loadSleep(mediaDir);
    const previousAsleepAt = Number(state.asleepAt) || 0;
    const result = sleepTick(state, Date.now());
    if (result.wentToSleep) {
        if (previousAsleepAt > 0 && Number(state.gapRecoveredFor) < previousAsleepAt) {
            const pending = Number(state.pendingRecoverFrom) || 0;
            state.pendingRecoverFrom = pending > 0 ? Math.min(pending, previousAsleepAt) : previousAsleepAt;
        }
        await saveSleep(mediaDir, state);
        const admins = [...new Set([
            ...(Array.isArray(bridge.deps?.policy?.adminUsers) ? bridge.deps.policy.adminUsers : []),
            ...(Array.isArray(bridge.deps?.config?.adminUsers) ? bridge.deps.config.adminUsers : []),
        ].map(String))];
        const adminChat = admins.length > 0 ? 'private:' + String(admins[0]) : '';
        if (adminChat !== '') {
            await dispatchSleepGreeting(bridge, adminChat, 'asleep');
        }
        if (state.lastChatId !== undefined && state.lastChatId !== '' && state.lastChatId !== adminChat
            && String(state.lastChatId).startsWith('private:')) { // [dsh-p1] v2.63: 群聊不接作息招呼
            await dispatchSleepGreeting(bridge, state.lastChatId, 'asleep');
        }
        bridge.deps.log('info', 'sleep: went to sleep');
    }
    else if (result.woke) {
        await saveSleep(mediaDir, state);
        const admins = [...new Set([
            ...(Array.isArray(bridge.deps?.policy?.adminUsers) ? bridge.deps.policy.adminUsers : []),
            ...(Array.isArray(bridge.deps?.config?.adminUsers) ? bridge.deps.config.adminUsers : []),
        ].map(String))];
        const hour = new Date().getHours();
        if (admins.length > 0 && hour >= 6 && hour < 10) {
            await dispatchSleepGreeting(bridge, 'private:' + String(admins[0]), 'awake');
        }
        bridge.deps.log('info', 'sleep: woke up');
        void bridge.recoverSleepGap();
    }
}

function startSleepWatch(bridge) {
    if (sleepTimers.has(bridge))
        return;
    const timer = setInterval(() => void sleepWatchTick(bridge).catch(() => undefined), 60_000);
    timer.unref?.();
    sleepTimers.set(bridge, timer);
    void sleepWatchTick(bridge).catch(() => undefined);
}

function stopSleepWatch(bridge) {
    const timer = sleepTimers.get(bridge);
    if (timer !== undefined) {
        clearInterval(timer);
        sleepTimers.delete(bridge);
    }
}


/** [dsh-p1] fold the held fragment into the completing message. */
function mergeFragmentText(event, earlier) {
    const merged = String(earlier ?? '') + String(event.raw_message ?? '');
    event.raw_message = merged;
    if (!Array.isArray(event.message))
        return;
    const textSegment = event.message.find(segment => segment?.type === 'text');
    if (textSegment !== undefined && textSegment.data !== null && typeof textSegment.data === 'object')
        textSegment.data.text = merged;
    else
        event.message = [{ type: 'text', data: { text: merged } }, ...event.message];
}
