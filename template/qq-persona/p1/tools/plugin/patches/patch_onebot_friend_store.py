"""Persist pending QQ friend requests to media/onebot/friend-requests.json.

The friend-request patch kept approvals in a module-level Map, so every DSH
restart forgot requests the admin had not settled yet. This patch:

  - drops `lib/friend-store.js` (source of truth: tools/plugin/modules/onebot_friend_store.js)
  - rewrites the bridge's friend-request block to use that store
    (24h TTL, atomic writes, pruned on load/read)

Idempotent; re-run after `dsh plugin ... update/install`, then truly restart DSH:

  python tools/plugin/patches/patch_onebot_friend_store.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_friend_store.py --check    # patched?
  python tools/plugin/patches/patch_onebot_friend_store.py --revert   # restore bridge.js
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_friend_store.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "friend-store.js"
BRIDGE = LIB / "bridge.js"
BACKUP = BRIDGE.with_suffix(".js.bak-friendstore")

MARKER = "[dsh-p1] friend store"
TAIL_MARKER = "// -- [dsh-p1] friend requests ------------------------------------------------------------"

IMPORT_OLD = "import { CatchUp } from './catchup.js';"
IMPORT_NEW = IMPORT_OLD + "\nimport { FriendRequestStore } from './friend-store.js';"

PRELOAD_ANCHOR = "        this.registry.mappingLoaded = this.ready().then(async () => {"
PRELOAD_INSERT = """        // [dsh-p1] friend store: load pending requests early so the log shows
        // what survived a restart (approval also loads lazily).
        void friendStore(this).ensureLoaded();
""" + PRELOAD_ANCHOR

NEW_TAIL = '''// -- [dsh-p1] friend requests ------------------------------------------------------------
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
    let nickname = String(event.nickname ?? '');
    if (nickname === '') {
        try {
            const info = await bridge.guardedConnectionCall('get_stranger_info', { user_id: Number(userId) });
            nickname = String(info?.nickname ?? info?.data?.nickname ?? '');
        }
        catch { /* nickname is optional */ }
    }
    const comment = String(event.comment ?? '').trim();
    // Persist BEFORE the DM: a failed notification must not lose the request.
    await friendStore(bridge).set(userId, { flag, at: Date.now(), nickname, comment });
    const parts = ['老大，有人想加我好友，要同意吗？QQ ' + userId + (nickname === '' ? '' : '（' + nickname + '）')];
    if (comment !== '')
        parts.push('验证：' + comment);
    parts.push('回「同意 ' + userId + '」或「拒绝 ' + userId + '」就行。');
    await bridge.sendToChat('private:' + admins[0], parts.join('｜'));
    bridge.deps.log('info', 'friend request ' + userId + ' forwarded to admin');
    return true;
}

async function handleFriendApprovalReply(bridge, text, userId) {
    const admins = friendAdminList(bridge);
    if (!admins.includes(String(userId)))
        return false;
    const match = String(text ?? '').trim().match(/^\\/?(同意|通过|拒绝|不同意)\\s*(\\d{5,})$/);
    if (match === null)
        return false;
    const approve = match[1] === '同意' || match[1] === '通过';
    const target = match[2];
    const store = friendStore(bridge);
    const pending = await store.get(target);
    if (pending === undefined) {
        await bridge.sendToChat('private:' + userId, '没有找到 QQ ' + target + ' 的好友请求，可能已经处理过或已过期。');
        return true;
    }
    try {
        await bridge.guardedConnectionCall('set_friend_add_request', { flag: pending.flag, approve });
        await store.delete(target);
        await bridge.sendToChat('private:' + userId, (approve ? '已经同意 ' : '已经拒绝 ') + target + ' 的好友请求。');
    }
    catch (error) {
        await bridge.sendToChat('private:' + userId, '处理 ' + target + ' 的好友请求失败：' + (error?.message ?? String(error)));
    }
    return true;
}
'''


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("friend-store.js up to date")
        return
    DEST.write_text(source, encoding="utf-8")
    print(f"installed {DEST}")


def apply() -> None:
    text = BRIDGE.read_text(encoding="utf-8")
    changed = False
    if not (MARKER in text and "from './friend-store.js'" in text):
        if TAIL_MARKER not in text:
            raise SystemExit("bridge.js friend-request block missing — run patch_onebot_friend_requests.py first")
        if IMPORT_OLD not in text:
            raise SystemExit("bridge.js import anchor changed (catchup patch missing?)")
        if not BACKUP.exists():
            shutil.copy2(BRIDGE, BACKUP)
        head = text[: text.index(TAIL_MARKER)]
        text = head.replace(IMPORT_OLD, IMPORT_NEW, 1) + NEW_TAIL
        changed = True
    if "friendStore(this).ensureLoaded()" not in text:
        if PRELOAD_ANCHOR not in text:
            raise SystemExit("bridge.js start() anchor changed (plugin version mismatch)")
        if not BACKUP.exists():
            shutil.copy2(BRIDGE, BACKUP)
        text = text.replace(PRELOAD_ANCHOR, PRELOAD_INSERT, 1)
        changed = True
    if changed:
        BRIDGE.write_text(text, encoding="utf-8")
        print(f"patched {BRIDGE} (backup: {BACKUP.name})")
    else:
        print("bridge.js already patched")
    install_module()


def check() -> int:
    text = BRIDGE.read_text(encoding="utf-8")
    ok = MARKER in text and "from './friend-store.js'" in text
    ok = ok and "friendStore(this).ensureLoaded()" in text
    ok = ok and DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BACKUP.exists():
        shutil.copy2(BACKUP, BRIDGE)
        BACKUP.unlink()
        print(f"reverted {BRIDGE}")
    else:
        print("no bridge.js backup; nothing reverted")
    if DEST.exists():
        DEST.unlink()
        print(f"removed {DEST}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.check:
        sys.exit(check())
    if args.revert:
        revert()
        return
    apply()


if __name__ == "__main__":
    main()
