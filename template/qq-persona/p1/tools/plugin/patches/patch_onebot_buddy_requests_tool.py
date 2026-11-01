"""Expose the buddy-request dump to the model as a `qq_buddy_requests` tool.

The persona could not answer 「谁申请加我好友」: qq_roster only lists approved
friends, and NapCat's OneBot layer has no action that lists friend requests.
The patched NapCat already dumps FriendApi.getBuddyReq() to
<mediaDir>/buddy-requests.json every 30s (patch_napcat_buddy_dump.py) and the
bridge's buddy watch uses it to notify the admin of new entries — this patch
hands the same dump to the model:

  - drops `lib/buddy-requests.js` (source of truth: tools/plugin/modules/onebot_buddy_requests.js)
  - registers a `qq_buddy_requests` tool in tools.js (before qq_rule) that
    reads the dump, joins it with get_friend_list, and reports each request
    with QQ/nickname/comment/time/status (待审 / 已成好友 / 我发起的申请)

Idempotent; re-run after `dsh plugin ... update/install`, then truly restart DSH:

  python tools/plugin/patches/patch_onebot_buddy_requests_tool.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_buddy_requests_tool.py --check    # patched?
  python tools/plugin/patches/patch_onebot_buddy_requests_tool.py --revert   # restore tools.js
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_buddy_requests.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "buddy-requests.js"
TARGET = LIB / "tools.js"
BACKUP = TARGET.with_suffix(".js.bak-buddyreq")

MARKER = "[dsh-p1] buddy requests tool"
IMPORT_ANCHOR = "import { lookImage } from './vision.js';"
IMPORT_NEW = IMPORT_ANCHOR + "\nimport { buildBuddyRequestRows, statusFilterLabel, BUDDY_REQUESTS_FILE } from './buddy-requests.js';"
INSERT_ANCHOR = "    register(defineTool({\n        name: 'qq_rule',"

TOOL_BLOCK = r'''    // [dsh-p1] buddy requests tool: NapCat's OneBot layer cannot list friend
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
'''


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("buddy-requests.js up to date")
        return
    DEST.write_bytes(SRC.read_bytes())
    print(f"installed {DEST}")


def apply() -> None:
    text = TARGET.read_text(encoding="utf-8")
    changed = False
    if MARKER not in text or "from './buddy-requests.js'" not in text:
        if INSERT_ANCHOR not in text:
            raise SystemExit("tools.js qq_rule anchor changed (plugin version mismatch)")
        if IMPORT_ANCHOR not in text:
            raise SystemExit("tools.js import anchor changed (plugin version mismatch)")
        if not BACKUP.exists():
            shutil.copy2(TARGET, BACKUP)
        text = text.replace(IMPORT_ANCHOR, IMPORT_NEW, 1)
        text = text.replace(INSERT_ANCHOR, TOOL_BLOCK + INSERT_ANCHOR, 1)
        changed = True
    old_description = '查好友申请：谁、申请留言、什么时候、现在处理没有'
    new_description = '查好友申请：user_id是QQ号，flag才是审批标识；审批优先给qq_agent_api的params.user_id，不要拿QQ号猜flag。谁、申请留言、什么时候、现在处理没有'
    if old_description in text:
        text = text.replace(old_description, new_description, 1)
        changed = True
    if changed:
        TARGET.write_text(text, encoding="utf-8", newline="\r\n" if b"\r\n" in TARGET.read_bytes() else "\n")
        print(f"patched {TARGET} (backup: {BACKUP.name})")
    else:
        print("tools.js already patched")
    install_module()


def check() -> int:
    text = TARGET.read_text(encoding="utf-8")
    ok = MARKER in text and "from './buddy-requests.js'" in text
    ok = ok and DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BACKUP.exists():
        shutil.copy2(BACKUP, TARGET)
        BACKUP.unlink()
        print(f"reverted {TARGET}")
    else:
        print("no tools.js backup; nothing reverted")
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
