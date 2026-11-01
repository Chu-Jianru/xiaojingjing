"""[dsh-p1] 出站协议记号残留守门（v2.23）: lib/outbound.js 接线.

见 README 4.46：2026-10-25 她把引用记号写成裸的 `[[reply]]`（丢了 `:数字`），
出站剥离正则 `^\\s*\\[\\[reply:(\\d{5,})\\]\\]\\s*` 只认完整形态，残缺版原样
漏进气泡（老大收到字面 `[[reply]]-no need.`）。守门口径：**消息里不允许有
任何模型的工具式回执记号** —— `[[reply…]]` / `[[wait…]]` / `[[qq_forward…]]`
（含残缺、错位、孤儿闭合）在三个出站面全部剥离：

  1. t2i 文字图卡片正文（卡片路径没有逐气泡解析，标记会烤进图里）
  2. 逐气泡文本（严格引用转换之后，剩下的任何记号都是残留）
  3. 合并转发节点内容（qq_send_forward 工具路径 + 被动 [[qq_forward]] 块共用）

不匹配的形态一律剥离、不报错、warn + trace 记数（沿用「静默丢弃必须可见」
原则）；记号删完只剩空行的气泡整条不发。

幂等；重跑 dsh plugin 升级后先重放，再重启 DSH：

  python tools/plugin/patches/patch_onebot_marker_guard.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
OUTBOUND = LIB / "outbound.js"
BAK = OUTBOUND.with_suffix(".js.bak-markerresidue")
IDEMPOTENT = "stripMarkerResidue"

HELP_ANCHOR = r"""import { stripSpliceLeaks } from './splice-guard.js';
const BUBBLE_MAX = 4;
const BUBBLE_DELAY_MIN_MS = 800;
const BUBBLE_DELAY_MAX_MS = 1500;
"""

HELP_NEW = HELP_ANCHOR + r"""
// -- [dsh-p1] protocol-marker residue guard (v2.23, 4.46) --------------------------------
// [[reply…]] / [[wait…]] / [[qq_forward…]] are plugin protocol, never bubble
// text. Well-formed leading forms are parsed earlier (reply-to before the
// enqueue, parseReplyTiming for wait, extractForwardBlocks for forward
// blocks); ANY marker still in the text — malformed like the 2026-10-25
// `[[reply]]— no need.` leak, or well-formed but misplaced mid-text — is
// stripped here so a control marker can never reach a bubble, a t2i card or
// a forward node.
const MARKER_RESIDUE_LEADING_RE = /^[ \t]*\[\[\/?(?:reply|wait|qq_forward)(?::[^\]\n]*)?\]\][ \t]*/gim;
const MARKER_RESIDUE_RE = /\[\[\/?(?:reply|wait|qq_forward)(?::[^\]\n]*)?\]\]/gi;
export function stripMarkerResidue(text) {
    const raw = String(text ?? '');
    let removed = 0;
    let out = raw.replace(MARKER_RESIDUE_LEADING_RE, () => { removed += 1; return ''; });
    out = out.replace(MARKER_RESIDUE_RE, () => { removed += 1; return ''; });
    return { text: out, removed };
}
"""

CARD_ANCHOR = r"""                    const png = renderTextImage(body, {"""

CARD_NEW = r"""                    // [dsh-p1] residue guard (4.46): markers must not bake into the card image.
                    const cardBody = stripMarkerResidue(body);
                    if (cardBody.removed > 0) {
                        this.ctx.log('warn', 'marker-residue guard removed ' + cardBody.removed + ' marker(s) from t2i card in ' + chatId);
                        this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '剥离协议记号残留: ' + cardBody.removed });
                    }
                    const png = renderTextImage(cardBody.text, {"""

BUBBLE_ANCHOR = r"""                        const bubbleMarker = /^\s*\[\[reply:(\d{5,})\]\]\s*/.exec(bubbleText);
                        if (bubbleMarker !== null) {
                            bubbleText = bubbleText.slice(bubbleMarker[0].length);
                            bubbleReply = bubbleMarker[1];
                        }
"""

BUBBLE_NEW = BUBBLE_ANCHOR + r"""                        // [dsh-p1] residue guard (4.46): no [[reply]]/[[wait]]/[[qq_forward]]
                        // marker may reach a bubble — malformed or misplaced alike.
                        const guarded = stripMarkerResidue(bubbleText);
                        if (guarded.removed > 0) {
                            this.ctx.log('warn', 'marker-residue guard removed ' + guarded.removed + ' marker(s) in ' + chatId);
                            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '剥离协议记号残留: ' + guarded.removed });
                        }
                        bubbleText = guarded.text;
                        if (bubbleText === '')
                            continue;
"""

FORWARD_ANCHOR = r"""        const messages = nodes.map(node => ({"""

FORWARD_NEW = r"""        // [dsh-p1] residue guard (4.46): protocol markers must not ride inside
        // forward node content either (gated tool path and passive blocks).
        const cleaned = [];
        for (const node of nodes) {
            const stripped = stripMarkerResidue(node.content);
            if (stripped.removed > 0)
                this.ctx.log('warn', 'marker-residue guard removed ' + stripped.removed + ' marker(s) from forward node in ' + chatId);
            if (stripped.text !== '')
                cleaned.push({ ...node, content: stripped.text });
        }
        const messages = cleaned.map(node => ({"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def replace_once(text: str, old: str, new: str, what: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{what}: anchor found {n} times (expected 1); aborting")
    return text.replace(old, new, 1)


def apply() -> None:
    text = read(OUTBOUND)
    if IDEMPOTENT in text:
        print("outbound.js: already patched")
        return
    if not BAK.exists():
        shutil.copy2(OUTBOUND, BAK)
    text = replace_once(text, HELP_ANCHOR, HELP_NEW, "helper block")
    text = replace_once(text, CARD_ANCHOR, CARD_NEW, "t2i card path")
    text = replace_once(text, BUBBLE_ANCHOR, BUBBLE_NEW, "bubble loop")
    text = replace_once(text, FORWARD_ANCHOR, FORWARD_NEW, "sendForwardNodes")
    OUTBOUND.write_text(text, encoding="utf-8")
    print(f"patched {OUTBOUND} (backup: {BAK.name})")


def check() -> int:
    text = read(OUTBOUND)
    ok = all(s in text for s in (
        "export function stripMarkerResidue(",
        "const cardBody = stripMarkerResidue(body)",
        "const guarded = stripMarkerResidue(bubbleText)",
        "const stripped = stripMarkerResidue(node.content)",
    ))
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BAK.exists():
        shutil.copy2(BAK, OUTBOUND)
        BAK.unlink()
        print(f"reverted {OUTBOUND}")
    else:
        print("no backup found; nothing to revert")


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
