"""Hot-meme recall for 小鲸鲸 (接梗).

She should understand current 热梗 without a 70-entry dictionary eating the
prompt on every turn. This patch adds a per-message recall:

  - <mediaDir>/hot-memes.jsonl holds the dictionary (term / aliases / meaning /
    reply hint / exact-only flag); edits take effect within 60s, no restart
  - every inbound message is matched (substring, ASCII case-folded) and at most
    two hits are injected as a trusted `[梗]` block next to `[记忆]`

Source of truth: qq-persona/p1/memes/hot-memes.jsonl (synced to the runtime
file only when the runtime file is missing, or with --sync-memes).

  python tools/plugin/patches/patch_onebot_hot_memes.py [--check|--revert|--sync-memes]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_meme_recall.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "meme-recall.js"
INBOUND = LIB / "inbound.js"
BACKUP = INBOUND.with_suffix(".js.bak-memes")

CANONICAL = TOOLS.parent / "memes" / "hot-memes.jsonl"
RUNTIME = REPO / "bot-home/media/onebot/hot-memes.jsonl"

MARKER = "[dsh-p1] hot memes"

IMPORT_OLD = "import { describeError } from './errors.js';"
IMPORT_NEW = IMPORT_OLD + "\nimport { recallHotMemes } from './meme-recall.js';"

ANCHOR = (
    "        // [dsh-p1] long-term memory: recall the best-matching notes.\n"
    "        const recalled = await recallMemories(chatId, inbound.text);\n"
    "        if (recalled !== '')\n"
    "            final = '[记忆]\\n' + recalled + '\\n[/记忆]\\n' + final;\n"
)
HOOK = ANCHOR + (
    "        // " + MARKER + ": inject only the entries this message hits.\n"
    "        const memed = await recallHotMemes(inbound.text);\n"
    "        if (memed !== '')\n"
    "            final = '[梗]\\n' + memed + '\\n[/梗]\\n' + final;\n"
)


def sync_memes(force: bool) -> None:
    if not CANONICAL.exists():
        raise SystemExit(f"canonical meme file missing: {CANONICAL}")
    if RUNTIME.exists() and not force:
        print(f"runtime meme file kept: {RUNTIME}")
        return
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CANONICAL, RUNTIME)
    print(f"synced memes -> {RUNTIME}")


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("meme-recall.js up to date")
        return
    DEST.write_text(source, encoding="utf-8")
    print(f"installed {DEST}")


def apply() -> None:
    text = INBOUND.read_text(encoding="utf-8")
    if MARKER in text:
        print("inbound.js already patched")
    else:
        if ANCHOR not in text:
            raise SystemExit("inbound.js memory anchor changed — apply patch_onebot_memory.py first")
        if IMPORT_OLD not in text:
            raise SystemExit("inbound.js import anchor changed (plugin version mismatch)")
        if not BACKUP.exists():
            shutil.copy2(INBOUND, BACKUP)
        text = text.replace(IMPORT_OLD, IMPORT_NEW, 1)
        text = text.replace(ANCHOR, HOOK, 1)
        INBOUND.write_text(text, encoding="utf-8")
        print(f"patched {INBOUND} (backup: {BACKUP.name})")
    install_module()
    sync_memes(force=False)


def check() -> int:
    text = INBOUND.read_text(encoding="utf-8")
    ok = MARKER in text and "from './meme-recall.js'" in text
    ok = ok and DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BACKUP.exists():
        shutil.copy2(BACKUP, INBOUND)
        BACKUP.unlink()
        print(f"reverted {INBOUND}")
    else:
        print("no inbound.js backup; nothing reverted")
    if DEST.exists():
        DEST.unlink()
        print(f"removed {DEST}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--sync-memes", action="store_true")
    args = ap.parse_args()
    if args.check:
        sys.exit(check())
    if args.revert:
        revert()
        return
    if args.sync_memes:
        sync_memes(force=True)
        return
    apply()


if __name__ == "__main__":
    main()
