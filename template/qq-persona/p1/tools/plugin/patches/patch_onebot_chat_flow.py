"""v2.54: prompt delivery of group text, opt-in conclusion after side effects."""
from pathlib import Path
import argparse

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
LIB = ROOT / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SOURCE = Path(__file__).resolve().parent.parent / 'modules/onebot_chat_flow.js'


def put(text, anchor, addition, marker):
    if marker in text:
        return text
    if text.count(anchor) != 1:
        raise SystemExit('chat flow anchor mismatch: ' + marker)
    return text.replace(anchor, addition, 1)


def expected(name, text):
    if name == 'bridge.js':
        anchor = "import { InterimTracker } from './interim.js';"
        text = put(text, anchor, anchor + "\nimport { chatFlowFor, CHAT_FLOW_GUIDANCE } from './chat-flow.js';", "import { chatFlowFor,")
        anchor = "import { chatFlowFor, CHAT_FLOW_GUIDANCE } from './chat-flow.js';"
        text = put(text, anchor, anchor + "\nimport { GROUP_CONVERSATION_GUIDANCE } from './group-conversation.js';", 'import { GROUP_CONVERSATION_GUIDANCE }')
        anchor = '            this.interim.onAssistantMessage(chatId, chat, event.data.message);'
        text = put(text, anchor, '            if (chatFlowFor(this).onAssistant(session, event, chatId)) { chat.loopPending = null; return; }\n' + anchor, 'chatFlowFor(this).onAssistant(session, event, chatId)')
        anchor = '    installChannelScope(agentCtx) {'
        text = put(text, anchor, anchor + "\n        agentCtx.systemPrompt.section({ name: 'channel:chat-flow', order: 91, text: CHAT_FLOW_GUIDANCE });", "name: 'channel:chat-flow'")
        text = text.replace("text: CHAT_FLOW_GUIDANCE });", "text: GROUP_CONVERSATION_GUIDANCE + '\\n' + CHAT_FLOW_GUIDANCE });")
    else:
        anchor = "import { defineTool } from '@deepseek-ai/dsh-tools';"
        text = put(text, anchor, anchor + "\nimport { chatFlowFor } from './chat-flow.js';", "import { chatFlowFor }")
        anchor = '        disposers.push(ctx.tools.register(tool));'
        text = put(text, anchor, '        disposers.push(ctx.tools.register(chatFlowFor(bridge).wrapTool(tool)));', 'chatFlowFor(bridge).wrapTool(tool)')
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    edits = {}
    for name in ('bridge.js', 'tools.js'):
        raw = (LIB / name).read_bytes()
        newline = '\r\n' if b'\r\n' in raw else '\n'
        text = raw.decode('utf-8').replace('\r\n', '\n')
        edits[name] = (raw, expected(name, text).replace('\n', newline).encode('utf-8'))
    target = LIB / 'chat-flow.js'
    if args.check:
        ok = all(raw == new for raw, new in edits.values()) and target.exists() and target.read_bytes() == SOURCE.read_bytes()
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    for name, (raw, new) in edits.items():
        if raw != new:
            (LIB / name).write_bytes(new)
    target.write_bytes(SOURCE.read_bytes())
    print('chat flow installed; restart DSH')


if __name__ == '__main__':
    main()
