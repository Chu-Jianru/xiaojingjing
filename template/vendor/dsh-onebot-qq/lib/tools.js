/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { chatFlowFor } from './chat-flow.js';
import { makeReplyTool } from './reply.js';
import { makeSelfExpressionTool } from './self-expression.js';
import { adjustMood, loadMood } from './mood.js';
import { addRule, listRules, removeRules } from './rules.js';
import { profileGet, profileUpdate } from './profiles.js';
import { synthesizeSpeech, speechConfig } from './tts.js';
import { randomUUID as ttsUuid } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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

const MEDIA_DIR_FALLBACK = join(REPO, 'bot-home', 'media', 'onebot');
import { fileToBase64, isUrl } from './media.js';
import { splitChatId } from './chat.js';
import { parseMessage, cqUnescape } from './cq.js';
import { appendMemory, forgetMemories, listMemories } from './memory-store.js';
import { usageByDays } from './usage.js';
import { lookImage } from './vision.js';
import { creativeTools } from './creative.js';
import { makeHelperTool } from './helper.js';
import { companionshipTools, relayText, requireOpportunity } from './companionship.js';
import { makeSocialTool } from './social.js';
import { prepareSticker } from './sticker-input.js';
import { extractWebText, boundedWebBody, htmlSearch, supportedSearchResults } from './web-content.js';
import { publicFetch } from './public-fetch.js';
import { cachedWebTool } from './read-cache.js';
import { findStickers, findFavorites, rememberFavorite } from './sticker-catalog.js';
import { sendReaction, isStickerSource, reactionArgs } from './reactions.js';
import { stripMarkerResidue } from './outbound.js';
import { isAdminTurn as isReactionOwnerTurn } from './agent-api.js';
import { journalFor } from './journal-runner.js';
import { isOwnerJournalTurn, isOwnerStatusTurn } from './journal.js';
import { classifyAgentAction, isAdminTurn, summarizeAgentParams, writeAgentAudit, executeFriendApproval,
    NAPCAT_AGENT_ACTIONS, MAX_AGENT_TEXT, MSG_AGENT_NOT_ADMIN, MSG_AGENT_DENIED, MSG_AGENT_NOT_WHITELIST
} from './agent-api.js';
import { buildBuddyRequestRows, statusFilterLabel, BUDDY_REQUESTS_FILE } from './buddy-requests.js';
/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
// [dsh-p1] qq info apis: roster reads for "群主是谁 / 都有谁 / 我的好友"
'get_friend_list',
'get_group_list',
'get_group_info',
'get_recent_contact',
'get_login_info',
// [dsh-p1] roster: more read-only QQ info
'get_friends_with_category',
'get_group_honor_info',
'get_status',
'get_version_info',
    'get_group_member_list',
    'get_group_member_info',
    'get_stranger_info',
    'get_forward_msg',
    'get_record',
    'get_file',
    'upload_group_file',
    'upload_private_file',
    'get_group_root_files',
    'get_group_files_by_folder',
    'get_group_file_url',
    'get_private_file_url',
    'ocr_image',
    'get_friend_msg_history',
    'get_group_msg_history',
    'get_ai_characters',
    'send_group_ai_record',
];
/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
    return { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }] };
}
/** Resolve the target chat for a tool call. */
function resolveChat(bridge, exec, chatIdArg) {
    if (typeof chatIdArg === 'string' && chatIdArg !== '')
        return chatIdArg;
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）');
}
/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 */
async function mediaRoots(bridge, exec) {
    const gate = await bridge.mediaSendRoots(exec.agent?.session.id);
    return gate.roots;
}
/**
 * Read one local media file behind the outbound fence, translating the
 * fence refusal (which reaches the model verbatim) into an actionable
 * hint; size-cap and OS errors keep their original message.
 */
async function fencedMediaFile(path, maxBytes, allowedRoots) {
    try {
        return await fileToBase64(path, maxBytes, allowedRoots);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
            throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path);
        }
        throw error;
    }
}
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export function registerTools(ctx, bridge, connection, limits) {
    const disposers = [];
    const register = (tool) => {
        disposers.push(ctx.tools.register(chatFlowFor(bridge).wrapTool(tool)));
    };
    register(makeReplyTool(defineTool, bridge, { appendMemory, sendReaction, adjustMood, mediaDirFallback: MEDIA_DIR_FALLBACK }));
    register(makeSelfExpressionTool(defineTool, bridge));
    for (const tool of creativeTools(defineTool, bridge)) register(tool);
    for (const tool of companionshipTools(defineTool, bridge)) register(tool);
    register(makeHelperTool(defineTool, bridge, helperCtx => registerTools({ tools: { register: tool =>
        ['web_search', 'web_fetch'].includes(tool.name) ? helperCtx.tools.register(tool) : () => {}
    } }, bridge, connection, limits)));
    register(defineTool({
        name: 'qq_send_image',
        description: '发送图片。普通截图/资料图最多9张；自己的表情包只是点缀。该说话时用with_text并把实质回复写进caption；只有纯情绪反应才reaction_only，明确索图才requested。sent=false表示没发，继续用自己的话接住内容，不用别的表情工具绕过。',
        parameters: {
            sources: { type: 'array', items: { type: 'string' }, required: true, description: '本地绝对路径或http(s) URL；普通表情反应最多一张' },
            chat_id: { type: 'string', description: '目标会话，省略为当前会话' },
            as_sticker: { type: 'boolean', description: '从QQ收藏夹取出的表情URL填true，按表情消息发送；普通照片不填' },
            caption: { type: 'string', description: '需要文字时，这里写本轮真正想回对方的话，与图一起发；不是图片旁白，已发的文字最终回复不重复' },
            response_mode: {
                type: 'string', enum: ['with_text', 'reaction_only', 'requested'],
                description: '表情回复先判断语境：with_text=本轮需要回答/确认/纠正/接话，caption写真正要回的话；reaction_only=纯情绪反应确实足够；requested=对方仅要图或表情，同时要你说话时仍用with_text。',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = reactionArgs(args, stripMarkerResidue);
            const sources = Array.isArray(a.sources) ? a.sources.filter(s => typeof s === 'string') : [];
            if (sources.length === 0 || sources.length > 9) throw new Error('qq_send_image: sources须有1至9张图片');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const send = async () => {
                const allowedRoots = await mediaRoots(bridge, exec);
                const segments = [];
                if (typeof a.caption === 'string' && a.caption.trim() !== '')
                    segments.push({ type: 'text', data: { text: a.caption } });
                for (const source of sources) {
                    const extra = a.as_sticker === true || isStickerSource(source) ? { sub_type: 1 } : {};
                    segments.push({ type: 'image', data: isUrl(source)
                        ? { url: source, ...extra }
                        : { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots), ...extra } });
                }
                return await bridge.sendSegments(chatId, segments);
            };
            const count = a.as_sticker === true ? sources.length : sources.filter(isStickerSource).length;
            if (count) return await sendReaction(bridge, chatId, a, send, sources.length, { ownerRequested: isReactionOwnerTurn(bridge, exec.agent?.session.id) });
            const id = await send();
            return { sent: true, textSent: typeof a.caption === 'string' && a.caption.trim() !== '', messageId: id ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_voice',
        description: '向当前QQ会话发语音。text最多120字，沿用固定参考声线；锁定时不能用旧path换声。语音本身是回复，送达后不重复同句文字或发送确认；合成不可用时按语境用文字。',
        parameters: {
            text: { type: 'string', description: '要合成的话（≤120 字）；给了 text 就不用给 path' },
            voice: { type: 'string', description: '通常省略，沿用用户固定的参考声线；锁定时不能临时换声，旧音色ID仅在配置允许换声时生效。' },
            path: { type: 'string', description: '本地音频文件绝对路径（已有音频时用）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, a.chat_id);
            let filePath = typeof a.path === 'string' ? a.path.trim() : '';
            // [dsh-p1] a locked self-voice cannot reuse an unrelated old recording.
            if (filePath !== '' && (await speechConfig()).voiceLocked) {
                if (typeof a.text === 'string' && a.text.trim() !== '') filePath = '';
                else throw new Error('qq_send_voice: 固定声线请提供text；转发原录音应使用转发工具');
            }
            let synthesized = false;
            if (filePath === '') {
                const text = typeof a.text === 'string' ? a.text.trim() : '';
                if (text === '')
                    throw new Error('qq_send_voice: 需要 text（合成）或 path（已有音频）');
                const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
                const outPath = join(mediaDir, 'tts', 'tts-' + Date.now() + '-' + ttsUuid() + '.mp3');
                filePath = await synthesizeSpeech({
                    text,
                    voice: typeof a.voice === 'string' ? a.voice : undefined,
                    outPath,
                });
                synthesized = true;
            }
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(filePath, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, synthesized, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_video',
        description: '向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地视频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_video: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'video', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_file',
        description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            name: { type: 'string', description: '文件名（默认取路径文件名）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_file: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const name = typeof a.name === 'string' && a.name !== '' ? a.name : a.path.split('/').pop() ?? 'file';
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'file', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots), name } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_forward',
        description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
        parameters: {
            messages: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '显示名（≤24 字）' },
                        content: { type: 'string', description: '消息内容（≤500 字，必填）' },
                    },
                    additionalProperties: true,
                },
                required: true,
                description: '合并转发的消息节点列表',
            },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (!Array.isArray(a.messages) || a.messages.length === 0)
                throw new Error('qq_send_forward: messages 不能为空');
            const nodes = a.messages.map(m => {
                const node = m;
                return {
                    name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
                    content: typeof node.content === 'string' ? node.content : '',
                };
            });
            if (nodes.some(n => n.content === ''))
                throw new Error('qq_send_forward: 每条消息都需要 content');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            await bridge.sendForward(chatId, nodes);
            return { sent: true, messageId: null };
        },
    }));
    // [dsh-p1] v2.28 agent tier: 管理级 QQ 操作（qq_send_text / qq_agent_api）。
    // 仅老大的回合可用：门禁查 bridge 冻结的 activeTurnRole（本回合发起者角色），fail-closed；
    // 每次调用（含被拒的尝试）写 mediaDir/qq-actions.log 审计（action 记 agent:<名字>）。
    // 白名单/拒绝表/话术在 agent-api.js（源：tools/plugin/modules/onebot_agent_api.js）。
    const mediaDirOf = (b) => b?.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
    register(defineTool({
        name: 'qq_send_text',
        description: '帮人传一条文字。老大可指定任意QQ会话；聊熟的朋友也可请你往双方共同的群传话，先看内容、目的和自己愿不愿意，不能代解禁或冒充别人。朋友传话会注明来源。必须真实调用且sent=true才算送达；拒绝时自然表达，不念权限、工具或亲密度分数。',
        parameters: {
            chat_id: { type: 'string', required: true, description: '目标会话：private:<QQ> 或 group:<群号>' },
            text: { type: 'string', required: true, description: '要发的文字（≤' + MAX_AGENT_TEXT + ' 字）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const sessionId = exec.agent?.session.id;
            let chatId;
            try { chatId = resolveChat(bridge, exec, a.chat_id); }
            catch { chatId = 'unknown'; }
            const text = String(a.text ?? '');
            if (!text.trim()) throw new Error('qq_send_text: text 不能为空');
            if (text.length > MAX_AGENT_TEXT) throw new Error('qq_send_text: 文字超过 ' + MAX_AGENT_TEXT + ' 字，缩短或拆两条');
            try {
                const value = await relayText(bridge, sessionId, chatId, text);
                await writeAgentAudit(mediaDirOf(bridge), chatId, 'send_text', value.sent === true, summarizeAgentParams({ text, result: value.status }));
                return value;
            }
            catch (error) {
                await writeAgentAudit(mediaDirOf(bridge), chatId, 'send_text', false, String(error?.message ?? error).slice(0, 160));
                throw error;
            }
        },
    }));
    register(defineTool({
        name: 'qq_agent_api',
        description: 'Agent 级 QQ 操作（只有老大的回合可用）：代发消息、群管理（禁言/全体禁言/踢人/名片/头衔/设管理/精华/群公告/加群审批）、好友申请同意或拒绝、删好友、点赞、群打卡、输入状态、在线状态、改头像等。白名单外一律拒绝；凭据类（cookies/credentials）永不开放；不可逆动作（踢人/退群/删好友/改头像）只在老大明确说了才做。',
        parameters: {
            action: { type: 'string', required: true, description: 'agent 白名单 action：' + NAPCAT_AGENT_ACTIONS.join(' / ') },
            params: { type: 'object', additionalProperties: true, description: 'action参数。好友审批set_friend_add_request优先给user_id=对方QQ、approve=布尔值；flag仅为申请标识，不能自己猜QQ充当flag；submitted未confirmed不说已经加上' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                let text = JSON.stringify(value ?? null, null, 2);
                if (text.length > 3000) text = text.slice(0, 3000) + '…（截断）';
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const action = String(a.action ?? '');
            const sessionId = exec.agent?.session.id;
            let chatId;
            try { chatId = resolveChat(bridge, exec, undefined); }
            catch { chatId = 'unknown'; }
            const mediaDir = mediaDirOf(bridge);
            const tier = classifyAgentAction(action);
            if (tier === 'deny') {
                await writeAgentAudit(mediaDir, chatId, action, false, MSG_AGENT_DENIED);
                throw new Error('qq_agent_api: ' + MSG_AGENT_DENIED);
            }
            if (tier === 'unknown') {
                await writeAgentAudit(mediaDir, chatId, action, false, '不在 agent 白名单');
                throw new Error('qq_agent_api: ' + MSG_AGENT_NOT_WHITELIST);
            }
            if (!isAdminTurn(bridge, sessionId)) {
                await writeAgentAudit(mediaDir, chatId, action, false, '非老大回合尝试管理级操作');
                throw new Error('qq_agent_api: ' + MSG_AGENT_NOT_ADMIN);
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            try {
                const value = action === 'set_friend_add_request'
                    ? await executeFriendApproval(bridge, params)
                    : await bridge.guardedConnectionCall(action, params);
                await writeAgentAudit(mediaDir, chatId, action, true, summarizeAgentParams(params));
                return value;
            }
            catch (error) {
                await writeAgentAudit(mediaDir, chatId, action, false, String(error?.message ?? error).slice(0, 160));
                throw error;
            }
        },
    }));
    // [dsh-p1] journal tools: owner DM only; automatic writing uses a separate session.
    const ownerJournal = exec => {
        if (!isOwnerJournalTurn(bridge, exec.agent?.session.id))
            throw new Error('journal_owner_private_only');
        if (bridge.deps.config.inject?.intercepting)
            throw new Error('journal_dry_run');
        return journalFor(bridge);
    };
    register(defineTool({
        name: 'qq_diary',
        description: '自己的本地私密日记。仅老大私聊可用；read看最近几篇，preview独立构思但不保存，write保存你已写好的正文。平时会按事件/心情/小概率自主考虑，不是每日任务，不把日记或私聊内容拿去群里/说说里复述，不固定报幕。',
        parameters: {
            action: { type: 'string', required: true, enum: ['read', 'preview', 'write'] },
            title: { type: 'string', description: '日记标题，可空' },
            text: { type: 'string', description: 'write时的日记正文，最多1200字，不凑长度' },
            limit: { type: 'number', description: 'read篇数，默认3，最多10' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args ?? {};
            const journal = ownerJournal(exec);
            if (a.action === 'read') return await journal.recent('diary', a.limit);
            if (a.action === 'preview') return await journal.preview('diary');
            if (a.action === 'write') return await journal.saveWriting('diary', { title: a.title, text: a.text });
            throw new Error('journal_action_invalid');
        },
    }));
    register(defineTool({
        name: 'qq_post_status',
        description: '自己的QQ空间说说，默认好友可见。老大在私聊/群聊要求发布不受自主次数与间隔限制；其他人也可以请求，结合关系、内容和自己的意愿决定，亲近的人更容易答应，非老大仍受发布节奏限制。preview构思不发，read仅查已公开记录，publish发布确定正文（最多180字），idea保存适合公开的自己的念头供平时自主分享，不立即发。不能泄露他人隐私、复制日记或编经历；只有published并有tid才算成功，unknown不重发。',
        parameters: {
            action: { type: 'string', required: true, enum: ['read', 'preview', 'publish', 'idea'] },
            text: { type: 'string', description: 'publish时的正文，不带内部说明和发送回执' },
            limit: { type: 'number', description: 'read条数，默认3，最多10' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args ?? {};
            const sessionId = exec.agent?.session.id;
            const chatId = bridge.chatForSession?.(sessionId);
            const chat = bridge.chats?.get(chatId);
            if (!chat || !['admin', 'member'].includes(chat.activeTurnRole)) throw new Error('status_chat_turn_required');
            if (bridge.deps.config.inject?.intercepting) throw new Error('journal_dry_run');
            const journal = journalFor(bridge);
            const ownerRequested = isOwnerStatusTurn(bridge, sessionId);
            if (a.action === 'read') return (await journal.recent('status', a.limit)).filter(e => e.status === 'published');
            if (a.action === 'preview') return await journal.preview('status');
            if (a.action === 'idea') return await journal.rememberIdea(a.text);
            if (a.action === 'publish') {
                await requireOpportunity(bridge, sessionId, 'status');
                return await journal.saveWriting('status', { text: a.text }, { ownerRequested, trigger: ownerRequested ? 'owner_request' : 'social_choice' });
            }
            throw new Error('journal_action_invalid');
        },
    }));
    register(makeSocialTool(defineTool, bridge));
    register(defineTool({
        name: 'qq_napcat_api',
        description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'action参数。好友审批用user_id=对方QQ、approve=布尔值；flag只能是申请标识，不能猜；submitted未confirmed不说已加上',
            },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
                throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）');
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            return await connection.call(a.action, params);
        },
    }));
    register(defineTool({
        name: 'qq_group_history',
        description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
        parameters: {
            chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
            count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
            message_seq: { type: 'number', description: '起始消息序号（翻页用，可选）' },
        },
        output: {
            schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
            },
            render: (_args, value) => {
                const list = Array.isArray(value) ? value : [];
                return [{ type: 'text', text: list.length + ' 条历史消息' }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            if (splitChatId(chatId).kind !== 'group')
                throw new Error('qq_group_history: 仅支持群聊');
            const groupId = Number(splitChatId(chatId).target);
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50);
            const params = { group_id: groupId, count };
            if (typeof a.message_seq === 'number')
                params.message_seq = a.message_seq;
            const data = await connection.call('get_group_msg_history', params);
            const messages = Array.isArray(data.messages) ? data.messages : [];
            return messages.map(m => {
                const msg = m;
                const sender = (msg.sender ?? {});
                const message = msg.message;
                const segments = Array.isArray(message) ? message : undefined;
                const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
                const parsed = parseMessage(segments, raw);
                return {
                    message_id: msg.message_id != null ? String(msg.message_id) : null,
                    time: msg.time != null ? String(msg.time) : null,
                    user_id: sender.user_id != null ? String(sender.user_id) : msg.user_id != null ? String(msg.user_id) : null,
                    nickname: typeof sender.card === 'string' && sender.card !== '' ? sender.card
                        : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
                            : String(sender.user_id ?? ''),
                    text: cqUnescape(parsed.text),
                };
            });
        },
    }));
    register(defineTool({
        name: 'qq_remember',
        description: '把值得长期记住的事写进记忆：事实、偏好、事件、关系、约定。聊天里出现这类信息、以后可能用到时调用。',
        parameters: {
            text: { type: 'string', required: true, description: '一句话，第三人称，比如「老大不吃香菜」「车干是老大的同学」' },
            kind: { type: 'string', description: 'fact / pref / event / rel / promise，可省略' },
            scope: { type: 'string', description: "chat=只有当前会话看得到（默认）；global=所有会话都看得到。关于老大的、哪里都该知道的事用 global；别人私聊说的事用 chat，别漏出去" },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const text = typeof a.text === 'string' ? a.text.trim() : '';
            if (text === '')
                throw new Error('qq_remember: text 不能为空');
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
            await appendMemory(mediaDir, { chat: chatId, kind: typeof a.kind === 'string' ? a.kind : 'fact', text, scope: a.scope === 'global' ? 'global' : 'chat' });
            return { ok: true, text, scope: a.scope === 'global' ? 'global' : 'chat' };
        },
    }));
    register(defineTool({
        name: 'qq_forget',
        description: '忘掉记忆：对方说「忘掉 / 别记着 / 删掉」某件事、或自己发现记错了时调用，删掉当前会话里看得到的、和那件事相关的记忆。删完自然应一声（比如「行，忘啦」），别念删了什么清单。',
        parameters: {
            query: { type: 'string', required: true, description: '要忘掉的事，用关键词，比如「香菜」「上次打赌」' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
            const result = await forgetMemories(mediaDir, chatId, typeof a.query === 'string' ? a.query : '');
            return { ok: true, count: result.removed.length, removed: result.removed };
        },
    }));
    register(defineTool({
        name: 'qq_memories',
        description: '查自己记得什么（只看得到当前会话能看到的记忆）。被问「你还记得我什么」、或想确认某件事记没记过时用；挑相关的自然说一两件，别背清单。',
        parameters: {
            query: { type: 'string', description: '关键词过滤，可省略' },
            limit: { type: 'number', description: '最多几条（默认 20）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
            const rows = await listMemories(mediaDir, chatId, typeof a.query === 'string' ? a.query : '', typeof a.limit === 'number' ? a.limit : undefined);
            return { ok: true, count: rows.length, memories: rows };
        },
    }));
    register(defineTool({
        name: 'qq_cost',
        description: '查你自己的 token 用量（这几天的花费）。老大问「今天花了多少 / 烧了多少 token / 成本」时用它查了如实回答：报总 token、输入/输出/缓存命中各多少、哪几个会话聊得最多；可以顺着说一句「今天聊得确实多」或「缓存命中高其实没那么贵」，别编具体金额。',
        parameters: {
            days: { type: 'number', description: '查最近几天（1–7，默认 1 = 今天）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const raw = Number(args?.days ?? 1);
            const days = Number.isFinite(raw) ? Math.min(7, Math.max(1, Math.trunc(raw))) : 1;
            const byDays = await usageByDays(days);
            const days2 = Object.entries(byDays).map(([day, r]) => {
                const top = Object.entries(r.chats)
                    .sort((a, b) => b[1].turns - a[1].turns)
                    .slice(0, 3)
                    .map(([chatId, c]) => ({ chat_id: chatId, turns: c.turns, total_tokens: c.totalTokens }));
                return {
                    date: day,
                    turns: r.total.turns,
                    input_tokens: r.total.inputTokens,
                    output_tokens: r.total.outputTokens,
                    cache_read_tokens: r.total.cacheReadTokens,
                    total_tokens: r.total.totalTokens,
                    top_chats: top,
                };
            });
            return { ok: true, days: days2 };
        },
    }));
    register(defineTool({
        name: 'qq_look',
        description: '看本会话的图片；不带 path 使用最新一张。关闭返回 vision_disabled，等待中返回 vision_pending，只有成功的 description 才是已识别画面。错误是内部状态，结合语境自行组织回复，不照抄、不猜图、不保证稍后成功。',
        parameters: {
            path: { type: 'string', description: '图片文件完整路径（消息里的 [图片:路径]）；省略=本会话最新一张' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const result = await lookImage(chatId, typeof a.path === 'string' ? a.path : '',
                (level, message) => bridge.deps?.log?.(level, message));
            if (result?.error !== undefined)
                return { ...result, ok: false };
            return { ok: true, description: result.text };
        },
    }));
    // -- [dsh-p1] usage --

    register(defineTool({
        name: 'qq_profile',
        description: '读/更新你认识的人的画像（昵称、关系、喜好、忌讳、近况、说话风格）。聊天里了解到值得长期记住的个人信息，用 action=update 写进去；想确认你记得某人什么，用 action=read。',
        parameters: {
            action: { type: 'string', description: 'read 或 update' },
            user_id: { type: 'string', description: '对方 QQ；省略=当前会话对象（群里必须给）' },
            nickname: { type: 'string', description: 'update：称呼/昵称' },
            name: { type: 'string', description: 'update：真名（对方认真说的，玩笑称呼不算）' },
            age: { type: 'number', description: 'update：年龄' },
            gender: { type: 'string', description: 'update：男 / 女 / 其他' },
            relation: { type: 'string', description: 'update：关系，比如「老大的同学」' },
            fact: { type: 'string', description: 'update：一条值得记住的事实' },
            style: { type: 'string', description: 'update：说话风格' },
            catchphrase: { type: 'string', description: 'update：一条口头禅/习惯说法' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: value && value.empty === true ? '还没有这个人的画像' : '画像：' + JSON.stringify(value) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
            const parts = splitChatId(chatId);
            const target = typeof a.user_id === 'string' && a.user_id !== ''
                ? a.user_id
                : (parts.kind === 'private' ? parts.target : '');
            if (target === '')
                throw new Error('qq_profile: 群聊里要指定 user_id');
            if (a.action === 'read')
                return (await profileGet(mediaDir, target)) ?? { empty: true };
            return await profileUpdate(mediaDir, target, {
                nickname: typeof a.nickname === 'string' ? a.nickname : undefined,
                name: typeof a.name === 'string' ? a.name : undefined,
                age: a.age === undefined ? undefined : Number(a.age),
                gender: typeof a.gender === 'string' ? a.gender : undefined,
                relation: typeof a.relation === 'string' ? a.relation : undefined,
                fact: typeof a.fact === 'string' ? a.fact : undefined,
                style: typeof a.style === 'string' ? a.style : undefined,
                catchphrase: typeof a.catchphrase === 'string' ? a.catchphrase : undefined,
            });
        },
    }));
    register(defineTool({
        name: 'qq_poke',
        description: '戳一戳（QQ 戳一戳）。默认戳当前会话对象；群里要带 user_id（消息前缀里有当前说话人的 QQ）。私聊里也能戳群里的人：chat_id="group:<群号>" + user_id="<QQ>"。安慰、打招呼、对方很久没回、想引起注意时可以用；别连戳、别戳不熟的人。',
        parameters: {
            user_id: { type: 'string', description: '要拍的人 QQ；私聊省略=当前会话对象，群里必填' },
            chat_id: { type: 'string', description: '目标会话 group:<群号> / private:<QQ>；省略=当前会话（私聊里戳群里的人就传 group:<群号>）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, typeof a.chat_id === 'string' && a.chat_id !== '' ? a.chat_id : undefined);
            const parts = splitChatId(chatId);
            const explicit = a.user_id === undefined || a.user_id === null ? '' : String(a.user_id).trim();
            const uid = explicit !== '' ? explicit : (parts.kind === 'private' ? parts.target : '');
            if (uid === '')
                throw new Error('qq_poke: 群里要带 user_id（当前说话人的 QQ）');
            if (parts.kind === 'group')
                await bridge.guardedConnectionCall('group_poke', { group_id: Number(parts.target), user_id: Number(uid) });
            else
                await bridge.guardedConnectionCall('friend_poke', { user_id: Number(uid) });
            return { ok: true, chat_id: chatId, user_id: uid };
        },
    }));
    register(defineTool({
        name: 'qq_recent_pokes',
        description: '查最近谁戳了你：时间、群/私聊、对方 QQ、昵称（画像里有的话）。被问「刚才谁戳你」「去回个戳」时先用它查，再用 qq_poke 带 chat_id + user_id 回戳。',
        parameters: {
            limit: { type: 'number', description: '最多几条（1–50，默认 10）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const raw = Number(args?.limit ?? 10);
            const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.trunc(raw))) : 10;
            const mediaDir = bridge.deps?.config?.mediaDir ?? '';
            const selfId = String(bridge.deps?.connection?.selfId ?? '');
            let profiles = {};
            try { profiles = JSON.parse(await readFile(join(mediaDir, 'profiles.json'), 'utf8')); }
            catch { profiles = {}; }
            let lines = [];
            try {
                lines = (await readFile(join(mediaDir, 'poke-raw.jsonl'), 'utf8'))
                    .split('\n').filter(line => line.trim() !== '');
            }
            catch { lines = []; }
            const pokes = [];
            for (let i = lines.length - 1; i >= 0 && pokes.length < limit; i--) {
                let o;
                try { o = JSON.parse(lines[i]); }
                catch { continue; }
                if (o === null || typeof o !== 'object') continue;
                if (selfId === '' || String(o.targetUin ?? '') !== selfId) continue;
                const at = Number(o.at) || 0;
                const uid = String(o.userUin ?? '');
                const isGroup = Number(o.chatType) === 2;
                const profile = profiles[uid];
                pokes.push({
                    time: at > 0 ? new Date(at).toLocaleString('sv-SE') : '',
                    chat: isGroup ? 'group:' + String(o.peerUid ?? '') : 'private:' + uid,
                    group_id: isGroup ? String(o.peerUid ?? '') : '',
                    user_id: uid,
                    nickname: typeof profile?.nickname === 'string' ? profile.nickname : '',
                });
            }
            return { count: pokes.length, pokes };
        },
    }));
    register(defineTool({
        name: 'qq_roster',
        description: '查好友名单和来历：谁、昵称、备注、什么时候加的、通过什么途径/验证消息。被问「谁加的你 / 什么时候加的 / 怎么加的」时用。',
        parameters: {
            user_id: { type: 'string', description: '只查一个人；省略=全部（最多 50 个）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const a = args ?? {};
            const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
            let roster = {};
            try {
                roster = JSON.parse(await readFile(join(mediaDir, 'roster.json'), 'utf8'));
            }
            catch { roster = {}; }
            let list;
            try {
                const r = await bridge.guardedConnectionCall('get_friend_list', {});
                list = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []);
            }
            catch { list = []; }
            const rows = list.map(row => {
                const uin = String(row.user_id ?? '');
                const rec = roster[uin] ?? {};
                return {
                    user_id: uin,
                    nickname: row.nickname ?? '',
                    remark: row.remark ?? '',
                    added_at: rec.addAt ? new Date(rec.addAt).toLocaleString('zh-CN', { hour12: false }) : '未知（启用记录前就是好友）',
                    source: rec.source ?? '未知',
                    how: rec.how ?? '',
                };
            });
            if (typeof a.user_id === 'string' && a.user_id !== '')
                return rows.filter(row => row.user_id === a.user_id);
            return rows.slice(0, 50);
        },
    }));
    // [dsh-p1] buddy requests tool: NapCat's OneBot layer cannot list friend
    // requests, so read the dump the patched NapCat writes (see buddy watch)
    // and answer 「谁申请加我好友」 with status per requester.
    register(defineTool({
        name: 'qq_buddy_requests',
        description: '查好友申请：user_id是QQ号，flag才是审批标识；审批优先给qq_agent_api的params.user_id，不要拿QQ号猜flag。谁、申请留言、什么时候、现在处理没有（待审/已成好友/我发起的）。被问「谁申请加我好友 / 申请列表里都有谁 / 之前那些申请是谁发的」时用。',
        parameters: {
            status: { type: 'string', description: '只看某类：pending=待审 / friend=已成好友 / initiator=我发起的；省略=全部' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 1) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const a = args ?? {};
            const mediaDir = bridge.deps?.config?.mediaDir ?? '';
            let requests = [];
            try {
                const raw = await readFile(join(mediaDir, BUDDY_REQUESTS_FILE), 'utf8');
                const dump = JSON.parse(raw);
                requests = Array.isArray(dump?.requests) ? dump.requests : [];
            }
            catch { return { error: '申请记录读不到（NapCat dump 未生成）' }; }
            let friendRows = [];
            try {
                const r = await bridge.guardedConnectionCall('get_friend_list', {});
                friendRows = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []);
            }
            catch { /* 拿不到好友列表就全按未处理报 */ }
            const rows = buildBuddyRequestRows(requests, friendRows);
            const status = statusFilterLabel(a.status);
            const visible = status === '' ? rows : rows.filter(row => row.status === status);
            return {
                count: visible.length,
                pending: rows.filter(row => row.status === '待审').length,
                requests: visible,
            };
        },
    }));
    register(defineTool({
        name: 'qq_rule',
        description: '长期规则：老大用「以后…/遇到…就…」交代的做法，用 action=add 记下来（when=触发情况，then=怎么做，scope 可 global/group:群号/private:QQ）；action=list 查看；action=remove 删除。加/删只在老大私聊里有效。',
        parameters: {
            action: { type: 'string', description: 'add / list / remove' },
            when: { type: 'string', description: 'add：触发情况；留空=每次都生效' },
            then: { type: 'string', description: 'add：要怎么做' },
            scope: { type: 'string', description: 'add：global / group:<群号> / private:<QQ>，默认 global' },
            remove: { type: 'string', description: 'remove：规则 id 或关键词' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 1) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
            const admins = Array.isArray(bridge?.deps?.policy?.adminUsers) ? bridge.deps.policy.adminUsers.map(String) : [];
            const peer = splitChatId(chatId).kind === 'private' ? splitChatId(chatId).target : '';
            const isAdminDm = peer !== '' && admins.includes(String(peer));
            if (a.action === 'list')
                return await listRules(mediaDir, chatId);
            if (!isAdminDm)
                throw new Error('qq_rule: 只有老大私聊里才能设置或删除规则');
            if (a.action === 'remove')
                return { removed: await removeRules(mediaDir, a.remove) };
            const rule = await addRule(mediaDir, {
                when: typeof a.when === 'string' ? a.when : '',
                then: a.then,
                scope: typeof a.scope === 'string' && a.scope !== '' ? a.scope : 'global',
                by: String(peer),
            });
            return { ok: true, rule };
        },
    }));
    register(defineTool({
        name: 'qq_mood',
        description: '微调你自己的心情/精力/对某人的好感（0-100，50 平）。被夸、被骂、聊到深夜、被冷落之后可以调一次（±5 左右），不用每轮调；action=read 看当前状态。',
        parameters: {
            action: { type: 'string', description: 'adjust（默认）/ read' },
            mood: { type: 'number', description: '心情变化，比如 -5' },
            energy: { type: 'number', description: '精力变化，比如 -3' },
            affection: { type: 'number', description: '对这人的好感变化，比如 +3' },
            user_id: { type: 'string', description: '群里要指定对方 QQ' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 1) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
            const chatId = resolveChat(bridge, exec, undefined);
            const parts = splitChatId(chatId);
            if (a.action === 'read')
                return await loadMood(mediaDir);
            const target = typeof a.user_id === 'string' && a.user_id !== ''
                ? a.user_id
                : (parts.kind === 'private' ? parts.target : '');
            return await adjustMood(mediaDir, {
                mood: Number(a.mood || 0),
                energy: Number(a.energy || 0),
                affection: Number(a.affection || 0),
                userId: target,
            });
        },
    }));
    register(defineTool({
        name: 'qq_recall',
        description: '撤回自己刚发的消息（发错了/不想留了）。不带 message_id 就撤回本会话最后一条自己发的；不能撤回别人的。',
        parameters: {
            message_id: { type: 'string', description: '要撤回的消息 id；省略=本会话最后一条自己发的' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const id = typeof a.message_id === 'string' && a.message_id !== ''
                ? a.message_id
                : (bridge.lastQuotedId || (bridge.lastSentByChat?.get(chatId) ?? ''));
            if (id === '')
                throw new Error('qq_recall: 没有可撤回的消息');
            await bridge.guardedConnectionCall('delete_msg', { message_id: Number(id) });
            return { ok: true, message_id: String(id) };
        },
    }));
    register(defineTool({
        name: 'qq_send_face',
        description: '发QQ原生/超级表情，只作语境合适的点缀。先判断：需要回答、确认、纠正或接一句话时用with_text并写caption实质回复；纯情绪反应才reaction_only，明确索表情才requested。sent=false表示没有发，按内容自行说话，不能只发[不回]掩盖漏答，也不换另一种表情绕过。',
        parameters: {
            id: { type: 'number', description: '经典表情编号' },
            emoji_id: { type: 'string', description: '超级表情emoji_id' },
            emoji_package_id: { type: 'string', description: '超级表情包id' },
            key: { type: 'string' },
            summary: { type: 'string' },
            caption: { type: 'string', description: '本轮需要回应的具体内容，与表情一起发，最终回复不重复已发送文字' },
            response_mode: {
                type: 'string', enum: ['with_text', 'reaction_only', 'requested'],
                description: '表情回复先判断语境：with_text=本轮需要回答/确认/纠正/接话，caption写真正要回的话；reaction_only=纯情绪反应确实足够；requested=对方仅要图或表情，同时要你说话时仍用with_text。',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = reactionArgs(args, stripMarkerResidue);
            const chatId = resolveChat(bridge, exec, undefined);
            return await sendReaction(bridge, chatId, a, async () => {
                const segment = typeof a.emoji_id === 'string' && a.emoji_id !== ''
                    ? { type: 'mface', data: { emoji_id: a.emoji_id, emoji_package_id: String(a.emoji_package_id ?? ''), key: String(a.key ?? ''), summary: String(a.summary ?? '') } }
                    : { type: 'face', data: { id: String(a.id ?? 14) } };
                const segments = typeof a.caption === 'string' && a.caption.trim() !== ''
                    ? [{ type: 'text', data: { text: a.caption } }, segment] : [segment];
                return await bridge.sendSegments(chatId, segments);
            }, 1, { ownerRequested: isReactionOwnerTurn(bridge, exec.agent?.session.id) });
        },
    }));
    // -- [dsh-p1] v2.58: qq_stickers（自己收藏的「喜爱」表情）--
    register(defineTool({
        name: 'qq_stickers',
        description: '按含义找自己的表情库（含呆猫八条），query写情绪/想表达的意思；返回meaning和path，用qq_send_image发送。source=favorites才查询QQ爱心页链接，未知含义的图先看懂再用。不必等索图命令。',
        parameters: {
            query: { type: 'string', description: '如 八条 委屈、开心、困惑、贴贴；默认按本地库列出少量' },
            source: { type: 'string', enum: ['library', 'favorites'], description: '默认library；favorites查询QQ收藏' },
            limit: { type: 'number', description: '默认8，最多12' },
            offset: { type: 'number', description: '收藏夹翻页起点；上次next_offset不为空时可继续找，不只看最前几张' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const limit = Math.min(Math.max(typeof args?.limit === 'number' ? Math.floor(args.limit) : 8, 1), 12);
            if (args?.source !== 'favorites') {
                const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
                return { stickers: await findStickers(join(REPO, 'qq-persona/p1'), mediaDir, args?.query, limit) };
            }
            const data = await connection.call('fetch_custom_face', {});
            return await findFavorites(bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK, data, args?.query, limit, args?.offset);
        },
    }));
    // -- [dsh-p1] v2.56: qq_add_sticker（收进 QQ「喜爱」表情）--
    register(defineTool({
        name: 'qq_add_sticker',
        description: '把一张图收进 QQ 的「喜爱」表情（表情面板里那个爱心页）。老大说“收起来/存表情/加进喜爱”，或者你自己觉得这张图以后还想用，就调它。file 填本地绝对路径或 http(s) 图片链接。',
        parameters: {
            file: { type: 'string', required: true, description: '本地绝对路径，或 http(s) 图片地址' },
            meaning: { type: 'string', description: '自己已看懂的含义和适用情绪，最多160字；不知道留空，不猜' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}) }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const src = String(args?.file ?? '').trim();
            if (src === '')
                throw new Error('qq_add_sticker: file 不能为空');
            const allowedRoots = await mediaRoots(bridge, exec);
            const target = await prepareSticker(src, bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK,
                (path, max) => fencedMediaFile(path, max, allowedRoots));
            const data = await connection.call('add_custom_face', { file: target });
            if (Number(data?.result) !== 0) throw new Error('qq_add_sticker: 未取得成功结果');
            await rememberFavorite(bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK, target, args?.meaning, src);
            return {
                ok: true,
                already: Number(data?.isExist ?? 0) === 1,
                file: target,
            };
        },
    }));
    // -- [dsh-p1] v2.53: web_search / web_fetch（不依赖任何 key，走公开 HTML）--
    register(cachedWebTool(defineTool({
        name: 'web_search',
        description: '联网搜索：查新闻、资料、具体数据、典故出处。返回标题/链接/摘要，最多 8 条；要看正文再用 web_fetch。闲聊和表情不用搜。',
        parameters: {
            query: { type: 'string', required: true, description: '搜索词，尽量具体（人名/事件/数字一起给）' },
            count: { type: 'number', description: '返回条数 1-8，默认 5' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') || '无结果' }],
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const a = args;
            const query = String(a.query ?? '').trim();
            if (query === '')
                throw new Error('web_search: query 不能为空');
            const want = Math.min(Math.max(Number.isFinite(a.count) ? Math.floor(a.count) : 5, 1), 8);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20_000);
            try {
                try {
                    const results = supportedSearchResults(query, await htmlSearch(query, want, ctrl.signal));
                    if (results.length) return results.map((item,index) => (index+1) + '. ' + item.title + '\n' + item.url + '\n' + item.snippet).join('\n\n');
                } catch { /* A failed/blocked HTML search may use the bounded RSS backup. */ }
                const res = await publicFetch('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&format=rss&setlang=zh-CN&mkt=zh-CN', {
                    signal: ctrl.signal,
                    headers: {
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                        'accept-language': 'zh-CN,zh;q=0.9',
                    },
                });
                if (!res.ok)
                    throw new Error('HTTP ' + res.status);
                const xml = await boundedWebBody(res);
                const decode = (s) => String(s)
                    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
                    .replace(/&[a-z#0-9]+;/gi, ' ')
                    .replace(/\s+/g, ' ').trim();
                const out = [];
                const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
                for (const chunk of items) {
                    if (out.length >= want)
                        break;
                    const title = decode((chunk.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '');
                    const url = decode((chunk.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? '');
                    const snippet = decode((chunk.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? '');
                    if (title === '' || url === '')
                        continue;
                    out.push({ title, url, snippet });
                }
                if (supportedSearchResults(query,out).length === 0)
                    return '搜索没有返回可用结果；请换关键词或明确说明没有查到，不要编造实时信息。';
                return out.map((item, index) => (index + 1) + '. ' + item.title + '\n' + item.url + '\n' + (item.snippet ? item.snippet.slice(0, 240) : '')).join('\n\n');
            }
            finally {
                clearTimeout(timer);
            }
        },
    })));
    register(cachedWebTool(defineTool({
        name: 'web_fetch',
        description: '抓取网页正文（纯文本，最多约 6000 字）。搜索看到想细读的链接再抓；不要用它抓搜索结果页。查天气直接抓 https://wttr.in/城市拼音?format=3，一行就有实时温度。',
        parameters: {
            url: { type: 'string', required: true, description: 'http(s) 网址' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const url = String(args?.url ?? '').trim();
            if (!/^https?:\/\//i.test(url))
                throw new Error('web_fetch: 只支持 http(s) 网址');
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20_000);
            try {
                const ua = /wttr\.in|wttr\.in\//i.test(url)
                    ? 'curl/8.0'
                    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
                const res = await publicFetch(url, {
                    signal: ctrl.signal,
                    headers: {
                        'user-agent': ua,
                        'accept-language': 'zh-CN,zh;q=0.9',
                    },
                });
                if (!res.ok)
                    throw new Error('HTTP ' + res.status);
                const type = String(res.headers.get('content-type') ?? '');
                if (!/text|json|xml|html/i.test(type))
                    throw new Error('不是文本页面：' + type);
                return extractWebText(await boundedWebBody(res), type, url);
            }
            finally {
                clearTimeout(timer);
            }
        },
    })));
    // -- [dsh-p1] long-term memory --
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
