"""Friend roster with provenance (谁、什么时候、通过什么途径加的) + wider QQ reads.

QQ's `get_friend_list` does not expose an add time or source, so we keep our own
roster (<mediaDir>/roster.json):

  - every successful approval records { addAt, source(验证消息), how: 她批准 }
  - a 5-minute sync fills in friends that appear without an approval we saw
    (manual approval by the admin / already friends before this feature) and
    marks those honestly as "未知"
  - the `qq_roster` tool answers "谁加的你 / 什么时候 / 怎么加的"

Also widens the `qq_napcat_api` read whitelist with friend categories, group
honor info, status and version info.

Idempotent:

  python tools/plugin/patches/patch_onebot_roster.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
TOOLS = LIB / "tools.js"
BRIDGE = LIB / "bridge.js"
MARKER = "[dsh-p1] roster"

TOOLS_IMPORT_OLD = "import { appendFile, mkdir } from 'node:fs/promises';"
TOOLS_IMPORT_NEW = "import { appendFile, mkdir, readFile } from 'node:fs/promises';"

TOOLS_ANCHOR = "    // -- [dsh-p1] long-term memory --\n    return () => {"

TOOLS_HOOK = """    register(defineTool({
        name: 'qq_roster',
        description: '查好友名单和来历：谁、昵称、备注、什么时候加的、通过什么途径/验证消息。被问「谁加的你 / 什么时候加的 / 怎么加的」时用。',
        parameters: {
            user_id: { type: 'string', description: '只查一个人；省略=全部（最多 50 个）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const a = args ?? {};
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
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
    // -- [dsh-p1] long-term memory --
    return () => {"""

WHITELIST_ANCHOR = "'get_login_info',\n"
WHITELIST_NEW = WHITELIST_ANCHOR + (
    "// " + MARKER + ": more read-only QQ info\n"
    "'get_friends_with_category',\n"
    "'get_group_honor_info',\n"
    "'get_status',\n"
    "'get_version_info',\n"
)

BRIDGE_IMPORT_OLD = "import { readFile, realpath } from 'node:fs/promises';"
BRIDGE_IMPORT_NEW = "import { readFile, realpath, writeFile } from 'node:fs/promises';"

# v2.20: recordFriendAdded admits the new friend into the DM gate's friend
# cache immediately (noteFriendAdded lives in inbound.js; this anchor exists
# only after patch_onebot_active_chat.py — same cross-patch order as the
# startBuddyWatch anchors below).
BRIDGE_INBOUND_IMPORT_OLD = "import { InboundPipeline, normalizeOneBot11, noteSelfSent } from './inbound.js';"
BRIDGE_INBOUND_IMPORT_NEW = "import { InboundPipeline, normalizeOneBot11, noteSelfSent, noteFriendAdded } from './inbound.js';"

BRIDGE_START_OLD = "        startBuddyWatch(this);"
BRIDGE_START_NEW = BRIDGE_START_OLD + "\n        startRosterSync(this);"

BRIDGE_STOP_OLD = "        stopBuddyWatch(this);"
BRIDGE_STOP_NEW = BRIDGE_STOP_OLD + "\n        stopRosterSync(this);"

BRIDGE_APPROVAL_OLD = """        await bridge.guardedConnectionCall('set_friend_add_request', { flag: pending.flag, approve });
        await store.delete(target);"""
BRIDGE_APPROVAL_NEW = """        await bridge.guardedConnectionCall('set_friend_add_request', { flag: pending.flag, approve });
        await store.delete(target);
        if (approve)
            await recordFriendAdded(bridge, target, pending.comment ?? '');"""

ROSTER_HELPERS = """
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
                addAt: reason === 'startup' ? null : now,
                source: reason === 'startup' ? '未知（启用记录前就已是好友）' : '未知（自动发现，可能是老大手动加的）',
                verification: '',
                how: reason === 'startup' ? '' : '自动发现',
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
"""


def patch_file(path: Path, old: str, new: str, suffix: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        print(f"{path.name} already patched")
        return
    if old not in text:
        raise SystemExit(f"{path.name}: anchor changed — plugin version mismatch")
    backup = path.with_suffix(f".js{suffix}")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def apply() -> None:
    patch_file(TOOLS, TOOLS_IMPORT_OLD, TOOLS_IMPORT_NEW, ".bak-roster")
    patch_file(TOOLS, TOOLS_ANCHOR, TOOLS_HOOK, ".bak-roster")
    patch_file(TOOLS, WHITELIST_ANCHOR, WHITELIST_NEW, ".bak-roster")
    patch_file(BRIDGE, BRIDGE_IMPORT_OLD, BRIDGE_IMPORT_NEW, ".bak-roster")
    patch_file(BRIDGE, BRIDGE_INBOUND_IMPORT_OLD, BRIDGE_INBOUND_IMPORT_NEW, ".bak-roster")
    patch_file(BRIDGE, BRIDGE_START_OLD, BRIDGE_START_NEW, ".bak-roster")
    patch_file(BRIDGE, BRIDGE_STOP_OLD, BRIDGE_STOP_NEW, ".bak-roster")
    # Later durable-notification patch uses settle() rather than delete().
    if "await recordFriendAdded(bridge, target, pending.comment ?? '');" not in BRIDGE.read_text(encoding="utf-8"):
        patch_file(BRIDGE, BRIDGE_APPROVAL_OLD, BRIDGE_APPROVAL_NEW, ".bak-roster")
    text = BRIDGE.read_text(encoding="utf-8")
    if MARKER not in text:
        backup = BRIDGE.with_suffix(".js.bak-roster")
        if not backup.exists():
            shutil.copy2(BRIDGE, backup)
        BRIDGE.write_text(text + ROSTER_HELPERS, encoding="utf-8")
        print(f"appended roster helpers to {BRIDGE}")
    else:
        print("roster helpers already appended")


def check() -> int:
    ok = MARKER in BRIDGE.read_text(encoding="utf-8")
    ok = ok and "qq_roster" in TOOLS.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    for path in (TOOLS, BRIDGE):
        backup = path.with_suffix(".js.bak-roster")
        if backup.exists():
            shutil.copy2(backup, path)
            backup.unlink()
            print(f"reverted {path}")


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
