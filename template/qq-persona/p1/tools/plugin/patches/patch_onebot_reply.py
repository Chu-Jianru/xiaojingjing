"""QQ 引用回复 (reply-to) for 小鲸鲸, inbound and outbound.

Inbound:
  - every message gets a trusted `[本条ID:<message_id>]` line
  - a QQ quote is expanded with the quoted id: `[引用 id=123]昵称: 内容`
    (she can therefore tell exactly which message someone replied to)

Outbound:
  - a reply whose first line starts with `[[reply:<message_id>]]` turns into a
    real QQ reply: the marker is stripped and the first bubble carries the
    `reply` segment (the bubble-split patch already limits replyTo to bubble 1)

Idempotent; re-run after `dsh plugin` upgrades, then restart DSH:

  python tools/plugin/patches/patch_onebot_reply.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] QQ reply"

OUT_OLD = """    sendToChat(chatId, text, options = {}) {
        return this.enqueue(chatId, async () => {"""

OUT_NEW = """    sendToChat(chatId, text, options = {}) {
        // [dsh-p1] QQ 回复: a leading [[reply:<message_id>]] turns the first
        // bubble into a real QQ reply and is stripped from the text.
        const replyMarker = /^\\s*\\[\\[reply:(\\d{5,})\\]\\]\\s*/.exec(String(text ?? ''));
        if (replyMarker !== null) {
            text = String(text).slice(replyMarker[0].length);
            options = { ...options, replyTo: replyMarker[1] };
        }
        return this.enqueue(chatId, async () => {"""

IN_ID_OLD = """        if (memed !== '')
            final = '[梗]\\n' + memed + '\\n[/梗]\\n' + final;
        if (kind === 'group') {"""

IN_ID_NEW = """        if (memed !== '')
            final = '[梗]\\n' + memed + '\\n[/梗]\\n' + final;
        // [dsh-p1] reply support: expose this message's id for [[reply:<id>]].
        if (inbound.messageId !== undefined && inbound.messageId !== '')
            final = '[本条ID:' + inbound.messageId + ']\\n' + final;
        if (kind === 'group') {"""

QUOTE_OLD = """            const name = data.sender?.nickname ?? '';
            return '[引用]' + (name !== '' ? name + ': ' : '') + text;"""

QUOTE_NEW = """            const name = data.sender?.nickname ?? '';
            const quotedId = data.message_id === undefined || data.message_id === null ? '' : String(data.message_id);
            return '[引用' + (quotedId === '' ? '' : ' id=' + quotedId) + ']' + (name !== '' ? name + ': ' : '') + text;"""


def patch_file(path: Path, old: str, new: str, backup_suffix: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        print(f"{path.name} already patched")
        return
    if old not in text:
        raise SystemExit(f"{path.name}: anchor changed — plugin version mismatch")
    backup = path.with_suffix(f".js{backup_suffix}")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def apply() -> None:
    patch_file(LIB / "outbound.js", OUT_OLD, OUT_NEW, ".bak-reply")
    patch_file(LIB / "inbound.js", IN_ID_OLD, IN_ID_NEW, ".bak-reply")
    patch_file(LIB / "inbound.js", QUOTE_OLD, QUOTE_NEW, ".bak-reply")


def check() -> int:
    out = (LIB / "outbound.js").read_text(encoding="utf-8")
    inbound = (LIB / "inbound.js").read_text(encoding="utf-8")
    ok = "[[reply:" in out and "本条ID:" in inbound and "'[引用' + (quotedId" in inbound
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    for name in ("outbound.js", "inbound.js"):
        path = LIB / name
        backup = path.with_suffix(".js.bak-reply")
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
