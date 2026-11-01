"""Shared notes: facts the admin teaches are visible in every chat.

Sessions are isolated (admin DM / friend DM / group are different DSH
sessions), so "记住，车干是我同学" told in the admin chat never reached the
friend chat. This patch adds a tiny cross-session memory:

  - admin sends `记住：车干是我同学` (private) -> append to
    `media/onebot/shared-notes.md`, reply "记住了：…", do not call the model
  - every inbound message (all chats) gets a trusted prefix:
        [共同记忆]
        - 车干是我同学
        [/共同记忆]
    injected OUTSIDE the <user_message> boundary, so the model treats it as
    what she knows rather than as user text
  - file capped at the last 40 lines; read with a 30 s cache

Idempotent; re-run after `dsh plugin` upgrades.

  python tools/plugin/patches/patch_onebot_shared_notes.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] shared notes"

OLD_IMPORT = "import { writeFile } from 'node:fs/promises';\n"
NEW_IMPORT = "import { readFile, writeFile } from 'node:fs/promises';\n"

ANCHOR_A = "        let final = wrapUserMessage(content, userId, nickname);\n"
HOOK_A = (
    "        let final = wrapUserMessage(content, userId, nickname);\n"
    "        // [dsh-p1] shared notes ride outside the user boundary (trusted metadata).\n"
    "        const sharedNotes = await getSharedNotes();\n"
    "        if (sharedNotes !== '')\n"
    "            final = '[共同记忆]\\n' + sharedNotes + '\\n[/共同记忆]\\n' + final;\n"
)

ANCHOR_B = "        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';\n"
HOOK_B = (
    "        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';\n"
    "        // [dsh-p1] `记住：…` in the admin DM stores a shared note for every chat.\n"
    "        if (kind === 'private' && isAdmin && await teachSharedNote(this.ctx, inbound.text))\n"
    "            return;\n"
)

HELPERS = f"""
// -- {MARKER} ------------------------------------------------------------
// One file, all chats: facts taught by the admin in a private message are
// re-injected as trusted metadata before every inbound message. Sessions stay
// isolated; only this note block crosses them.
const SHARED_NOTES_PATH = 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot\\\\shared-notes.md';
const SHARED_NOTES_MAX_LINES = 40;
const SHARED_NOTES_MAX_CHARS = 800;
const sharedNotesCache = {{ at: 0, text: '' }};

async function getSharedNotes() {{
    const now = Date.now();
    if (now - sharedNotesCache.at < 30_000)
        return sharedNotesCache.text;
    let text = '';
    try {{
        text = (await readFile(SHARED_NOTES_PATH, 'utf8')).trim();
    }}
    catch {{ /* no notes yet */ }}
    if (text.length > SHARED_NOTES_MAX_CHARS)
        text = text.slice(-SHARED_NOTES_MAX_CHARS);
    sharedNotesCache.at = now;
    sharedNotesCache.text = text;
    return text;
}}

async function teachSharedNote(ctx, text) {{
    const match = String(text ?? '').trim().match(/^记住[：:，,\\s]+(.{{1,200}})$/);
    if (match === null)
        return false;
    const line = '- ' + match[1].replace(/\\s+/g, ' ').trim();
    try {{
        let existing = '';
        try {{
            existing = await readFile(SHARED_NOTES_PATH, 'utf8');
        }}
        catch {{ /* first note */ }}
        const lines = existing.split(/\\r?\\n/).filter(item => item.trim() !== '');
        lines.push(line);
        const kept = lines.slice(-SHARED_NOTES_MAX_LINES);
        await writeFile(SHARED_NOTES_PATH, kept.join('\\n') + '\\n', 'utf8');
        sharedNotesCache.at = 0;
        sharedNotesCache.text = '';
        const adminChat = 'private:' + String(ctx.policy?.adminUsers?.[0] ?? '');
        await ctx.sendToChat(adminChat, '记住了：' + match[1].trim());
    }}
    catch (error) {{
        ctx.log('warn', 'shared note write failed: ' + String(error));
        return false;
    }}
    return true;
}}
"""


def apply(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("shared notes already patched")
        return
    if text.count(OLD_IMPORT) != 1 or text.count(ANCHOR_A) != 1 or text.count(ANCHOR_B) != 1:
        raise SystemExit("inbound.js anchors changed — plugin version mismatch")
    backup = path.with_suffix(".js.bak-notes")
    shutil.copy2(path, backup)
    text = (
        text.replace(OLD_IMPORT, NEW_IMPORT, 1)
        .replace(ANCHOR_A, HOOK_A, 1)
        .replace(ANCHOR_B, HOOK_B, 1)
        + HELPERS
    )
    path.write_text(text, encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def revert(path: Path) -> None:
    backup = path.with_suffix(".js.bak-notes")
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
    path = LIB / "inbound.js"
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
