"""Install narrow autonomous self-expression without changing management permissions."""
from pathlib import Path
import sys
ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
LIB = ROOT / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SOURCE = Path(__file__).resolve().parent.parent / 'modules/onebot_self_expression.js'

def expected(text):
    anchor = "import { makeReplyTool } from './reply.js';"
    imp = "import { makeSelfExpressionTool } from './self-expression.js';"
    if imp not in text:
        if text.count(anchor) != 1: raise SystemExit('self expression import anchor mismatch')
        text = text.replace(anchor, anchor + '\n' + imp, 1)
    anchor = '    register(makeReplyTool(defineTool, bridge, { appendMemory, sendReaction, adjustMood, mediaDirFallback: MEDIA_DIR_FALLBACK }));'
    hook = '    register(makeSelfExpressionTool(defineTool, bridge));'
    if hook not in text:
        if text.count(anchor) != 1: raise SystemExit('self expression registry anchor mismatch')
        text = text.replace(anchor, anchor + '\n' + hook, 1)
    return text

target = LIB / 'tools.js'
raw = target.read_bytes()
nl = '\r\n' if b'\r\n' in raw else '\n'
new = expected(raw.decode('utf-8').replace('\r\n', '\n')).replace('\n', nl).encode('utf-8')
dest = LIB / 'self-expression.js'
if '--check' in sys.argv:
    ok = raw == new and dest.exists() and dest.read_bytes() == SOURCE.read_bytes()
    print('patched' if ok else 'NOT patched')
    raise SystemExit(0 if ok else 1)
target.write_bytes(new)
dest.write_bytes(SOURCE.read_bytes())
print('self expression installed; restart DSH')
