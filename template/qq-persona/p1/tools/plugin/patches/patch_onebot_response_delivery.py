"""v2.58: a trailing silence marker must not erase an already authored reply."""
from pathlib import Path
import argparse

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
TARGET = ROOT / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib/interim.js'
MARK = '// [dsh-p1] trailing silence is not a retraction of prior reply text.'


def expected(text):
    text = text.replace("        if (/^(?:\\[不回\\]|（不回）|【不回】)$/.test(visible) && chat.loopPending !== null",
                        "        if (!this.ctx.effectiveInterim(chatId) && /^(?:\\[不回\\]|（不回）|【不回】)$/.test(visible) && chat.loopPending !== null", 1)
    if MARK in text: return text
    anchor = "        if (text === '')\n            return;\n        this.cycle(chat).state = 'accumulating';"
    if text.count(anchor) != 1: raise SystemExit('response delivery: interim anchor mismatch')
    replacement = """        if (text === '')
            return;
        // [dsh-p1] trailing silence is not a retraction of prior reply text.
        const visible = text.replace(/\\[\\[(?:reply|wait):[^\\]\\n]*\\]\\]/g, '').trim();
        if (!this.ctx.effectiveInterim(chatId) && /^(?:\\[不回\\]|（不回）|【不回】)$/.test(visible) && chat.loopPending !== null
            && chat.loopPending !== undefined && chat.loopPending.trim() !== '') return;
        this.cycle(chat).state = 'accumulating';"""
    return text.replace(anchor, replacement, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    raw = TARGET.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    new = expected(raw.decode('utf-8').replace('\r\n', '\n')).replace('\n', newline).encode('utf-8')
    if args.check:
        print('patched' if new == raw else 'NOT patched')
        raise SystemExit(0 if new == raw else 1)
    if new != raw: TARGET.write_bytes(new)
    print('response delivery installed; restart DSH')


if __name__ == '__main__': main()
