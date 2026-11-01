"""Patch dsh-onebot-qq so a multi-line reply becomes multiple QQ bubbles.

The plugin sends the whole reply as one `send_msg`. 小鲸鲸's style rules ask for
1–3 short lines when she is emotional, so outbound must send each line as its
own bubble 0.8–1.5 s apart (A3). The edit is intentionally tiny and idempotent:

  python tools/plugin/patches/patch_onebot_bubbles.py            # apply (backs up .bak-bubbles)
  python tools/plugin/patches/patch_onebot_bubbles.py --check    # exit 0 when already applied
  python tools/plugin/patches/patch_onebot_bubbles.py --revert   # restore the backup

Re-run after every `dsh plugin` upgrade of dsh-onebot-qq, then restart DSH.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

DEFAULT_DIR = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] A3 bubble split"

OLD = """            if (!sentCard) {
                const plain = stripMarkdown(body);
                if (plain !== '') {
                    const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: plain } }], options);
                    if (id !== undefined)
                        ids.push(id);
                }
"""

NEW = """            if (!sentCard) {
                const plain = stripMarkdown(body);
                if (plain !== '') {
                    // [dsh-p1] A3 bubble split: one line = one bubble, 0.8-1.5s apart.
                    const bubbles = splitBubbles(plain);
                    for (let bi = 0; bi < bubbles.length; bi++) {
                        if (bi > 0)
                            await bubbleSleep(randomDelayMs(BUBBLE_DELAY_MIN_MS, BUBBLE_DELAY_MAX_MS));
                        const bubbleOptions = bi === 0 ? options : { ...options, replyTo: undefined };
                        const bubbleId = await this.sendMsg(chatId, [{ type: 'text', data: { text: bubbles[bi] } }], bubbleOptions);
                        if (bubbleId !== undefined)
                            ids.push(bubbleId);
                    }
                }
"""

HELPERS = f"""
// -- {MARKER} -----------------------------------------------------------
// A reply line = one QQ bubble. The persona asks the model to split emotional
// replies into 2-3 lines; here each line is sent separately, 0.8-1.5s apart.
// Blank lines are dropped, at most {4} bubbles are sent (the rest merge into the
// last one), and replyTo only rides on the first bubble.
const BUBBLE_MAX = 4;
const BUBBLE_DELAY_MIN_MS = 800;
const BUBBLE_DELAY_MAX_MS = 1500;

export function splitBubbles(text) {{
    const raw = String(text).trim();
    // [dsh-p1] the persona may choose not to answer at all; send nothing.
    if (raw === '[不回]' || raw === '（不回）' || raw === '【不回】')
        return [];
    const lines = String(text).split(/\\r?\\n/).map(line => line.trim()).filter(line => line !== '');
    if (lines.length === 0)
        return [];
    if (lines.length === 1)
        return [lines[0]];
    const bubbles = lines.slice(0, BUBBLE_MAX);
    if (lines.length > BUBBLE_MAX)
        bubbles[BUBBLE_MAX - 1] += '\\n' + lines.slice(BUBBLE_MAX).join('\\n');
    return bubbles;
}}

function randomDelayMs(min, max) {{
    return min + Math.floor(Math.random() * (max - min + 1));
}}

function bubbleSleep(ms) {{
    return new Promise(resolve => setTimeout(resolve, ms));
}}
"""


def target(dirpath: Path) -> Path:
    return dirpath / "outbound.js"


def check(dirpath: Path) -> bool:
    path = target(dirpath)
    if not path.exists():
        raise SystemExit(f"not found: {path}")
    return MARKER in path.read_text(encoding="utf-8")


def apply(dirpath: Path) -> None:
    path = target(dirpath)
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("already patched")
        return
    if OLD not in text:
        raise SystemExit(
            "anchor block not found — the plugin version changed; update OLD in this script"
        )
    backup = path.with_suffix(".js.bak-bubbles")
    shutil.copy2(path, backup)
    path.write_text(text.replace(OLD, NEW, 1) + HELPERS, encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def revert(dirpath: Path) -> None:
    path = target(dirpath)
    backup = path.with_suffix(".js.bak-bubbles")
    if not backup.exists():
        raise SystemExit("no backup to restore")
    shutil.copy2(backup, path)
    backup.unlink()
    print("reverted")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plugin-dir", type=Path, default=DEFAULT_DIR)
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true")
    group.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    if args.check:
        print("patched" if check(args.plugin_dir) else "NOT patched")
        raise SystemExit(0 if check(args.plugin_dir) else 1)
    if args.revert:
        revert(args.plugin_dir)
        return
    apply(args.plugin_dir)


if __name__ == "__main__":
    main()
