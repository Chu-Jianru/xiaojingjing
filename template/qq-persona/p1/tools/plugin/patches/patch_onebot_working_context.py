"""v2.57: deduplicate old framework metadata at existing compaction boundaries."""
from pathlib import Path
import argparse

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
LIB = ROOT / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SOURCE = Path(__file__).resolve().parent.parent / 'modules/onebot_working_context.js'


def expected(text):
    anchor = "import { createUserMessage } from '@deepseek-ai/dsh-llm';"
    if "import { installWorkingContext }" not in text:
        if text.count(anchor) != 1: raise SystemExit('working context: import anchor mismatch')
        text = text.replace(anchor, anchor + "\nimport { installWorkingContext } from './working-context.js';", 1)
    anchor = '    installChannelScope(agentCtx) {'
    if 'installWorkingContext(agentCtx, this, createUserMessage);' not in text:
        if text.count(anchor) != 1: raise SystemExit('working context: scope anchor mismatch')
        text = text.replace(anchor, anchor + '\n        installWorkingContext(agentCtx, this, createUserMessage);', 1)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    target = LIB / 'bridge.js'
    raw = target.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    new = expected(raw.decode('utf-8').replace('\r\n', '\n')).replace('\n', newline).encode('utf-8')
    module = LIB / 'working-context.js'
    if args.check:
        ok = new == raw and module.exists() and module.read_bytes() == SOURCE.read_bytes()
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    if new != raw: target.write_bytes(new)
    module.write_bytes(SOURCE.read_bytes())
    print('working context installed; restart DSH')


if __name__ == '__main__': main()
