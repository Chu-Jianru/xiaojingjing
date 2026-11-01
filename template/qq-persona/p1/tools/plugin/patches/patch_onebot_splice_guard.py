"""[dsh-p1] 出站拼接泄漏护栏（v2.03）: lib/splice-guard.js + outbound 接线.

见 tools/plugin/modules/onebot_splice_guard.js 头注释（README 4.35）。

  python tools/plugin/patches/patch_onebot_splice_guard.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_splice_guard.py --check
  python tools/plugin/patches/patch_onebot_splice_guard.py --revert
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_splice_guard.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "splice-guard.js"
OUTBOUND = LIB / "outbound.js"
BAK = OUTBOUND.with_suffix(".js.bak-spliceguard")

IMPORT_ANCHOR = "import { splitBubbles } from './outbound.js';"  # not present; use bubble consts
# real anchor: the bubble block sits at module level with these constants
CONST_ANCHOR = "const BUBBLE_MAX = 4;\nconst BUBBLE_DELAY_MIN_MS = 800;\nconst BUBBLE_DELAY_MAX_MS = 1500;\n"
IMPORT_NEW = "import { stripSpliceLeaks } from './splice-guard.js';\n" + CONST_ANCHOR

USE_ANCHOR = """            const ids = [];
            const { body, nodes } = extractForwardBlocks(text, '助手');
"""
USE_NEW = """            const ids = [];
            const { body, nodes } = extractForwardBlocks(text, '助手');
            // [dsh-p1] splice-leak guard (4.35): drop inbound lines that the
            // followup-splice merged into this reply before they reach anyone.
            const guard = stripSpliceLeaks(body);
            if (guard.removed > 0) {
                this.ctx.log('warn', 'splice-leak guard removed ' + guard.removed + ' line(s) in ' + chatId);
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '剥离拼接泄漏行: ' + guard.removed });
            }
            body = guard.text;
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def replace_once(text: str, old: str, new: str, what: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{what}: anchor found {n} times (expected 1); aborting")
    return text.replace(old, new, 1)


def apply() -> None:
    shutil.copyfile(SRC, DEST)
    text = read(OUTBOUND)
    if "splice-guard" in text:
        print("outbound.js: already patched")
        return
    shutil.copyfile(OUTBOUND, BAK)
    text = replace_once(text, CONST_ANCHOR, IMPORT_NEW, "import")
    text = replace_once(text, USE_ANCHOR, USE_NEW, "guard call")
    # reassigning body needs let, not const (do this AFTER the anchor match)
    text = text.replace(
        "const { body, nodes } = extractForwardBlocks(text, '助手');",
        "let { body, nodes } = extractForwardBlocks(text, '助手');",
    )
    OUTBOUND.write_text(text, encoding="utf-8", newline="\n")
    print("outbound.js: splice-leak guard wired (backup .bak-spliceguard)")
    print('done — truly restart DSH now (scripts\\stop-companion.cmd + schtasks /run /tn "DSH-companion-p1")')


def check() -> int:
    ok = DEST.exists()
    print("splice-guard.js:", "ok" if ok else "MISSING")
    text = read(OUTBOUND)
    for needle in ("stripSpliceLeaks } from './splice-guard.js'", "splice-leak guard removed", "let { body, nodes }"):
        hit = needle in text
        print(f"outbound.js {needle[:44]}: {'ok' if hit else 'MISSING'}")
        ok = ok and hit
    return 0 if ok else 1


def revert() -> None:
    if BAK.exists():
        shutil.copyfile(BAK, OUTBOUND)
        print(f"restored outbound.js from {BAK.name}")
    else:
        print(f"{BAK.name}: no backup")
    if DEST.exists():
        DEST.unlink()
        print("removed splice-guard.js")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--revert", action="store_true")
    args = parser.parse_args()
    if args.check:
        sys.exit(check())
    if args.revert:
        revert()
        return
    apply()


if __name__ == "__main__":
    main()
