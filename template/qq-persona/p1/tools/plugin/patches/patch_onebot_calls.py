"""Install opt-in local native-call transport without changing persona or model."""
from pathlib import Path
import argparse

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
LIB = REPO / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SOURCE = Path(__file__).resolve().parent.parent / 'modules/onebot_calls.js'

def expected(text):
    edits = [
        ("import { InterimTracker } from './interim.js';", "import { callsFor } from './calls.js';\nimport { InterimTracker } from './interim.js';"),
        ('            startJournal(this, createUserMessage);', '            startJournal(this, createUserMessage);\n            void callsFor(this).start().catch(() => this.deps.log(\'warn\', \'voice call transport unavailable\'));'),
        ('        listeningFor(this).stop();', '        listeningFor(this).stop();\n        await callsFor(this).stop();'),
        ('    sendToChat(chatId, text, options = {}) {', '    sendToChat(chatId, text, options = {}) {\n        const voice = callsFor(this).routeText(chatId, text, options);\n        if (voice !== null) return voice;'),
        ('    sendSegments(chatId, segments) {', '    sendSegments(chatId, segments) {\n        const voice = callsFor(this).routeSegments(chatId, segments);\n        if (voice !== null) return voice;'),
        ('    async handleInboundOnce(event, injected) {', '    async handleInboundOnce(event, injected) {\n        if (!injected) callsFor(this).onRealInbound(event);'),
        ('        const recorder = injected ? undefined : this.deps.config.recorder;', '        const recorder = injected || event.dshVoiceCall === true ? undefined : this.deps.config.recorder;'),
        ('                if (!injected && handled !== false)', '                if (!injected && event.dshVoiceCall !== true && handled !== false)'),
        ('                if (!injected && handled === false)', '                if (!injected && event.dshVoiceCall !== true && handled === false)'),
        ('        const final = this.prefixTurn(chatId, text);', '        const final = callsFor(this).decorate(chatId, this.prefixTurn(chatId, text));'),
        ("        if (event.type === 'turn/start') {", "        callsFor(this).onSessionEvent(chatId, event);\n        if (event.type === 'turn/start') {"),
    ]
    for old, new in edits:
        if old.startswith('import ') and "import { callsFor } from './calls.js';" in text:
            continue
        # Other deployments may place their startup between journal and calls.
        if old.strip().startswith('startJournal(') and new.split('\n')[-1] in text:
            continue
        if new in text:
            continue
        if text.count(old) != 1:
            raise SystemExit('Call transport anchor mismatch: ' + old)
        text = text.replace(old, new, 1)
    return text

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    target = LIB / 'bridge.js'; source = LIB / 'calls.js'
    raw = target.read_bytes(); newline = '\r\n' if b'\r\n' in raw else '\n'
    data = expected(raw.decode().replace('\r\n', '\n')).replace('\n', newline).encode()
    inbound = LIB / 'inbound.js'
    inbound_raw = inbound.read_bytes()
    inbound_newline = '\r\n' if b'\r\n' in inbound_raw else '\n'
    inbound_text = inbound_raw.decode().replace('\r\n', '\n')
    for old, new in [
        ('        catchup: event.catchup === true,', '        voiceCallAlive: typeof event.dshVoiceCallAlive === \'function\' ? event.dshVoiceCallAlive : undefined,\n        catchup: event.catchup === true,'),
        ('        this.ctx.observeJournal?.(inbound);', '        if (inbound.voiceCallAlive && !inbound.voiceCallAlive()) return false;\n        this.ctx.observeJournal?.(inbound);'),
    ]:
        if new not in inbound_text:
            if inbound_text.count(old) != 1: raise SystemExit('Call inbound anchor mismatch')
            inbound_text = inbound_text.replace(old, new, 1)
    inbound_data = inbound_text.replace('\n', inbound_newline).encode()
    if args.check:
        ok = raw == data and inbound_raw == inbound_data and source.exists() and source.read_bytes() == SOURCE.read_bytes()
        print('voice calls: ' + ('OK' if ok else 'OUT OF SYNC'))
        raise SystemExit(0 if ok else 1)
    target.write_bytes(data); inbound.write_bytes(inbound_data); source.write_bytes(SOURCE.read_bytes())
    print('Voice-call transport installed; restart DSH to load (disabled unless calls/config.json enables it).')

if __name__ == '__main__':
    main()
