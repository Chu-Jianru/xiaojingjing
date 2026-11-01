"""[dsh-p1] 回复节奏（v1.97, 2026-10-25）: per-turn bubble-count hint.

她的回复格式塌缩成了固定模式：几乎每轮都是「两条气泡，第一句长 + 第二句短尾巴」。
core.md §3 早就有「别凑第二句」，但静态规则拗不过模型的习惯——所以改成机制层注入：
每轮在 [作息] 后面给一条 `[节奏]` 建议（随机制采样），照建议走。

分布（rhythmHint）：
  50%  这轮尽量一条说完
  20%  这轮可以拆两条：先短后长
  15%  这轮拆两条，都短点
  15%  （不注入，留自然变化）

同时（提示词侧，build_persona.py）：教她用框架已有的 [[wait:秒]] 标记自选回复时间。
本补丁只动 inbound.js 的注入，不动 reply-timing.js（那套 0.65–12s 默认节奏 + [[wait]]
+ 新消息自动取消重排，框架本来就有，只是她不知道）。

Idempotent；改插件代码，打完真重启 DSH：

  python tools/plugin/patches/patch_onebot_rhythm.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_rhythm.py --check
  python tools/plugin/patches/patch_onebot_rhythm.py --revert
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
INBOUND = LIB / "inbound.js"
BAK = INBOUND.with_suffix(".js.bak-rhythm")

MARKER = "[dsh-p1] reply rhythm"

HELPER_OLD = """// -- [dsh-p1] group peek ------------------------------------------------------------
"""
HELPER_NEW = """// -- MARKER ------------------------------------------------------------
// Her replies had collapsed into a fixed "two bubbles, long then short"
// pattern no matter what §3 said. A concrete per-turn suggestion beats a
// static rule: sampled each turn, injected as [节奏], '' = no hint.
export function rhythmHint(random = Math.random) {
    const roll = random();
    if (roll < 0.50)
        return '这轮尽量一条说完';
    if (roll < 0.70)
        return '这轮可以拆两条：先短后长';
    if (roll < 0.85)
        return '这轮拆两条，都短点';
    // [dsh-p1] v2.12：8% 「配一张表情」桶退役——她本来就被人格规则推着发表情，
    // [节奏] 再点一把火就成了逢回必带（4.38）；表情频率归人格层管，节奏只管条数。
    return '';
}

// -- [dsh-p1] group peek ------------------------------------------------------------
"""

INJECT_OLD = """        final = '[作息] 现在：' + sleepLabel + sleepNote + '\\n' + final;
"""
INJECT_NEW = """        final = '[作息] 现在：' + sleepLabel + sleepNote + '\\n' + final;
        // MARKER: explicit per-turn bubble-count suggestion.
        const rhythm = rhythmHint();
        if (rhythm !== '')
            final = '[节奏] ' + rhythm + '\\n' + final;
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def replace_once(text: str, old: str, new: str, what: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{what}: anchor found {n} times (expected 1); aborting")
    return text.replace(old, new, 1)


def apply() -> None:
    text = read(INBOUND)
    if "rhythmHint" in text:
        print("inbound.js: already patched")
        return
    shutil.copyfile(INBOUND, BAK)
    text = replace_once(text, HELPER_OLD, HELPER_NEW.replace("MARKER", MARKER, 1), "rhythmHint helper")
    text = replace_once(text, INJECT_OLD, INJECT_NEW.replace("MARKER", MARKER, 1), "rhythm injection")
    INBOUND.write_text(text, encoding="utf-8", newline="\n")
    print("inbound.js: rhythmHint + [节奏] injection (backup .bak-rhythm)")
    print('done — truly restart DSH now (scripts\\stop-companion.cmd + schtasks /run /tn "DSH-companion-p1")')


def check() -> int:
    text = read(INBOUND)
    ok = True
    for needle in ("export function rhythmHint", "'[节奏] ' + rhythm"):
        hit = needle in text
        print(f"inbound.js {needle[:36]}: {'ok' if hit else 'MISSING'}")
        ok = ok and hit
    return 0 if ok else 1


def revert() -> None:
    if BAK.exists():
        shutil.copyfile(BAK, INBOUND)
        print(f"restored inbound.js from {BAK.name}")
    else:
        print(f"{BAK.name}: no backup (nothing to restore)")


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
