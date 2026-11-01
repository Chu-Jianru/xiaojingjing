"""Apply model-selected reply timing; repeat safely after plugin upgrades."""
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
import argparse
import shutil

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
SOURCE = Path(__file__).resolve().parent.parent / "modules" / "onebot_reply_timing.js"
MARKER = "// [dsh-p1] model-selected reply timing"

EDITS = [
    ("import { TRACE_REASONS } from './trace.js';",
     "import { TRACE_REASONS } from './trace.js';\nimport { parseReplyTiming, defaultReplyDelayMs, bubbleDelayMs, replyIsCurrent, waitForReply } from './reply-timing.js';"),
    ("        this.now = options.now ?? (() => Date.now());",
     "        this.now = options.now ?? (() => Date.now());\n        this.replyRandom = options.random ?? Math.random;\n        this.replyWait = options.wait ?? waitForReply;"),
    ("    sendToChat(chatId, text, options = {}) {\n",
     """    sendToChat(chatId, text, options = {}) {
        // [dsh-p1] model-selected reply timing
        const parsedTiming = parseReplyTiming(text);
        text = parsedTiming.text;
        const timing = options.replyTiming;
        const guard = { ...timing, isStopping: () => this.ctx.isStopping?.() === true };
        if (timing) {
            const delay = timing.context?.urgent ? 0
                : parsedTiming.waitMs ?? defaultReplyDelayMs(text, timing.context, this.replyRandom);
            options = { ...options, replyTiming: { ...timing,
                notBefore: Number.isFinite(timing.notBefore) ? timing.notBefore : this.now() + delay } };
            this.ctx.log('debug', 'reply pacing: chat=' + chatId + ' waitMs=' + Math.max(0, options.replyTiming.notBefore - this.now()));
        }
        const cancelled = sentCount => {
            timing?.onCancelled?.({ chatId, text, sentCount });
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '新消息或停止取消待发回复', data: { segments: sentCount } });
        };
"""),
    ("        return this.enqueue(chatId, async () => {\n            if (!this.ctx.connected()) {",
     """        return this.enqueue(chatId, async () => {
            if (!replyIsCurrent(guard)) { cancelled(0); return []; }
            if (text === '' || /^(?:\\[不回\\]|（不回）|【不回】)$/.test(text.trim())) return [];
            if (timing && !await this.replyWait(Math.max(0, options.replyTiming.notBefore - this.now()), guard)) {
                cancelled(0);
                return [];
            }
            if (!replyIsCurrent(guard)) { cancelled(0); return []; }
            if (!this.ctx.connected()) {"""),
    ("                    this.queuePendingSend(chatId, text);",
     "                    this.queuePendingSend(chatId, text, options);"),
    ("""                        if (bi > 0)
                            await bubbleSleep(randomDelayMs(BUBBLE_DELAY_MIN_MS, BUBBLE_DELAY_MAX_MS));""",
     """                        if (bi > 0 && !await this.replyWait(bubbleDelayMs(bubbles[bi], this.replyRandom), guard)) {
                            cancelled(ids.length);
                            return ids;
                        }
                        if (!replyIsCurrent(guard)) { cancelled(ids.length); return ids; }"""),
    ("    queuePendingSend(chatId, text) {", "    queuePendingSend(chatId, text, options = {}) {"),
    ("        queue.push({ text, sentAt: this.now() });", "        queue.push({ text, options, sentAt: this.now() });"),
    ("                    batch.push({ chatId, text: item.text });", "                    batch.push({ chatId, text: item.text, options: item.options });"),
    ("        for (const { chatId, text } of batch) {\n            void this.sendToChat(chatId, text, { queuable: true })",
     "        for (const { chatId, text, options } of batch) {\n            void this.sendToChat(chatId, text, { ...options, queuable: true })"),
]


def apply(plugin_dir):
    target = plugin_dir / "outbound.js"
    text = target.read_text(encoding="utf-8")
    if MARKER not in text:
        for old, new in EDITS:
            if text.count(old) != 1:
                raise SystemExit(f"Expected one timing patch anchor: {old[:90]!r}; found {text.count(old)}")
            text = text.replace(old, new, 1)
        shutil.copy2(target, target.with_suffix(".js.bak-reply-timing"))
        target.write_text(text, encoding="utf-8")
    shutil.copy2(SOURCE, plugin_dir / "reply-timing.js")
    print("Reply timing patch applied")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-dir", type=Path, default=LIB)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        target = args.plugin_dir / "outbound.js"
        module = args.plugin_dir / "reply-timing.js"
        ok = MARKER in target.read_text(encoding="utf-8") and module.exists() and module.read_bytes() == SOURCE.read_bytes()
        print("Reply timing patch current" if ok else "Reply timing patch missing or outdated")
        raise SystemExit(0 if ok else 1)
    apply(args.plugin_dir)
