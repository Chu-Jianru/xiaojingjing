"""Long-term memory for 小鲸鲸 (阶段 C, v1).

Model: a JSONL file + a `qq_remember` tool + per-message recall.

  - the model calls `qq_remember` when the conversation contains a fact,
    preference, event, relationship or promise worth keeping
  - before every inbound message, the newest 500 memories are scored against
    the message text (character-bigram overlap + same-chat bonus + recency) and
    the best 4 are injected as a trusted `[记忆]` block, next to `[共同记忆]`
  - storage: media/onebot/memory/memories.jsonl (one JSON per line)

This is deliberately small: no embeddings, no consolidation job, no rollback.
It gives cross-session recall of things she chose to remember, which is the
visible half of 阶段 C.

  python tools/plugin/patches/patch_onebot_memory.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] long-term memory"

IMPORT_OLD = "import { defineTool } from '@deepseek-ai/dsh-tools';\n"
IMPORT_NEW = (
    "import { defineTool } from '@deepseek-ai/dsh-tools';\n"
    "import { appendFile, mkdir } from 'node:fs/promises';\n"
    "import { dirname, join } from 'node:path';\n"
)

TOOLS_ANCHOR = "    return () => {\n        for (const dispose of disposers)\n            dispose();\n    };\n"
TOOLS_HOOK = (
    "    register(defineTool({\n"
    "        name: 'qq_remember',\n"
    "        description: '把值得长期记住的事写进记忆：事实、偏好、事件、关系、约定。聊天里出现这类信息、以后可能用到时调用。',\n"
    "        parameters: {\n"
    "            text: { type: 'string', required: true, description: '一句话，第三人称，比如「老大不吃香菜」「车干是老大的同学」' },\n"
    "            kind: { type: 'string', description: 'fact / pref / event / rel / promise，可省略' },\n"
    "        },\n"
    "        output: sendOutput(),\n"
    "        isConcurrencySafe: () => true,\n"
    "        execute: async (args, exec) => {\n"
    "            const a = args;\n"
    "            const text = typeof a.text === 'string' ? a.text.trim() : '';\n"
    "            if (text === '')\n"
    "                throw new Error('qq_remember: text 不能为空');\n"
    "            const chatId = resolveChat(bridge, exec, undefined);\n"
    "            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';\n"
    "            const file = join(mediaDir, 'memory', 'memories.jsonl');\n"
    "            await mkdir(dirname(file), { recursive: true });\n"
    "            const record = { ts: Date.now(), chat: chatId, kind: typeof a.kind === 'string' ? a.kind : 'fact', text };\n"
    "            await appendFile(file, JSON.stringify(record) + '\\n', 'utf8');\n"
    "            return { ok: true, text };\n"
    "        },\n"
    "    }));\n"
    "    // -- " + MARKER + " --\n"
    + TOOLS_ANCHOR
)
# Build the final hook by inserting the tool before the existing return block.
TOOLS_REPLACEMENT = TOOLS_HOOK

INBOUND_ANCHOR = (
    "        const sharedNotes = await getSharedNotes();\n"
    "        if (sharedNotes !== '')\n"
    "            final = '[共同记忆]\\n' + sharedNotes + '\\n[/共同记忆]\\n' + final;\n"
)
INBOUND_HOOK = (
    INBOUND_ANCHOR
    + "        // [dsh-p1] long-term memory: recall the best-matching notes.\n"
    + "        const recalled = await recallMemories(chatId, inbound.text);\n"
    + "        if (recalled !== '')\n"
    + "            final = '[记忆]\\n' + recalled + '\\n[/记忆]\\n' + final;\n"
)

HELPERS = f"""
// -- {MARKER} ------------------------------------------------------------
// JSONL memory + bigram recall. Small on purpose: the model decides what to
// keep via qq_remember; every message recalls the closest few notes.
const MEMORY_PATH = 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot\\\\memory\\\\memories.jsonl';
const MEMORY_CACHE_MS = 30_000;
const MEMORY_MAX_ITEMS = 500;
const MEMORY_RECALL = 4;
const memoryCache = {{ at: 0, items: [] }};

async function loadMemories() {{
    const now = Date.now();
    if (now - memoryCache.at < MEMORY_CACHE_MS)
        return memoryCache.items;
    let items = [];
    try {{
        const raw = await readFile(MEMORY_PATH, 'utf8');
        items = raw.split(/\\r?\\n/).map(line => {{
            try {{ return JSON.parse(line); }} catch {{ return null; }}
        }}).filter(item => item !== null && typeof item.text === 'string');
    }}
    catch {{ /* no memory file yet */ }}
    memoryCache.at = now;
    memoryCache.items = items.slice(-MEMORY_MAX_ITEMS);
    return memoryCache.items;
}}

function bigramSet(text) {{
    const clean = String(text ?? '').replace(/\\s+/g, '');
    const set = new Set();
    for (let i = 0; i + 1 < clean.length; i += 1)
        set.add(clean.slice(i, i + 2));
    return set;
}}

async function recallMemories(chatId, text) {{
    const items = await loadMemories();
    if (items.length === 0)
        return '';
    const target = bigramSet(text);
    if (target.size === 0)
        return '';
    const scored = [];
    for (const item of items) {{
        const grams = bigramSet(item.text);
        let overlap = 0;
        for (const gram of grams)
            if (target.has(gram))
                overlap += 1;
        if (overlap === 0)
            continue;
        let score = overlap;
        if (item.chat === chatId)
            score += 2;
        score += Math.max(0, 3 - (Date.now() - Number(item.ts ?? 0)) / (30 * 24 * 3600 * 1000));
        scored.push({{ item, score }});
    }}
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MEMORY_RECALL).map(row => '- ' + row.item.text).join('\\n');
}}
"""


def apply_tools(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("memory tool already patched")
        return
    if text.count(IMPORT_OLD) != 1 or text.count(TOOLS_ANCHOR) != 1:
        raise SystemExit("tools.js anchors changed — plugin version mismatch")
    backup = path.with_suffix(".js.bak-memory")
    shutil.copy2(path, backup)
    text = text.replace(IMPORT_OLD, IMPORT_NEW, 1)
    text = text.replace(TOOLS_ANCHOR, TOOLS_REPLACEMENT, 1)
    path.write_text(text, encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def apply_inbound(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("memory recall already patched")
        return
    if INBOUND_ANCHOR not in text:
        raise SystemExit("inbound.js shared-notes anchor changed — apply shared_notes first")
    backup = path.with_suffix(".js.bak-memory")
    shutil.copy2(path, backup)
    text = text.replace(INBOUND_ANCHOR, INBOUND_HOOK, 1) + HELPERS
    path.write_text(text, encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    tools = LIB / "tools.js"
    inbound = LIB / "inbound.js"
    if args.check:
        ok = MARKER in tools.read_text(encoding="utf-8") and MARKER in inbound.read_text(encoding="utf-8")
        print("patched" if ok else "NOT patched")
        raise SystemExit(0 if ok else 1)
    if args.revert:
        for path in (tools, inbound):
            backup = path.with_suffix(".js.bak-memory")
            if backup.exists():
                shutil.copy2(backup, path)
                backup.unlink()
                print(f"reverted {path}")
        return
    apply_tools(tools)
    apply_inbound(inbound)


if __name__ == "__main__":
    main()
