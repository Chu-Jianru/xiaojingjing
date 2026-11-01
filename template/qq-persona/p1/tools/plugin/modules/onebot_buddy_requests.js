/**
 * [dsh-p1] Buddy-request viewer for the persona (patch_onebot_buddy_requests_tool.py).
 *
 * NapCat exposes no OneBot action that lists friend requests — its `request`
 * event only fires once, for unread entries, at arrival time. The patched
 * NapCat dumps FriendApi.getBuddyReq() (the same list the QQ client shows) to
 * <mediaDir>/buddy-requests.json every 30s; the bridge's buddy watch reads it
 * to notify the admin of NEW entries. This module powers `qq_buddy_requests`,
 * which surfaces the same dump to the model so she can answer
 * 「谁申请加我好友 / 申请列表里都有谁」.
 */

/** Dump file name inside the bridge media dir. */
export const BUDDY_REQUESTS_FILE = 'buddy-requests.json';

/** status labels used by the tool and its `status` filter param. */
export const STATUS_LABELS = {
    pending: '待审',
    friend: '已成好友',
    initiator: '我发起的申请',
    settled: '已处理',
};

/**
 * Map a buddy-requests.json dump + get_friend_list rows into display rows,
 * preserving the dump order (newest first). Pure so tests run without a bridge.
 *
 * @param {unknown} requests raw dump.requests entries (uin/reqTime/nick/extWords/isInitiator)
 * @param {unknown} friendRows get_friend_list rows (user_id/nickname); the dump's
 *   own `nick` is always empty in practice, so friend nicknames come from here.
 * @returns {Array<{user_id: string, nickname: string, comment: string,
 *   requested_at: string, status: string}>}
 */
export function buildBuddyRequestRows(requests, friendRows) {
    const friends = new Map();
    for (const row of Array.isArray(friendRows) ? friendRows : []) {
        const uin = String(row?.user_id ?? '');
        if (uin !== '')
            friends.set(uin, String(row?.nickname ?? ''));
    }
    const rows = [];
    for (const req of Array.isArray(requests) ? requests : []) {
        const uin = String(req?.uin ?? '');
        if (uin === '')
            continue;
        const reqTime = Number(req?.reqTime ?? 0);
        const isFriend = friends.has(uin);
        let nickname = String(req?.nick ?? '');
        if (nickname === '' && isFriend)
            nickname = friends.get(uin) ?? '';
        rows.push({
            user_id: uin,
            flag: String(req?.reqTime ?? ''),
            nickname,
            comment: String(req?.extWords ?? '').trim(),
            requested_at: reqTime > 0 ? new Date(reqTime * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
            status: isFriend ? STATUS_LABELS.friend
                : (req?.isInitiator === true ? STATUS_LABELS.initiator
                    : req?.isPending === false ? STATUS_LABELS.settled : STATUS_LABELS.pending),
        });
    }
    return rows;
}

/** Resolve the tool's optional `status` filter arg ('pending'|'friend'|'initiator' or a raw label). */
export function statusFilterLabel(arg) {
    const key = String(arg ?? '').trim();
    if (key === '')
        return '';
    return STATUS_LABELS[key] ?? key;
}
