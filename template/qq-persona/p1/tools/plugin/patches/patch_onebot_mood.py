"""情绪状态 (mood / energy / affection) for 小鲸鲸.

  - module lib/mood.js (source tools/plugin/modules/onebot_mood.js) → <mediaDir>/mood.json
  - `qq_mood` tool: nudge mood/energy/affection after emotional events
  - inbound.js injects a compact `[状态]` block each turn

Idempotent; re-run after `dsh plugin` upgrades, then restart DSH:

  python tools/plugin/patches/patch_onebot_mood.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_mood.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "mood.js"
TOOLS_JS = LIB / "tools.js"
INBOUND = LIB / "inbound.js"

TOOLS_IMPORT_OLD = "import { defineTool } from '@deepseek-ai/dsh-tools';"
TOOLS_IMPORT_NEW = TOOLS_IMPORT_OLD + "\nimport { adjustMood, loadMood } from './mood.js';"

TOOLS_ANCHOR = "    // -- [dsh-p1] long-term memory --\n    return () => {"

TOOLS_HOOK = """    register(defineTool({
        name: 'qq_mood',
        description: '微调你自己的心情/精力/对某人的好感（0-100，50 平）。被夸、被骂、聊到深夜、被冷落之后可以调一次（±5 左右），不用每轮调；action=read 看当前状态。',
        parameters: {
            action: { type: 'string', description: 'adjust（默认）/ read' },
            mood: { type: 'number', description: '心情变化，比如 -5' },
            energy: { type: 'number', description: '精力变化，比如 -3' },
            affection: { type: 'number', description: '对这人的好感变化，比如 +3' },
            user_id: { type: 'string', description: '群里要指定对方 QQ' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 1) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
            const chatId = resolveChat(bridge, exec, undefined);
            const parts = splitChatId(chatId);
            if (a.action === 'read')
                return await loadMood(mediaDir);
            const target = typeof a.user_id === 'string' && a.user_id !== ''
                ? a.user_id
                : (parts.kind === 'private' ? parts.target : '');
            return await adjustMood(mediaDir, {
                mood: Number(a.mood || 0),
                energy: Number(a.energy || 0),
                affection: Number(a.affection || 0),
                userId: target,
            });
        },
    }));
    // -- [dsh-p1] long-term memory --
    return () => {"""

INBOUND_IMPORT_OLD = "import { describeError } from './errors.js';"
INBOUND_IMPORT_NEW = INBOUND_IMPORT_OLD + "\nimport { noteMessage, renderMood } from './mood.js';"

INBOUND_ANCHOR = """        const profileBlock = await renderProfileBlock(this.ctx.config.mediaDir, userId, nickname);
        if (profileBlock !== '')
            final = profileBlock + '\\n' + final;"""

INBOUND_HOOK = INBOUND_ANCHOR + """
        // [dsh-p1] mood: a continuous state, not a per-turn act. Update it from
        // the message itself (insults/praise/everyday chat), then inject it.
        await noteMessage(this.ctx.config.mediaDir, inbound.text, userId, { chatId });
        const moodBlock = await renderMood(this.ctx.config.mediaDir, userId, { chatId });
        if (moodBlock !== '')
            final = moodBlock + '\\n' + final;"""


def patch_file(path: Path, old: str, new: str, suffix: str, marker: str | None = None) -> None:
    text = path.read_text(encoding="utf-8")
    # v2.04 guard: judge by the inserted CORE marker, not the full block — the
    # file evolves under later patches, so a stale `new` string no longer
    # matches and the patch used to insert a duplicate block.
    if new in text or (marker is not None and marker in text):
        print(f"{path.name} already patched")
        return
    if old not in text:
        raise SystemExit(f"{path.name}: anchor changed — plugin version mismatch")
    backup = path.with_suffix(f".js{suffix}")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("mood.js up to date")
        return
    DEST.write_text(source, encoding="utf-8")
    print(f"installed {DEST}")


def apply() -> None:
    patch_file(TOOLS_JS, TOOLS_IMPORT_OLD, TOOLS_IMPORT_NEW, ".bak-mood", marker="import { adjustMood, loadMood } from './mood.js';")
    patch_file(TOOLS_JS, TOOLS_ANCHOR, TOOLS_HOOK, ".bak-mood", marker="name: 'qq_mood'")
    patch_file(INBOUND, INBOUND_IMPORT_OLD, INBOUND_IMPORT_NEW, ".bak-mood")
    patch_file(INBOUND, INBOUND_ANCHOR, INBOUND_HOOK, ".bak-mood", marker="const moodBlock = await renderMood")
    install_module()
    text = INBOUND.read_text(encoding="utf-8")
    text = text.replace("noteMessage(this.ctx.config.mediaDir, inbound.text, userId);", "noteMessage(this.ctx.config.mediaDir, inbound.text, userId, { chatId });")
    text = text.replace("renderMood(this.ctx.config.mediaDir, userId);", "renderMood(this.ctx.config.mediaDir, userId, { chatId });")
    if text != INBOUND.read_text(encoding="utf-8"):
        INBOUND.write_text(text, encoding="utf-8")


def check() -> int:
    ok = TOOLS_JS.read_text(encoding="utf-8").count("name: 'qq_mood'") == 1
    text = INBOUND.read_text(encoding="utf-8")
    ok = ok and "noteMessage(this.ctx.config.mediaDir, inbound.text, userId, { chatId });" in text
    ok = ok and "renderMood(this.ctx.config.mediaDir, userId, { chatId });" in text
    ok = ok and DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    for path in (TOOLS_JS, INBOUND):
        backup = path.with_suffix(".js.bak-mood")
        if backup.exists():
            shutil.copy2(backup, path)
            backup.unlink()
            print(f"reverted {path}")
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
