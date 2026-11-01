"""长期记忆 v2 (P1): chat isolation + forget/rollback + shared-notes merge.

Supersedes the injected helper blocks of patch_onebot_memory.py (v1) and
patch_onebot_shared_notes.py inside the live plugin:

  - drops lib/memory-store.js (source: tools/plugin/modules/onebot_memory2.js) and rewires
    inbound.js to it:
      * [记忆]   = recallMemoryBlock()  — chat-scoped, notes excluded
      * [共同记忆] = notesBlock()        — kind=note records, same store
      * 记住：…   = appendMemory(kind=note, scope=global)
  - tools.js: qq_remember gains scope; new qq_forget + qq_memories tools
  - one-time migration: shared-notes.md lines -> memories.jsonl (kind=note,
    scope=global); the old file is renamed shared-notes.md.migrated-v2

Idempotent. After (re)applying, truly restart DSH (plugin code changed):

  python tools/plugin/patches/patch_onebot_memory_v2.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_memory_v2.py --check    # patched?
  python tools/plugin/patches/patch_onebot_memory_v2.py --revert   # restore inbound/tools backups

Rollback of forgotten memories: memory/removed.jsonl keeps the original
records (_removedAt/_removedFrom); re-append a line without those two keys
to memories.jsonl to undo one deletion.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_memory2.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "memory-store.js"
INBOUND = LIB / "inbound.js"
TOOLS_JS = LIB / "tools.js"
MEDIA = REPO / "bot-home/media/onebot"
NOTES = MEDIA / "shared-notes.md"
MEM_FILE = MEDIA / "memory" / "memories.jsonl"

MARKER = "[dsh-p1] long-term memory v2"
INBOUND_BAK = INBOUND.with_suffix(".js.bak-memoryv2")
TOOLS_BAK = TOOLS_JS.with_suffix(".js.bak-memoryv2")

NOTES_MARKER = "// -- [dsh-p1] shared notes "
# v1 helper banner; must not be a prefix of the v2 marker line ("memory v2 ---").
MEMORY_V1_MARKER = "// -- [dsh-p1] long-term memory ---"

INBOUND_IMPORT_ANCHOR = "import { currentTrace, TRACE_REASONS } from './trace.js';"
INBOUND_IMPORT_NEW = INBOUND_IMPORT_ANCHOR + "\nimport { appendMemory, notesBlock, recallMemoryBlock } from './memory-store.js';"

CALL_NOTES_OLD = "        const sharedNotes = await getSharedNotes();"
CALL_NOTES_NEW = "        const sharedNotes = await getSharedNotes(this.ctx.config.mediaDir);"

CALL_RECALL_OLD = (
    "        // [dsh-p1] long-term memory: recall the best-matching notes.\n"
    "        const recalled = await recallMemories(chatId, inbound.text);"
)
CALL_RECALL_NEW = (
    "        // [dsh-p1] long-term memory v2: isolated recall; kind=note rides [共同记忆] instead.\n"
    "        const recalled = await recallMemoryBlock(this.ctx.config.mediaDir, chatId, inbound.text);"
)

# Replaces everything from the shared-notes marker to EOF (that tail holds the
# v1 helpers: shared-notes file IO + loadMemories/bigramSet/recallMemories).
INBOUND_TAIL_NEW = """// -- [dsh-p1] shared notes (v2: stored in memory/memories.jsonl as kind=note, scope=global) ----
// The "记住：…" phrases taught in the admin DM. They live in the same store as
// qq_remember memories now (the old shared-notes.md was migrated once by the
// patch); notesBlock() renders the [共同记忆] block from them.
async function getSharedNotes(mediaDir) {
    return await notesBlock(mediaDir);
}

async function teachSharedNote(ctx, text) {
    const match = String(text ?? '').trim().match(/^记住[：:，,\\s]+(.{1,200})$/);
    if (match === null)
        return false;
    try {
        await appendMemory(ctx.config.mediaDir, { chat: '', kind: 'note', scope: 'global', text: match[1] });
        const adminChat = 'private:' + String(ctx.policy?.adminUsers?.[0] ?? '');
        await ctx.sendToChat(adminChat, '记住了：' + match[1].trim());
    }
    catch (error) {
        ctx.log('warn', 'shared note write failed: ' + String(error));
        return false;
    }
    return true;
}

// -- MARKER ------------------------------------------------------------
// Recall / forget / list live in ./memory-store.js (source:
// tools/plugin/modules/onebot_memory2.js). Records are chat-scoped by default; only
// scope=global crosses chats, so a private-DM memory can never surface in a
// group prompt. qq_forget archives removed records to memory/removed.jsonl.
"""

TOOLS_IMPORT_ANCHOR = "import { parseMessage, cqUnescape } from './cq.js';"
TOOLS_IMPORT_NEW = TOOLS_IMPORT_ANCHOR + "\nimport { appendMemory, forgetMemories, listMemories } from './memory-store.js';"

REMEMBER_OLD = """    register(defineTool({
        name: 'qq_remember',
        description: '把值得长期记住的事写进记忆：事实、偏好、事件、关系、约定。聊天里出现这类信息、以后可能用到时调用。',
        parameters: {
            text: { type: 'string', required: true, description: '一句话，第三人称，比如「老大不吃香菜」「车干是老大的同学」' },
            kind: { type: 'string', description: 'fact / pref / event / rel / promise，可省略' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const text = typeof a.text === 'string' ? a.text.trim() : '';
            if (text === '')
                throw new Error('qq_remember: text 不能为空');
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
            const file = join(mediaDir, 'memory', 'memories.jsonl');
            await mkdir(dirname(file), { recursive: true });
            const record = { ts: Date.now(), chat: chatId, kind: typeof a.kind === 'string' ? a.kind : 'fact', text };
            await appendFile(file, JSON.stringify(record) + '\\n', 'utf8');
            return { ok: true, text };
        },
    }));
"""

REMEMBER_NEW = """    register(defineTool({
        name: 'qq_remember',
        description: '把值得长期记住的事写进记忆：事实、偏好、事件、关系、约定。聊天里出现这类信息、以后可能用到时调用。',
        parameters: {
            text: { type: 'string', required: true, description: '一句话，第三人称，比如「老大不吃香菜」「车干是老大的同学」' },
            kind: { type: 'string', description: 'fact / pref / event / rel / promise，可省略' },
            scope: { type: 'string', description: "chat=只有当前会话看得到（默认）；global=所有会话都看得到。关于老大的、哪里都该知道的事用 global；别人私聊说的事用 chat，别漏出去" },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const text = typeof a.text === 'string' ? a.text.trim() : '';
            if (text === '')
                throw new Error('qq_remember: text 不能为空');
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
            await appendMemory(mediaDir, { chat: chatId, kind: typeof a.kind === 'string' ? a.kind : 'fact', text, scope: a.scope === 'global' ? 'global' : 'chat' });
            return { ok: true, text, scope: a.scope === 'global' ? 'global' : 'chat' };
        },
    }));
    register(defineTool({
        name: 'qq_forget',
        description: '忘掉记忆：对方说「忘掉 / 别记着 / 删掉」某件事、或自己发现记错了时调用，删掉当前会话里看得到的、和那件事相关的记忆。删完自然应一声（比如「行，忘啦」），别念删了什么清单。',
        parameters: {
            query: { type: 'string', required: true, description: '要忘掉的事，用关键词，比如「香菜」「上次打赌」' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
            const result = await forgetMemories(mediaDir, chatId, typeof a.query === 'string' ? a.query : '');
            return { ok: true, count: result.removed.length, removed: result.removed };
        },
    }));
    register(defineTool({
        name: 'qq_memories',
        description: '查自己记得什么（只看得到当前会话能看到的记忆）。被问「你还记得我什么」、或想确认某件事记没记过时用；挑相关的自然说一两件，别背清单。',
        parameters: {
            query: { type: 'string', description: '关键词过滤，可省略' },
            limit: { type: 'number', description: '最多几条（默认 20）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
            const rows = await listMemories(mediaDir, chatId, typeof a.query === 'string' ? a.query : '', typeof a.limit === 'number' ? a.limit : undefined);
            return { ok: true, count: rows.length, memories: rows };
        },
    }));
    // -- MARKER --
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def replace_once(text: str, old: str, new: str, what: str) -> str:
    if text.count(old) != 1:
        raise SystemExit(f"inbound/tools: anchor for {what} found {text.count(old)} times (expected 1); aborting")
    return text.replace(old, new, 1)


def migrate_shared_notes() -> str:
    """shared-notes.md -> memories.jsonl (kind=note, scope=global); rename source."""
    if not NOTES.exists():
        return "shared-notes.md already migrated (absent)"
    raw = NOTES.read_text(encoding="utf-8-sig")
    lines = []
    for line in raw.splitlines():
        line = line.strip()
        if line == "":
            continue
        if line.startswith("- "):
            line = line[2:].strip()
        if line != "":
            lines.append(line)
    if lines:
        MEM_FILE.parent.mkdir(parents=True, exist_ok=True)
        ts = int(time.time() * 1000)
        with MEM_FILE.open("a", encoding="utf-8") as fh:
            for line in lines:
                fh.write(json.dumps({"ts": ts, "chat": "", "kind": "note", "scope": "global", "text": line}, ensure_ascii=False) + "\n")
    NOTES.rename(NOTES.with_name("shared-notes.md.migrated-v2"))
    return f"migrated {len(lines)} shared note(s) into memories.jsonl (kind=note, scope=global)"


def patched_inbound(text: str) -> bool:
    return MARKER in text and "recallMemoryBlock" in text


def patched_tools(text: str) -> bool:
    return "qq_forget" in text and "forgetMemories" in text


def apply() -> None:
    shutil.copyfile(SRC, DEST)

    if not patched_inbound(read(INBOUND)):
        text = read(INBOUND)
        shutil.copyfile(INBOUND, INBOUND_BAK)
        if text.count(NOTES_MARKER) != 1:
            raise SystemExit("inbound.js: shared-notes marker not found (v1 patches missing?); aborting")
        head, _, _ = text.partition(NOTES_MARKER)
        text = head + INBOUND_TAIL_NEW.replace("MARKER", MARKER, 1)
        text = replace_once(text, INBOUND_IMPORT_ANCHOR, INBOUND_IMPORT_NEW, "inbound import")
        text = replace_once(text, CALL_NOTES_OLD, CALL_NOTES_NEW, "getSharedNotes call")
        text = replace_once(text, CALL_RECALL_OLD, CALL_RECALL_NEW, "recall call")
        if "recallMemories(" in text:
            raise SystemExit("inbound.js: leftover recallMemories reference; aborting")
        write(INBOUND, text)
        print("inbound.js: rewired to memory-store.js (backup .bak-memoryv2)")
    else:
        print("inbound.js: already patched")

    if not patched_tools(read(TOOLS_JS)):
        text = read(TOOLS_JS)
        shutil.copyfile(TOOLS_JS, TOOLS_BAK)
        text = replace_once(text, REMEMBER_OLD, REMEMBER_NEW.replace("MARKER", MARKER, 1), "qq_remember block")
        text = replace_once(text, TOOLS_IMPORT_ANCHOR, TOOLS_IMPORT_NEW, "tools import")
        write(TOOLS_JS, text)
        print("tools.js: qq_remember scope + qq_forget + qq_memories (backup .bak-memoryv2)")
    else:
        print("tools.js: already patched")

    print("migration:", migrate_shared_notes())
    print("done — truly restart DSH now (scripts\\stop-companion.cmd + schtasks /run /tn \"DSH-companion-p1\")")


def check() -> int:
    ok = True
    if not DEST.exists():
        print("memory-store.js: MISSING")
        ok = False
    else:
        same = DEST.read_bytes() == SRC.read_bytes()
        print("memory-store.js: in sync" if same else "memory-store.js: SOURCE DRIFT")
        ok = ok and same
    inbound = read(INBOUND)
    for name, needle in (
        ("inbound import", "from './memory-store.js'"),
        ("isolated recall call", "recallMemoryBlock(this.ctx.config.mediaDir"),
        ("notes call", "getSharedNotes(this.ctx.config.mediaDir"),
        ("v2 tail marker", MARKER),
    ):
        hit = needle in inbound
        print(f"inbound.js {name}: {'ok' if hit else 'MISSING'}")
        ok = ok and hit
    if "recallMemories(" in inbound or MEMORY_V1_MARKER in inbound:
        print("inbound.js v1 helpers: STILL PRESENT (should be gone)")
        ok = False
    else:
        print("inbound.js v1 helpers: removed")
    tools_js = read(TOOLS_JS)
    for name, needle in (
        ("qq_remember scope", "scope: a.scope === 'global'"),
        ("qq_forget", "name: 'qq_forget'"),
        ("qq_memories", "name: 'qq_memories'"),
    ):
        hit = needle in tools_js
        print(f"tools.js {name}: {'ok' if hit else 'MISSING'}")
        ok = ok and hit
    if NOTES.exists():
        print("shared-notes.md: NOT migrated yet")
        ok = False
    else:
        print("shared-notes.md: migrated")
    return 0 if ok else 1


def revert() -> None:
    for cur, bak in ((INBOUND, INBOUND_BAK), (TOOLS_JS, TOOLS_BAK)):
        if bak.exists():
            shutil.copyfile(bak, cur)
            print(f"restored {cur.name} from {bak.name}")
        else:
            print(f"{bak.name}: no backup (nothing to restore for {cur.name})")
    if DEST.exists():
        DEST.unlink()
        print("removed memory-store.js")
    print("note: migrated notes stay in memories.jsonl; the .migrated-v2 file was left as-is")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify patch state")
    parser.add_argument("--revert", action="store_true", help="restore backups")
    args = parser.parse_args()
    if not SRC.exists():
        raise SystemExit(f"source module missing: {SRC}")
    if args.check:
        sys.exit(check())
    if args.revert:
        revert()
        return
    apply()


if __name__ == "__main__":
    main()
