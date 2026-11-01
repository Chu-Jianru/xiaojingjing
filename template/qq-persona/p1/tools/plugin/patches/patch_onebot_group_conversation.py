"""v2.37: prepare group messages individually, dispatch each conversation together."""
from pathlib import Path
import argparse

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
LIB = ROOT / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SOURCE = Path(__file__).resolve().parent.parent / 'modules/onebot_group_conversation.js'
IMPORT = "import { GROUP_BATCH, groupConversationFor } from './group-conversation.js';"


def put(text, anchor, replacement, marker):
    if marker in text:
        return text
    if text.count(anchor) != 1:
        raise SystemExit('group conversation anchor mismatch: ' + marker)
    return text.replace(anchor, replacement, 1)


def expected(name, text):
    if name == 'bridge.js':
        anchor = 'const chats = [...this.chats.keys()].slice(0, 8);'
        private_chats = "const chats = [...this.chats.keys()].filter(id => id.startsWith('private:')).slice(0, 8);"
        text = put(text, anchor, private_chats, private_chats)
        anchor = "import { listeningFor } from './listening.js';"
        text = put(text, anchor, anchor + '\n' + IMPORT, IMPORT)
        anchor = '            handleEvent: event => this.handleInbound(event),'
        text = put(text, anchor, anchor + '\n            handleGroupBatch: events => groupConversationFor(this).deliver(events),', 'handleGroupBatch: events =>')
        anchor = '        listeningFor(this).stop();'
        text = put(text, anchor, anchor + '\n        groupConversationFor(this).stop();', 'groupConversationFor(this).stop();')
        anchor = '                if (await listening.receive(event, { injected, immediate, selfId })) return false;'
        text = put(text, anchor, anchor + '\n                if (await groupConversationFor(this).receive(event, { injected, selfId })) return false;', 'groupConversationFor(this).receive(event,')
        # Collected parts are not delivered yet. The batch owns their receipts.
        anchor = '                const handled = await this.processInbound(inbound);'
        text = put(text, anchor, anchor + '\n                if (inbound.groupBatch) return handled;', 'if (inbound.groupBatch) return handled;')
    else:
        anchor = "import { readFile, writeFile } from 'node:fs/promises';"
        text = put(text, anchor, anchor + "\nimport { GROUP_BATCH } from './group-conversation.js';", "import { GROUP_BATCH")
        text = text.replace("import { GROUP_BATCH } from './group-conversation.js';", "import { GROUP_BATCH, explicitGroupAddress } from './group-conversation.js';")
        marker = '        const addressedDirectly = '
        if marker not in text:
            anchor = '        const mentioned = detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ) || calledByName || fishCall;'
            if text.count(anchor) != 1: raise SystemExit('direct addressing anchor changed')
            text = text.replace(anchor, anchor + "\n        const addressedDirectly = kind === 'group' ? explicitGroupAddress(inbound, this.ctx.selfId(), this.ctx.config.botQQ) || calledByName || fishCall : mentioned;", 1)
        text = text.replace('buildGroupMessagePrefix(nickname, userId, mentioned, inbound.catchupSaidAtMs)', 'buildGroupMessagePrefix(nickname, userId, addressedDirectly, inbound.catchupSaidAtMs)')
        text = text.replace('            if (mentioned) {\n                noteGroupMention(chatId);', '            if (mentioned || addressedDirectly) {\n                noteGroupMention(chatId);')
        anchor = '        catchup: event.catchup === true,'
        text = put(text, anchor, anchor + '\n        groupBatch: event[GROUP_BATCH],', 'groupBatch: event[GROUP_BATCH]')
        text = text.replace('        const rhythm = rhythmHint();', "        const rhythm = inbound.groupBatch ? '' : rhythmHint();")
        anchor = '        const plain = inbound.media.length === 0 && inbound.replyId === undefined && inbound.forwardId === undefined;'
        text = put(text, anchor, '''        // [dsh-p1] collect prepared, sender-scoped group content before dispatch.
        if (kind === 'group' && inbound.groupBatch) {
            inbound.groupBatch.parts.push({ final, role, nickname, messageId: String(inbound.messageId) });
            return true;
        }
''' + anchor, 'inbound.groupBatch.parts.push(')
        text = text.replace('// [dsh-p1] v2.09: catch-up replay tag — replies to these must quote.', '// [dsh-p1] catch-up source tag; quoting is a contextual choice.')
        text = text.replace('nickname, messageId: String(inbound.messageId) });', 'nickname, messageId: String(inbound.messageId), addressed: addressedDirectly });')
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    edits = {}
    for name in ('bridge.js', 'inbound.js'):
        raw = (LIB / name).read_bytes()
        newline = '\r\n' if b'\r\n' in raw else '\n'
        text = raw.decode('utf-8').replace('\r\n', '\n')
        edits[name] = (raw, expected(name, text).replace('\n', newline).encode('utf-8'))
    if args.check:
        ok = all(raw == new for raw, new in edits.values()) and (LIB / 'group-conversation.js').exists() and (LIB / 'group-conversation.js').read_bytes() == SOURCE.read_bytes()
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    for name, (raw, new) in edits.items():
        if new != raw:
            (LIB / name).write_bytes(new)
    (LIB / 'group-conversation.js').write_bytes(SOURCE.read_bytes())
    print('group conversation installed')


if __name__ == '__main__':
    main()
