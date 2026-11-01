"""Install the self-only social request tool; no requests are sent by deployment."""
from pathlib import Path
import sys

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
LIB = REPO / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SRC = Path(__file__).resolve().parent.parent / 'modules/onebot_social.js'
IMPORT = "import { makeSocialTool } from './social.js';"
HOOK = '    register(makeSocialTool(defineTool, bridge));\n'

def expected():
    text = (LIB / 'tools.js').read_text(encoding='utf-8')
    anchor = "import { lookImage } from './vision.js';"
    if IMPORT not in text:
        if text.count(anchor) != 1: raise SystemExit('social import anchor mismatch')
        text = text.replace(anchor, anchor + '\n' + IMPORT, 1)
    anchor = "    register(defineTool({\n        name: 'qq_napcat_api',"
    if HOOK not in text:
        if text.count(anchor) != 1: raise SystemExit('social tool anchor mismatch')
        text = text.replace(anchor, HOOK + anchor, 1)
    return text

if __name__ == '__main__':
    text = expected()
    if '--check' in sys.argv:
        ok = (LIB / 'social.js').exists() and (LIB / 'social.js').read_text(encoding='utf-8') == SRC.read_text(encoding='utf-8') and (LIB / 'tools.js').read_text(encoding='utf-8') == text
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    (LIB / 'social.js').write_bytes(SRC.read_bytes())
    (LIB / 'tools.js').write_text(text, encoding='utf-8', newline='\r\n' if b'\r\n' in (LIB / 'tools.js').read_bytes() else '\n')
    print('social tool installed; restart DSH')
