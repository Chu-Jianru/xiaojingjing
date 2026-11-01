// Native request shapes verified against QQ 9.9.33-52230 wrapper.node.
// A successful submission is not acceptance by the other person/group.
const latestReceipts = new Map();
export function latestSocialReceipt(action, target) { return receiptSummary(latestReceipts.get(action + ':' + target)); }
export async function readSocialStatus(core, { action, target }) {
    target = String(target ?? '');
    if (!['add_friend', 'join_group'].includes(action) || !/^[1-9]\d{4,11}$/.test(target)) throw new Error('social_target_invalid');
    if (action === 'join_group') {
        const groups = await core.apis.GroupApi.getGroups(false);
        return { status: groups.some(g => String(g.groupCode) === target) ? 'already_member' : 'unknown', target };
    }
    const uid = await core.apis.UserApi.getUidByUinV2(target);
    if (uid && await core.context.session.getBuddyService().isBuddy(uid)) return { status: 'already_friend', target };
    const history = await core.apis.FriendApi.getBuddyReq();
    const row = history?.buddyReqs?.find(r => r.friendUid === uid && r.isInitiator === true);
    return { status: row ? 'submitted' : 'unknown', target, accepted: false };
}
export function socialCapabilities(core) {
    const session = core?.context?.session;
    return { add_friend: typeof session?.getAddBuddyService?.()?.addBuddy === 'function',
        join_group: typeof session?.getGroupService?.()?.reqToJoinGroup === 'function' };
}

export function groupRequest(target, message = '') {
    return { groupCode: target, sourceId: 3, sourceSubId: 0, richMsg: Buffer.alloc(0),
        applyMsg: message, token: '', auth: '', noVerifyAuth: '', transInfo: Buffer.alloc(0) };
}

export function friendRequest(target, uid, message = '', answer = '', setting = { querySetting: 1 }) {
    const request = { targetInfo: { uin: String(target), uid }, addFriendSetting: setting.querySetting,
        answer, sourceId: 3999, sourceSubId: 0, isContactFriend: false,
        myAllowFlag: 1, autoSend: 0, showMyCard: 0, myFriendGroupId: 0,
        verify: Buffer.from(message, 'utf8'), remark: Buffer.alloc(0) };
    for (const key of ['sig', 'token', 'name', 'name1'])
        if (setting[key] instanceof Uint8Array) request[key] = setting[key];
    return request;
}

export async function inspectFriend(core, target, { uid: resolvedUid, diagnostic = false } = {}) {
    if (!/^[1-9]\d{4,11}$/.test(String(target))) throw new Error('social_target_invalid');
    const uid = resolvedUid ?? await core.apis.UserApi.getUidByUinV2(target);
    if (!uid) throw new Error('social_user_not_found');
    const service = core.context.session.getAddBuddyService();
    const targetInfo = { uin: String(target), uid };
    const result = await service.getBuddySetting('DSH.qq_social', {
        targetInfo, sourceId: 3999, sourceSubId: 0, version: 1,
    }, Buffer.alloc(0));
    if (!diagnostic) return { targetInfo, result };
    const history = typeof core.apis.FriendApi?.getBuddyReq === 'function' ? await core.apis.FriendApi.getBuddyReq() : null;
    const row = history?.buddyReqs?.find(r => r.friendUid === uid);
    const tag = typeof service.getAddBuddyRequestTag === 'function'
        ? await service.getAddBuddyRequestTag('DSH.qq_social', targetInfo, Buffer.alloc(0)) : null;
    return { targetInfo, result, tag, request: row ? { isInitiator: row.isInitiator, isDecide: row.isDecide,
        reqType: row.reqType, reqTime: String(row.reqTime) } : null };
}

export function safeSocialReceipt(value) { return receiptSummary(value); }

export function socialResultCode(value, seen = new Set()) {
    if (typeof value === 'number') return value;
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    let acknowledged = false;
    for (const key of ['result', 'code', 'retCode', 'errCode', 'errorCode']) {
        if (typeof value[key] !== 'number') continue;
        if (value[key] !== 0) return value[key];
        acknowledged = true;
    }
    for (const key of ['result', 'rsp', 'response', 'data']) {
        if (!value[key] || typeof value[key] !== 'object') continue;
        const code = socialResultCode(value[key], seen);
        if (code !== undefined && code !== 0) return code;
        if (code === 0) acknowledged = true;
    }
    return acknowledged ? 0 : undefined;
}

function receiptSummary(value, depth = 0) {
    if (depth > 3) return typeof value;
    if (value instanceof Uint8Array) return { bytes: value.byteLength };
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'string') return value.slice(0, 200);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 24)
        .filter(([key]) => !/token|auth|key|cookie|credential|signature|sig$|context/i.test(key)).map(([key, v]) => [key, receiptSummary(v, depth + 1)]));
    return value;
}

export async function executeSocial(core, body) {
    const action = body?.action;
    const target = String(body?.target ?? '');
    if (!['add_friend', 'join_group'].includes(action) || !/^[1-9]\d{4,11}$/.test(target))
        throw new Error('social_target_invalid');
    if (target === String(core?.selfInfo?.uin)) throw new Error('social_self_target');
    const message = String(body.message ?? '').slice(0, 120);
    const session = core.context.session;
    let result;
    if (action === 'add_friend') {
        const uid = await core.apis.UserApi.getUidByUinV2(target);
        if (!uid) throw new Error('social_user_not_found');
        if (await session.getBuddyService().isBuddy(uid)) return { status: 'already_friend', target };
        const inspected = await inspectFriend(core, target, { uid });
        const setting = inspected.result?.rsp;
        if (socialResultCode(inspected.result) !== 0 || setting?.result !== 0 || !Number.isInteger(setting.querySetting))
            return { status: 'rejected', target, message: 'friend_setting_unavailable', details: receiptSummary(inspected.result) };
        const answer = String(body.answer ?? '').slice(0, 120);
        if (setting.querySetting === 2) return { status: 'rejected', target, message: 'friend_add_disabled' };
        if ([3, 4].includes(setting.querySetting) && !answer)
            return { status: 'needs_answer', target, question: receiptSummary(setting.question) };
        result = await session.getAddBuddyService().addBuddy('DSH.qq_social', friendRequest(target, uid, message, answer, setting), Buffer.alloc(0));
    } else {
        const groups = await core.apis.GroupApi.getGroups(false);
        if (groups.some(g => String(g.groupCode) === target)) return { status: 'already_member', target };
        const found = await core.apis.GroupApi.searchGroup(target);
        if (!found) return { status: 'rejected', target, message: 'group_not_found_in_search' };
        const ready = await session.getGroupService().getGroupInfoForJoinGroup(target, true, 1);
        if (ready?.errCode !== 0) return { status: 'rejected', target, code: ready?.errCode, message: 'group_join_info_unavailable' };
        const request = groupRequest(target, message);
        // Search returns the server-issued join authorization when required.
        const info = found.searchGroupInfo ?? found;
        const option = Number(info.groupOption ?? ready.result?.groupOption);
        if (option === 3) return { status: 'rejected', target, message: 'group_join_disabled' };
        if (Number(info.memberNum) >= Number(info.maxMemberNum) && Number(info.maxMemberNum) > 0)
            return { status: 'rejected', target, message: 'group_full' };
        if ([4, 5].includes(option)) {
            if (!String(body.answer ?? '').trim()) return { status: 'needs_answer', target, question: String(info.groupQuestion ?? ready.result?.groupQuestion ?? '') };
            request.applyMsg = String(body.answer).slice(0, 120);
        }
        for (const key of ['token', 'auth', 'noVerifyAuth'])
            if (typeof info[key] === 'string') request[key] = info[key];
        if (typeof info.joinGroupAuth === 'string') request.auth = info.joinGroupAuth;
        const join = [2, 5].includes(option) ? 'reqToJoinGroup' : 'joinGroup';
        result = await session.getGroupService()[join](request);
    }
    latestReceipts.set(action + ':' + target, result);
    while (latestReceipts.size > 16) latestReceipts.delete(latestReceipts.keys().next().value);
    // The native callback must acknowledge success. An absent receipt is unknown.
    const code = socialResultCode(result);
    if (action === 'join_group') {
        const current = await readSocialStatus(core, { action, target }).catch(() => null);
        if (current?.status === 'already_member') return current;
        // This QQ build has returned 1 for a request followed by a real join.
        // Keep it uncertain until membership is observed; do not invite retries.
        if (code === 1) return { status: 'unknown', target, code, accepted: false, receipt: receiptSummary(result) };
    }
    if (code === 0) return { status: 'submitted', target, accepted: false };
    if (typeof code === 'number') return { status: 'rejected', target, code, message: String(result.errMsg ?? result.errMessage ?? result.message ?? '').slice(0, 200), details: receiptSummary(result) };
    return { status: 'unknown', target, accepted: false, receipt: receiptSummary(result) };
}
