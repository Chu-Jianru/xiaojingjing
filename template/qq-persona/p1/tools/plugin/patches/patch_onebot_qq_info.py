"""Let 小鲸鲸 read QQ roster info through `qq_napcat_api`.

The tool's NapCat API whitelist covered group members and history but not the
roster itself, so "群主是谁/都有谁/我的好友" ended in "我这边看不到". This patch
adds the read-only roster APIs:

  get_friend_list, get_group_list, get_group_info, get_recent_contact,
  get_login_info

  python tools/plugin/patches/patch_onebot_qq_info.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
TARGET = TOOLS / "tools.js"
BACKUP = TARGET.with_suffix(".js.bak-qqinfo")
MARKER = "[dsh-p1] qq info apis"

ANCHOR = "const NAPCAT_API_WHITELIST = [\n"
NEW = ANCHOR + (
    "// " + MARKER + ": roster reads for \"群主是谁 / 都有谁 / 我的好友\"\n"
    "'get_friend_list',\n"
    "'get_group_list',\n"
    "'get_group_info',\n"
    "'get_recent_contact',\n"
    "'get_login_info',\n"
)


def apply() -> None:
    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print("qq info apis already patched")
        return
    if ANCHOR not in text:
        raise SystemExit("tools.js whitelist anchor changed — plugin version mismatch")
    if not BACKUP.exists():
        shutil.copy2(TARGET, BACKUP)
    TARGET.write_text(text.replace(ANCHOR, NEW, 1), encoding="utf-8")
    print(f"patched {TARGET} (backup: {BACKUP.name})")


def check() -> int:
    ok = MARKER in TARGET.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BACKUP.exists():
        shutil.copy2(BACKUP, TARGET)
        BACKUP.unlink()
        print(f"reverted {TARGET}")
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
