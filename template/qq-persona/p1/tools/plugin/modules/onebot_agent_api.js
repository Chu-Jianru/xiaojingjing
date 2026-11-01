/**
 * [dsh-p1] v2.28 agent tier: 管理级 OneBot actions（qq_agent_api / qq_send_text 的白名单与门禁）。
 * 「agent 能力」= 老大让她替自己在 QQ 里做事的全部口子；仅老大的回合可用（activeTurnRole 门禁）。
 * Pure so tests run without a bridge（只依赖 node 内建）。
 * Deployed by patch_onebot_agent_api.py: 本文件字节拷贝为 lib/agent-api.js，工具块插入 lib/tools.js。
 * 白名单于 2026-10-26 对 NapCat 4.18.41 逐个在线探测定稿（空参探测：缺参报错=存在，不支持的Api=不存在）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Resolve a QQ number or a real request flag against the current pending list. */
export function resolveFriendApproval(requests, params) {
    const a = params ?? {};
    if (typeof a.approve !== 'boolean') throw new Error('好友审批必须明确approve=true或false');
    const pending = (Array.isArray(requests) ? requests : []).filter(r =>
        r?.isInitiator !== true && r?.isPending !== false && /^\d+$/.test(String(r?.reqTime ?? '')));
    const userId = String(a.user_id ?? ''), supplied = String(a.flag ?? '');
    let matches;
    if (userId) {
        matches = pending.filter(r => String(r.uin) === userId);
        if (supplied && supplied !== userId) matches = matches.filter(r => String(r.reqTime) === supplied);
    } else {
        matches = pending.filter(r => String(r.reqTime) === supplied);
        if (!matches.length) matches = pending.filter(r => String(r.uin) === supplied);
    }
    if (matches.length !== 1) throw new Error('找不到唯一待审好友申请；先用qq_buddy_requests查询，不要猜flag或重复尝试');
    const row = matches[0];
    if (pending.filter(r => String(r.reqTime) === String(row.reqTime)).length !== 1)
        throw new Error('申请标识对应多个人，暂不审批，避免加错人');
    return { user_id: String(row.uin), flag: String(row.reqTime), approve: a.approve,
        ...(typeof a.remark === 'string' ? { remark: a.remark } : {}) };
}

export async function executeFriendApproval(bridge, params, { wait = delay } = {}) {
    const dump = JSON.parse(await readFile(join(bridge.deps.config.mediaDir, 'buddy-requests.json'), 'utf8'));
    if (!Number.isFinite(dump.at) || Math.abs(Date.now() - dump.at) > 120_000)
        throw new Error('好友申请快照未同步；稍后查询，不猜申请标识');
    const resolved = resolveFriendApproval(dump.requests, params);
    const friends = async () => {
        const value = await bridge.guardedConnectionCall('get_friend_list', {});
        const rows = Array.isArray(value) ? value : value?.data;
        if (!Array.isArray(rows)) throw new Error('好友列表暂不可确认');
        return rows.some(r => String(r.user_id) === resolved.user_id);
    };
    if (resolved.approve && await friends())
        return { user_id: resolved.user_id, approved: true, confirmed: true, already_friend: true };
    const { user_id, ...payload } = resolved;
    await bridge.guardedConnectionCall('set_friend_add_request', payload);
    if (resolved.approve) {
        for (const pause of [0, 250, 500]) {
            if (pause) await wait(pause);
            try { if (await friends()) return { user_id, approved: true, confirmed: true }; }
            catch { /* submission succeeded, confirmation may still be unavailable */ }
        }
    }
    return { user_id, approved: resolved.approve, confirmed: false, status: 'submitted',
        next: '处理已提交；尚未确认最终状态，不重复审批，不说已经加上' };
}

/** qq_agent_api 放行的 action（全部在 NapCat 4.18.41 实测存在）。 */
export const NAPCAT_AGENT_ACTIONS = [
    // 代发消息
    'send_msg',
    'send_private_msg',
    'send_group_msg',
    'send_private_forward_msg',
    'send_group_forward_msg',
    'send_forward_msg',
    // 互动
    'send_like',
    'send_group_sign',
    'set_input_status',
    // 群管理
    'set_group_card',
    'set_group_special_title',
    'set_group_ban',
    'set_group_whole_ban',
    'set_group_admin',
    'set_group_kick',
    'set_group_leave',
    'set_essence_msg',
    '_send_group_notice',
    'set_group_add_request',
    'get_group_ignored_notifies',
    // 好友
    'set_friend_add_request',
    'delete_friend',
    // 自己的账号
    'set_qq_avatar',
    'set_online_status',
    'mark_msg_as_read',
    'get_online_clients',
];

/** 永不通过任何模型工具放行的 action（账号凭据/进程控制——给出去等于交出账号本身）。 */
export const NAPCAT_AGENT_DENYLIST = [
    'get_cookies',
    'get_credentials',
    'get_csrf_token',
    'restart',
    'set_restart',
];

/** qq_send_text 单条文字上限。 */
export const MAX_AGENT_TEXT = 1000;

/** 门禁拒绝话术（工具名由调用方拼前缀）。 */
export const MSG_AGENT_NOT_ADMIN = '群管理或改账号的事需要先和老大商量；按语境自然表达自己的决定，不念权限、工具或照抄这段说明';
export const MSG_AGENT_DENIED = '该 action 属于账号凭据/进程类，永不开放';
export const MSG_AGENT_NOT_WHITELIST = 'action 不在 agent 白名单内';

/**
 * 分层一个 action：'agent'=老大的回合可放行；'deny'=永不放行；'unknown'=不在白名单。
 */
export function classifyAgentAction(action) {
    const a = String(action ?? '');
    if (NAPCAT_AGENT_DENYLIST.includes(a)) return 'deny';
    if (NAPCAT_AGENT_ACTIONS.includes(a)) return 'agent';
    return 'unknown';
}

/**
 * 本回合是否由老大的消息发起（fail-closed）：会话映射不到 chat、chat 未注册、
 * 角色不是 'admin'、bridge 缺方法——一律按非老大处理。
 */
export function isAdminTurn(bridge, sessionId) {
    if (!bridge || sessionId === undefined || sessionId === null || sessionId === '') return false;
    let chatId;
    try {
        chatId = typeof bridge.chatForSession === 'function' ? bridge.chatForSession(String(sessionId)) : undefined;
    }
    catch {
        return false;
    }
    if (chatId === undefined || chatId === null) return false;
    const chats = bridge.chats;
    const chat = chats && typeof chats.get === 'function' ? chats.get(chatId) : undefined;
    return chat?.activeTurnRole === 'admin';
}

/** 审计 reason 用的参数摘要：压成一行、超长截断；空参返回 ''。 */
export function summarizeAgentParams(params) {
    if (typeof params !== 'object' || params === null) return '';
    const keys = Object.keys(params);
    if (keys.length === 0) return '';
    let text;
    try {
        text = JSON.stringify(params);
    }
    catch {
        return '?';
    }
    text = text.replace(/\s+/g, ' ');
    return text.length > 160 ? text.slice(0, 157) + '…' : text;
}

/** 一条 qq-actions.log 审计行（与 outbound 的 auditWrite 同构：action 记 agent:<名字>）。 */
export function buildAgentAuditLine(ts, chatId, action, ok, reason) {
    return JSON.stringify({ ts, chatId, action: 'agent:' + action, ok, reason }) + '\n';
}

/** 写一条审计（best-effort：mediaDir 未知或写失败都静默，不影响主流程）。 */
export async function writeAgentAudit(mediaDir, chatId, action, ok, reason) {
    const dir = String(mediaDir ?? '');
    if (dir === '') return;
    try {
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, 'qq-actions.log'), buildAgentAuditLine(Date.now(), chatId, action, ok, reason), 'utf8');
    }
    catch {
        /* 审计失败不挡操作 */
    }
}
