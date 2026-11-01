"""[dsh-p1] token 用量看板（P5，v2.01）: lib/usage.js + qq_cost 工具.

数据源：DSH 会话日志（多帧 zstd）里每条 assistant/message 的 data.usage。
用途：① qq_cost 工具——老大问「今天花了多少 token」她能如实答（core.md §16）；
② tools/ops/usage_report.mjs 每天 04:50 落一份人读报告（另一个任务）。

  python tools/plugin/patches/patch_onebot_usage.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_usage.py --check
  python tools/plugin/patches/patch_onebot_usage.py --revert
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_usage.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "usage.js"
TOOLS_JS = LIB / "tools.js"
BAK = TOOLS_JS.with_suffix(".js.bak-usage")

MARKER = "[dsh-p1] usage"

IMPORT_ANCHOR = "import { appendMemory, forgetMemories, listMemories } from './memory-store.js';"
IMPORT_NEW = IMPORT_ANCHOR + "\nimport { usageByDays } from './usage.js';"

TOOL_ANCHOR = "    // -- [dsh-p1] long-term memory v2 --"
TOOL_HOOK = """    register(defineTool({
        name: 'qq_cost',
        description: '查你自己的 token 用量（这几天的花费）。老大问「今天花了多少 / 烧了多少 token / 成本」时用它查了如实回答：报总 token、输入/输出/缓存命中各多少、哪几个会话聊得最多；可以顺着说一句「今天聊得确实多」或「缓存命中高其实没那么贵」，别编具体金额。',
        parameters: {
            days: { type: 'number', description: '查最近几天（1–7，默认 1 = 今天）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const raw = Number(args?.days ?? 1);
            const days = Number.isFinite(raw) ? Math.min(7, Math.max(1, Math.trunc(raw))) : 1;
            const byDays = await usageByDays(days);
            const days2 = Object.entries(byDays).map(([day, r]) => {
                const top = Object.entries(r.chats)
                    .sort((a, b) => b[1].turns - a[1].turns)
                    .slice(0, 3)
                    .map(([chatId, c]) => ({ chat_id: chatId, turns: c.turns, total_tokens: c.totalTokens }));
                return {
                    date: day,
                    turns: r.total.turns,
                    input_tokens: r.total.inputTokens,
                    output_tokens: r.total.outputTokens,
                    cache_read_tokens: r.total.cacheReadTokens,
                    total_tokens: r.total.totalTokens,
                    top_chats: top,
                };
            });
            return { ok: true, days: days2 };
        },
    }));
    // -- MARKER --
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
    text = read(TOOLS_JS)
    if "qq_cost" in text:
        print("tools.js: already patched")
        return
    shutil.copyfile(TOOLS_JS, BAK)
    text = replace_once(text, IMPORT_ANCHOR, IMPORT_NEW, "usage import")
    text = replace_once(text, TOOL_ANCHOR, TOOL_HOOK.replace("MARKER", MARKER, 1), "qq_cost tool")
    TOOLS_JS.write_text(text, encoding="utf-8", newline="\n")
    print("tools.js: qq_cost registered (backup .bak-usage)")
    print('done — truly restart DSH now (scripts\\stop-companion.cmd + schtasks /run /tn "DSH-companion-p1")')


def check() -> int:
    ok = DEST.exists()
    print("usage.js:", "ok" if ok else "MISSING")
    text = read(TOOLS_JS)
    for needle in ("usageByDays } from './usage.js'", "name: 'qq_cost'"):
        hit = needle in text
        print(f"tools.js {needle[:36]}: {'ok' if hit else 'MISSING'}")
        ok = ok and hit
    return 0 if ok else 1


def revert() -> None:
    if BAK.exists():
        shutil.copyfile(BAK, TOOLS_JS)
        print(f"restored tools.js from {BAK.name}")
    else:
        print(f"{BAK.name}: no backup")
    if DEST.exists():
        DEST.unlink()
        print("removed usage.js")


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
