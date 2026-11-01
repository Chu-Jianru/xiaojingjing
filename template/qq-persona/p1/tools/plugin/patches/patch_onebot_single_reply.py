"""v2.57: one authored reply + optional expression/memory, one model step."""
from pathlib import Path
import argparse

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
LIB = ROOT / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SOURCE = Path(__file__).resolve().parent.parent / 'modules/onebot_reply.js'


def expected(name, text):
    if name == 'tools.js':
        text = text.replace('register(makeReplyTool(defineTool, bridge, { appendMemory, sendReaction, mediaDirFallback: MEDIA_DIR_FALLBACK }));',
                            'register(makeReplyTool(defineTool, bridge, { appendMemory, sendReaction, adjustMood, mediaDirFallback: MEDIA_DIR_FALLBACK }));')
        anchor = "import { chatFlowFor } from './chat-flow.js';"
        if "import { makeReplyTool }" not in text:
            if text.count(anchor) != 1: raise SystemExit('single reply: import anchor mismatch')
            text = text.replace(anchor, anchor + "\nimport { makeReplyTool } from './reply.js';", 1)
        anchor = '        disposers.push(ctx.tools.register(chatFlowFor(bridge).wrapTool(tool)));\n    };'
        if 'register(makeReplyTool(' not in text:
            if text.count(anchor) != 1: raise SystemExit('single reply: registry anchor mismatch')
            text = text.replace(anchor, anchor + '\n    register(makeReplyTool(defineTool, bridge, { appendMemory, sendReaction, adjustMood, mediaDirFallback: MEDIA_DIR_FALLBACK }));', 1)
    else:
        old = 'import { chatFlowFor, CHAT_FLOW_GUIDANCE }'
        text = text.replace(old, 'import { chatFlowFor, CHAT_FLOW_GUIDANCE, SINGLE_REPLY_GUIDANCE }', 1)
        anchor = '    installChannelScope(agentCtx) {'
        if "name: 'channel:single-reply'" not in text:
            if text.count(anchor) != 1: raise SystemExit('single reply: scope anchor mismatch')
            text = text.replace(anchor, anchor + "\n        agentCtx.systemPrompt.section({ name: 'channel:single-reply', order: 92, text: SINGLE_REPLY_GUIDANCE });", 1)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    edits = {}
    for name in ('tools.js', 'bridge.js'):
        raw = (LIB / name).read_bytes()
        newline = '\r\n' if b'\r\n' in raw else '\n'
        edits[name] = (raw, expected(name, raw.decode('utf-8').replace('\r\n', '\n')).replace('\n', newline).encode('utf-8'))
    target = LIB / 'reply.js'
    if args.check:
        ok = all(raw == new for raw, new in edits.values()) and target.exists() and target.read_bytes() == SOURCE.read_bytes()
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    for name, (raw, new) in edits.items():
        if raw != new: (LIB / name).write_bytes(new)
    target.write_bytes(SOURCE.read_bytes())
    print('single reply installed; restart DSH')


if __name__ == '__main__': main()
