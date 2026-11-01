#!/usr/bin/env python3
"""[dsh-p1] lib 内剩余绝对路径兜底 → 仓库推导（迁移安全，v2.26）。

把 lib/inbound.js / lib/tools.js / lib/tts.js 里最后三处 E:\\dsh 硬编码兜底
改为从 import.meta.url 向上找仓库根（bot-home + qq-persona 同目录）推导：

- inbound.js  personaDir 兜底（matchSticker 的 persona 目录）
- tools.js    mediaDir 兜底 ×7（qq_send_image / qq_send_voice / tts 输出等）
- tts.js      tts-voice.json 读取路径

vision.js / meme-recall.js / usage.js / memory-store.js 的同类改造在各自源模块里
（install_module 整文件部署，由对应补丁负责）；本补丁只覆盖没有源模块的三个文件。
Idempotent; --check / --revert。`dsh plugin` 升级后重跑。改的是插件代码，打完真重启 DSH。

    python tools/plugin/patches/patch_onebot_repo_paths.py            # apply / refresh
    python tools/plugin/patches/patch_onebot_repo_paths.py --check    # patched?
    python tools/plugin/patches/patch_onebot_repo_paths.py --revert   # restore backups
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
LIB = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib"
BAK = ".bak-repopaths"

REPO_BLOCK = """
const REPO = (() => {
    let d = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(d, 'bot-home')) && existsSync(join(d, 'qq-persona'))) return d;
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    return d;
})();"""

# (文件, 锚点=在其后插入 import+REPO 块, 旧兜底串, 新兜底串, 额外 import 行)
EDITS = [
    (
        "inbound.js",
        "import { appendMemory, notesBlock, recallMemoryBlock } from './memory-store.js';",
        "personaDir: process.env.DSH_PERSONA_DIR ?? 'E:\\\\dsh\\\\qq-persona\\\\p1',",
        "personaDir: process.env.DSH_PERSONA_DIR ?? join(REPO, 'qq-persona', 'p1'),",
        "import { existsSync } from 'node:fs';\n"
        "import { dirname, join } from 'node:path';\n"
        "import { fileURLToPath } from 'node:url';",
    ),
    (
        "tools.js",
        "import { dirname, join } from 'node:path';",
        "bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot'",
        "bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK",
        "import { existsSync } from 'node:fs';\n"
        "import { fileURLToPath } from 'node:url';\n\n"
        "const MEDIA_DIR_FALLBACK = join(REPO, 'bot-home', 'media', 'onebot');",
    ),
    (
        "tts.js",
        "import { dirname } from 'node:path';",
        "await readFile('E:\\\\dsh\\\\bot-home\\\\media\\\\onebot\\\\tts-voice.json', 'utf8')",
        "await readFile(join(REPO, 'bot-home', 'media', 'onebot', 'tts-voice.json'), 'utf8')",
        "import { existsSync } from 'node:fs';\n"
        "import { dirname, join } from 'node:path';\n"
        "import { fileURLToPath } from 'node:url';",
    ),
]


def apply() -> None:
    for name, anchor, old, new, extra_imports in EDITS:
        p = LIB / name
        bak = p.with_suffix(f".js{BAK}")
        text = p.read_text(encoding="utf-8")
        orig = text
        if "const REPO = (() => {" not in text:
            if not bak.exists():
                shutil.copy2(p, bak)
            text = text.replace(anchor, anchor + "\n" + extra_imports + REPO_BLOCK, 1)
            print(f"{name}: inserted REPO derivation")
        if old in text:
            if not bak.exists():
                shutil.copy2(p, bak)
            text = text.replace(old, new)
            print(f"{name}: fallback -> REPO-derived")
        if text != orig:
            p.write_text(text, encoding="utf-8")
        else:
            print(f"{name}: already applied")


def check() -> int:
    ok = True
    for name, _anchor, old, new, _extra in EDITS:
        text = (LIB / name).read_text(encoding="utf-8")
        good = ("const REPO = (() => {" in text) and (old not in text) and (new in text)
        print(f"{name}: {'ok' if good else 'NOT patched'}")
        ok = ok and good
    return 0 if ok else 1


def revert() -> None:
    for name, *_rest in EDITS:
        p = LIB / name
        bak = p.with_suffix(f".js{BAK}")
        if bak.exists():
            shutil.copy2(bak, p)
            print(f"{name}: restored from {bak.name}")
        else:
            print(f"{name}: no backup, skip")


def main() -> None:
    if "--check" in sys.argv:
        sys.exit(check())
    if "--revert" in sys.argv:
        revert()
        return
    apply()
    print("done — 真重启 DSH 生效（scripts\\stop-companion.cmd + schtasks /run /tn \"DSH-companion-p1\"）")


if __name__ == "__main__":
    main()
