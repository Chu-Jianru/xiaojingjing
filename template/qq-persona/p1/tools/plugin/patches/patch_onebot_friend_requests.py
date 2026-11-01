"""Forward QQ friend requests to the admin and let the admin approve/refuse.

The plugin drops every non-message event, so friend requests were invisible.
This patch:

  1. on a `request/friend` event: remember it (flag + QQ + nickname) and send the
     admin a DM — "老大，有人加我好友：QQ …（昵称）｜验证：…｜同意回复「同意 QQ」，
     拒绝回复「拒绝 QQ」。"
  2. when the admin sends `同意 <QQ>` / `拒绝 <QQ>`: call `set_friend_add_request`
     with the stored flag, reply with the result, and do not pass the message to
     the model.

State lives in memory (a restart forgets pending requests; that is acceptable —
the requester can re-send). Idempotent; re-run after plugin upgrades.

  python tools/plugin/patches/patch_onebot_friend_requests.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] friend requests"

ANCHOR_1 = "                const inbound = normalizeOneBot11(event);\n"
HOOK_1 = (
    "                const inbound = normalizeOneBot11(event);\n"
    "                // [dsh-p1] friend requests are not messages: forward them to the admin.\n"
    "                if (inbound === null && await handleFriendRequestEvent(this, event))\n"
    "                    return;\n"
)

ANCHOR_2 = "                await this.processInbound(inbound);\n"
HOOK_2 = (
    "                // [dsh-p1] `同意 <QQ>` / `拒绝 <QQ>` from the admin settles a pending request.\n"
    "                if (inbound.kind === 'private'\n"
    "                    && await handleFriendApprovalReply(this, inbound.text, inbound.userId))\n"
    "                    return;\n"
    "                await this.processInbound(inbound);\n"
)

HELPERS = f"""
// -- {MARKER} ------------------------------------------------------------
// QQ friend requests arrive as post_type=request / request_type=friend; the
// inbound pipeline normally drops them. Forward to the admin, then let the
// admin settle them with `同意 <QQ>` / `拒绝 <QQ>` (never sent to the model).
const pendingFriendRequests = new Map();
const FRIEND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

function friendAdminList(bridge) {{
    const admins = bridge?.deps?.policy?.adminUsers;
    return Array.isArray(admins) ? admins.map(String) : [];
}}

async function handleFriendRequestEvent(bridge, event) {{
    if (event?.post_type !== 'request' || event?.request_type !== 'friend')
        return false;
    const userId = String(event.user_id ?? '');
    const flag = String(event.flag ?? '');
    if (userId === '' || flag === '')
        return false;
    const admins = friendAdminList(bridge);
    if (admins.length === 0)
        return false;
    let nickname = String(event.nickname ?? '');
    if (nickname === '') {{
        try {{
            const info = await bridge.guardedConnectionCall('get_stranger_info', {{ user_id: Number(userId) }});
            nickname = String(info?.nickname ?? info?.data?.nickname ?? '');
        }}
        catch {{ /* nickname is optional */ }}
    }}
    const comment = String(event.comment ?? '').trim();
    pendingFriendRequests.set(userId, {{ flag, at: Date.now(), nickname }});
    const parts = ['老大，有人想加我好友，要同意吗？QQ ' + userId + (nickname === '' ? '' : '（' + nickname + '）')];
    if (comment !== '')
        parts.push('验证：' + comment);
    parts.push('回「同意 ' + userId + '」或「拒绝 ' + userId + '」就行。');
    await bridge.sendToChat('private:' + admins[0], parts.join('｜'));
    bridge.deps.log('info', 'friend request ' + userId + ' forwarded to admin');
    return true;
}}

async function handleFriendApprovalReply(bridge, text, userId) {{
    const admins = friendAdminList(bridge);
    if (!admins.includes(String(userId)))
        return false;
    const match = String(text ?? '').trim().match(/^\\/?(同意|通过|拒绝|不同意)\\s*(\\d{{5,}})$/);
    if (match === null)
        return false;
    const approve = match[1] === '同意' || match[1] === '通过';
    const target = match[2];
    const pending = pendingFriendRequests.get(target);
    if (pending === undefined || Date.now() - pending.at > FRIEND_REQUEST_TTL_MS) {{
        pendingFriendRequests.delete(target);
        await bridge.sendToChat('private:' + userId, '没有找到 QQ ' + target + ' 的好友请求，可能已经处理过或已过期。');
        return true;
    }}
    try {{
        await bridge.guardedConnectionCall('set_friend_add_request', {{ flag: pending.flag, approve }});
        pendingFriendRequests.delete(target);
        await bridge.sendToChat('private:' + userId, (approve ? '已经同意 ' : '已经拒绝 ') + target + ' 的好友请求。');
    }}
    catch (error) {{
        await bridge.sendToChat('private:' + userId, '处理 ' + target + ' 的好友请求失败：' + (error?.message ?? String(error)));
    }}
    return true;
}}
"""


def apply(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("friend-request patch already applied")
        return
    if text.count(ANCHOR_1) != 1 or text.count(ANCHOR_2) != 1:
        raise SystemExit("bridge.js anchors changed — plugin version mismatch")
    backup = path.with_suffix(".js.bak-friendreq")
    shutil.copy2(path, backup)
    text = text.replace(ANCHOR_1, HOOK_1, 1).replace(ANCHOR_2, HOOK_2, 1) + HELPERS
    path.write_text(text, encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def revert(path: Path) -> None:
    backup = path.with_suffix(".js.bak-friendreq")
    if not backup.exists():
        raise SystemExit("no backup to restore")
    shutil.copy2(backup, path)
    backup.unlink()
    print("reverted")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    path = LIB / "bridge.js"
    if args.check:
        ok = MARKER in path.read_text(encoding="utf-8")
        print("patched" if ok else "NOT patched")
        raise SystemExit(0 if ok else 1)
    if args.revert:
        revert(path)
        return
    apply(path)


if __name__ == "__main__":
    main()
