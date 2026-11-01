"""Dump QQ buddy requests from NapCat to a JSON file for DSH.

NapCat's OneBot surface has no "list friend requests" API (only the doubt list),
and its request event fires only for *unread* entries. So the DSH bot cannot see
requests that were read on the phone, or that arrived while the bridge was down.

This patch adds a tiny timer inside NapCat's `initBuddyListener()`: every 30s it
calls the internal `FriendApi.getBuddyReq()` (the same list the QQ client holds)
and writes it to:

    <repo>/bot-home/media/onebot/buddy-requests.json

（落盘绝对路径在应用补丁时按本补丁的仓库位置推导——迁移后重跑本补丁 + 重启 NapCat 即指向新根。）

DSH reads that file and notifies the admin (and can approve with flag=reqTime).

Idempotent; validates the patched bundle with `node --check` and restores the
backup automatically if parsing breaks:

  python tools/plugin/patches/patch_napcat_buddy_dump.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
# NapCat 运行目录在仓库外（机器绑定）；换机器用环境变量 NAPCAT_MJS 指到新 napcat.mjs
NAPCAT = Path(
    os.environ.get("NAPCAT_MJS")
    or r"C:/Users/USER\NapCat-p1\shell\versions\9.9.33-52230\resources\app\napcat\napcat.mjs"
)
BACKUP = NAPCAT.with_suffix(".mjs.bak-buddydump")
MARKER = "[dsh-buddy-watch]"

ANCHOR = (
    "}, this.context.session.getBuddyService().addKernelBuddyListener("
    "cu(e, this.context.logger));"
)

BLOCK = r'''
        // [dsh-buddy-watch] dump buddy requests for DSH (no OneBot list API)
        const __dshBuddyDump = async () => {
            try {
                const __r = await this.core.apis.FriendApi.getBuddyReq();
                const __out = [];
                for (const __q of (__r && __r.buddyReqs) || []) {
                    try {
                        const __uin = await this.core.apis.UserApi.getUinByUidV2(__q.friendUid);
                        __out.push({
                            uin: String(__uin || ''),
                            reqTime: String(__q.reqTime || ''),
                            nick: String(__q.nick || ''),
                            extWords: String(__q.extWords || ''),
                            isUnread: !!__q.isUnread,
                            // Same pending predicate as NapCat's live request event,
                            // independent of whether the phone has read the request.
                            isPending: !(__q.isInitiator || (__q.isDecide && __q.reqType !== UF.KMEINITIATORWAITPEERCONFIRM)),
                            isInitiator: !!__q.isInitiator
                        });
                    } catch {}
                }
                fe.writeFileSync('__MEDIA_JSONL__', JSON.stringify({ at: Date.now(), requests: __out }), 'utf8');
            } catch {}
        };
        void __dshBuddyDump();
        if (!globalThis.__dshBuddyTimer)
            globalThis.__dshBuddyTimer = setInterval(() => void __dshBuddyDump(), 30000);
'''.replace(
    "__MEDIA_JSONL__",
    str(REPO / "bot-home" / "media" / "onebot" / "buddy-requests.json").replace("\\", "\\\\"),
)


def parses(path: Path) -> bool:
    result = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr.strip()[:500])
    return result.returncode == 0


def apply() -> None:
    text = NAPCAT.read_text(encoding="utf-8")
    if MARKER in text:
        if "isPending:" not in text[text.index(MARKER):text.index(MARKER) + 2400]:
            old = "                            isUnread: !!__q.isUnread,"
            if old not in text:
                raise SystemExit("buddy dump anchor changed")
            new = old + "\n                            isPending: !(__q.isInitiator || (__q.isDecide && __q.reqType !== UF.KMEINITIATORWAITPEERCONFIRM)),"
            original = NAPCAT.read_bytes()
            NAPCAT.write_text(text.replace(old, new, 1), encoding="utf-8")
            if not parses(NAPCAT):
                NAPCAT.write_bytes(original)
                raise SystemExit("buddy dump refresh failed parsing; restored")
            print("buddy dump pending-state metadata refreshed (takes effect on next NapCat start)")
        else:
            print("napcat bundle already patched")
        return
    if ANCHOR not in text:
        raise SystemExit("napcat anchor changed — NapCat version mismatch")
    backup_existed = BACKUP.exists()
    if not backup_existed:
        shutil.copy2(NAPCAT, BACKUP)
    patched = text.replace(ANCHOR, ANCHOR + BLOCK, 1)
    NAPCAT.write_text(patched, encoding="utf-8")
    if not parses(NAPCAT):
        shutil.copy2(BACKUP, NAPCAT)
        raise SystemExit("patched bundle failed node --check; restored backup")
    print(f"patched {NAPCAT} (backup: {BACKUP.name})")


def check() -> int:
    text = NAPCAT.read_text(encoding="utf-8")
    ok = MARKER in text and "isPending:" in text[text.index(MARKER):text.index(MARKER) + 2400]
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BACKUP.exists():
        shutil.copy2(BACKUP, NAPCAT)
        BACKUP.unlink()
        print(f"reverted {NAPCAT}")
    else:
        print("no backup; nothing reverted")


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
