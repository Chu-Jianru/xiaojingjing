"""[dsh-p1] 本地视觉接线（P3，v2.06 → v2.28 sidecar 化）: lib/vision.js + qq_look 工具 + 入站图片自动视觉块.

v2.28 起模型跑在独立进程 tools/ops/vision-sidecar.mjs（内存隔离，见 docs/media.md §3.44），
lib/vision.js 只是 HTTP 客户端——本补丁整体拷贝部署（install_module）。

钩子点（inbound.js resolveMediaRef 的 image case）：
  1. `let autoVision = false;` 声明（pendingImageRef 消费行后）；
  2. OCR 之前 `autoVision = noteImage(...)` 后台起描述（返回 true 才算自动视觉启动）；
  3. case 尾部 `if (autoVision)` 门控的 lookImage 注记块（v2.09b 语义）。

  python tools/plugin/patches/patch_onebot_vision.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_vision.py --check
  python tools/plugin/patches/patch_onebot_vision.py --revert
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_vision.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "vision.js"
TOOLS_JS = LIB / "tools.js"
INBOUND = LIB / "inbound.js"
TOOLS_BAK = TOOLS_JS.with_suffix(".js.bak-vision")
INBOUND_BAK = INBOUND.with_suffix(".js.bak-vision")

TOOLS_IMPORT_ANCHOR = "import { usageByDays } from './usage.js';"
TOOLS_IMPORT_NEW = TOOLS_IMPORT_ANCHOR + "\nimport { lookImage } from './vision.js';"

TOOL_MARKER = "    // -- [dsh-p1] usage --"
TOOL_HOOK = """    register(defineTool({
        name: 'qq_look',
        description: '看本会话的图片；不带 path 使用最新一张。关闭返回 vision_disabled，等待中返回 vision_pending，只有成功的 description 才是已识别画面。错误是内部状态，结合语境自行组织回复，不照抄、不猜图、不保证稍后成功。',
        parameters: {
            path: { type: 'string', description: '图片文件完整路径（消息里的 [图片:路径]）；省略=本会话最新一张' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const result = await lookImage(chatId, typeof a.path === 'string' ? a.path : '',
                (level, message) => bridge.deps?.log?.(level, message));
            if (result?.error !== undefined)
                return { ...result, ok: false };
            return { ok: true, description: result.text };
        },
    }));
"""

INBOUND_IMPORT_ANCHOR = "import { noteForAutoLearn } from './auto-learn.js';"
INBOUND_IMPORT_NEW = INBOUND_IMPORT_ANCHOR + "\nimport { noteImage, lookImage, rememberImage, unseenImageAnnotation } from './vision.js';"

INBOUND_DECL_ANCHOR = "                settings.pendingImageRef = undefined;"
INBOUND_DECL_NEW = INBOUND_DECL_ANCHOR + "\n                rememberImage(chatId, resolved.path);\n                let autoVision = false;"

INBOUND_OCR_ANCHOR = "                    const ocr = await this.tryOcrImage(resolved.path);"
INBOUND_HOOK = """                    // [dsh-p1] vision (P3): background-describe this image
                    // (fire-and-forget, never blocks the turn)
                    autoVision = noteImage(chatId, resolved.path, (level, message) => this.ctx.log(level, message));
"""

INBOUND_ANNOTATE_ANCHOR = """                return '[图片:' + resolved.path + ']';
            }
            case 'voice': {"""
INBOUND_ANNOTATE_NEW = """                // [dsh-p1] v2.09b: local vision — answer rides the annotation.
                // Cache hit is instant; a miss waits briefly (first describe of
                // a fresh image is already running in the background via
                // noteImage, so this usually only pays the tail of it).
                if (autoVision) {
                    try {
                        const seen = await lookImage(chatId, resolved.path, (level, message) => this.ctx.log(level, message));
                        if (seen && seen.text)
                            return '[图片:' + resolved.path + ']（你看过这张图，画的是：' + seen.text + '）';
                    }
                    catch { /* vision down: fall through to the bare annotation */ }
                }
                return unseenImageAnnotation(resolved.path);
            }
            case 'voice': {"""


def refresh_existing(tools_text: str, inbound_text: str) -> tuple[str, str]:
    """Refresh owned hooks as well as first-time installation (v2.32).

    Marker-only checks used to silently keep stale dialogue in existing installs.
    Keep the rest of inbound.js, including later patches, unchanged.
    """
    description = re.search(r"        description: .*", TOOL_HOOK).group(0)
    tools_text, count = re.subn(r"(?<=        name: 'qq_look',\n)        description: .*", lambda _: description, tools_text)
    if count != 1:
        raise SystemExit("qq_look description: expected one hook")
    tools_text = tools_text.replace("return { ok: false, error: result.error };", "return { ...result, ok: false };")
    inbound_text, count = re.subn(r"import \{[^\n]*\} from './vision.js';", lambda _: INBOUND_IMPORT_NEW.split('\n')[-1], inbound_text)
    if count != 1:
        raise SystemExit("vision import: expected one hook")
    if "rememberImage(chatId, resolved.path);" not in inbound_text:
        inbound_text = replace_once(inbound_text, INBOUND_DECL_ANCHOR, INBOUND_DECL_ANCHOR + "\n                rememberImage(chatId, resolved.path);", "latest image hook")
    inbound_text, count = re.subn(
        r"                // \[dsh-p1\] v2\.09b: local vision.*?            case 'voice': \{",
        lambda _: INBOUND_ANNOTATE_NEW, inbound_text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit("vision annotation: expected one owned block")
    inbound_text = inbound_text.replace(
        "return '[图片:' + resolved.path + ']（图里写着：「' + ocr + '」）';",
        "return unseenImageAnnotation(resolved.path, ocr);")
    return tools_text, inbound_text


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
    if "qq_look" not in text:
        if not TOOLS_BAK.exists():
            shutil.copyfile(TOOLS_JS, TOOLS_BAK)
        text = replace_once(text, TOOLS_IMPORT_ANCHOR, TOOLS_IMPORT_NEW, "tools import")
        text = replace_once(text, TOOL_MARKER, TOOL_HOOK + TOOL_MARKER, "qq_look tool")
        TOOLS_JS.write_text(text, encoding="utf-8", newline="\n")
        print("tools.js: qq_look registered (backup .bak-vision)")
    else:
        print("tools.js: already patched")

    text = read(INBOUND)
    if "autoVision" not in text:
        if not INBOUND_BAK.exists():
            shutil.copyfile(INBOUND, INBOUND_BAK)
        text = replace_once(text, INBOUND_IMPORT_ANCHOR, INBOUND_IMPORT_NEW, "inbound import")
        text = replace_once(text, INBOUND_DECL_ANCHOR, INBOUND_DECL_NEW, "inbound autoVision decl")
        text = replace_once(text, INBOUND_OCR_ANCHOR, INBOUND_HOOK + INBOUND_OCR_ANCHOR, "inbound image hook")
        text = replace_once(text, INBOUND_ANNOTATE_ANCHOR, INBOUND_ANNOTATE_NEW, "inbound annotation gate")
        INBOUND.write_text(text, encoding="utf-8", newline="\n")
        print("inbound.js: auto-vision block wired (backup .bak-vision)")
    else:
        print("inbound.js: already patched")
    tools_text, inbound_text = refresh_existing(read(TOOLS_JS), text)
    if tools_text != read(TOOLS_JS):
        TOOLS_JS.write_text(tools_text, encoding="utf-8", newline="\n")
    if inbound_text != read(INBOUND):
        INBOUND.write_text(inbound_text, encoding="utf-8", newline="\n")
    print("done — truly restart DSH now")


def check() -> int:
    ok = DEST.exists() and read(DEST) == read(SRC)
    print("vision.js:", "ok" if ok else "MISSING")
    for name, path, needles in (
        ("tools.js", TOOLS_JS, ["lookImage } from './vision.js'", "name: 'qq_look'"]),
        ("inbound.js", INBOUND, [
            "noteImage, lookImage, rememberImage, unseenImageAnnotation } from './vision.js'",
            "let autoVision = false;",
            "autoVision = noteImage(chatId, resolved.path,",
            "if (autoVision) {",
            "return unseenImageAnnotation(resolved.path, ocr);",
            "return unseenImageAnnotation(resolved.path);",
            "rememberImage(chatId, resolved.path);",
        ]),
    ):
        text = read(path)
        for needle in needles:
            hit = needle in text
            print(f"{name} {needle[:44]}: {'ok' if hit else 'MISSING'}")
            ok = ok and hit
    tools_text, inbound_text = refresh_existing(read(TOOLS_JS), read(INBOUND))
    ok = ok and tools_text == read(TOOLS_JS) and inbound_text == read(INBOUND)
    return 0 if ok else 1


def revert() -> None:
    # .bak-vision 是 v2.06 时代的快照，lib 之后又进了二十个版本的改动——
    # 恢复前先把现状留档，revert 丢东西的事故（2026-10-26 实踩）不能再犯
    for cur, bak in ((TOOLS_JS, TOOLS_BAK), (INBOUND, INBOUND_BAK)):
        if cur.exists():
            pre = cur.with_name(cur.name + ".pre-revert")
            shutil.copyfile(cur, pre)
            print(f"snapshot {pre.name}")
        if bak.exists():
            shutil.copyfile(bak, cur)
            print(f"restored {cur.name}（警告：bak 可能落后于现行 lib，对照 .pre-revert 核对）")
        else:
            print(f"{bak.name}: no backup")
    if DEST.exists():
        DEST.unlink()
        print("removed vision.js")


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
