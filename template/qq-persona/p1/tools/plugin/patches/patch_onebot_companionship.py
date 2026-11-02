"""v2.96: freeze actual turn senders, share accepted conduct, and enable social opportunities."""
from pathlib import Path
import sys

REPO = next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir() and (p/'qq-persona').is_dir())
LIB = REPO/'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
MODULES = Path(__file__).resolve().parents[1]/'modules'

def replace(text, old, new):
    if new in text: return text
    if new.startswith(old + '\n') and all(line in text for line in new[len(old)+1:].splitlines()): return text
    if text.count(old) != 1: raise SystemExit('companionship anchor mismatch: ' + old[:120])
    return text.replace(old, new, 1)

def expected(name, text):
    if name == 'bridge.js':
        text = replace(text, "import { callsFor } from './calls.js';", "import { callsFor } from './calls.js';\nimport { stopSinging } from './singing.js';")
        text = replace(text, '        this.stopping = true;', '        this.stopping = true;\n        stopSinging(this);')
        text = replace(text, '    installChannelScope(agentCtx) {', '    installChannelScope(agentCtx) {\n        this.makeUserMessage = createUserMessage;')
        text = replace(text, "import { callsFor } from './calls.js';", "import { callsFor } from './calls.js';\nimport { helperSessionEvent } from './helper.js';")
        text = replace(text, '        if (journalSessionEvent(this, session, event)) return;', '        if (helperSessionEvent(this, session, event)) return;\n        if (journalSessionEvent(this, session, event)) return;')
        for old, new in [
            ('(chatId, text, role, nickname, revision) => this.dispatchFollowup(chatId, text, role, nickname, revision)', '(chatId, text, role, nickname, revision, userId) => this.dispatchFollowup(chatId, text, role, nickname, revision, userId)'),
            ('(chatId, text, role, nickname, plain, revision) => this.interceptBusyTurn(chatId, text, role, nickname, plain, revision)', '(chatId, text, role, nickname, plain, revision, userId) => this.interceptBusyTurn(chatId, text, role, nickname, plain, revision, userId)'),
            ('async dispatchFollowup(chatId, text, role, nickname, listeningRevision) {', 'async dispatchFollowup(chatId, text, role, nickname, listeningRevision, userId) {'),
            ('        chat.pendingTurnRoles.push(role);', "        chat.pendingTurnRoles.push(role);\n        (chat.pendingTurnActors ??= []).push(String(userId ?? (chatId.startsWith('private:') ? chatId.slice(8) : '')));"),
            ('async interceptBusyTurn(chatId, text, role, nickname, plain, listeningRevision) {', 'async interceptBusyTurn(chatId, text, role, nickname, plain, listeningRevision, userId) {'),
            ('await this.dispatchFollowup(chatId, text, role, nickname, listeningRevision);', 'await this.dispatchFollowup(chatId, text, role, nickname, listeningRevision, userId);'),
            ("            chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member';", "            chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member';\n            chat.activeTurnUserId = chat.pendingTurnActors?.shift() ?? '';\n            chat.activeTurnSequence = (chat.activeTurnSequence ?? 0) + 1;"),
        ]:
            if old.startswith('async dispatchFollowup(') and 'async dispatchFollowup(chatId, text, role, nickname, listeningRevision, userId, proactiveJobId) {' in text:
                continue
            text = replace(text, old, new)
        text = replace(text, "import { stopSinging } from './singing.js';", "import { stopSinging } from './singing.js';\nimport { startProactive, stopProactive, noteProactiveSent } from './proactive.js';")
        text = replace(text, '            startJournal(this, createUserMessage);', '            startJournal(this, createUserMessage);\n            startProactive(this);')
        text = replace(text, '        stopSinging(this);', '        stopSinging(this);\n        stopProactive(this);')
        text = replace(text, 'async dispatchFollowup(chatId, text, role, nickname, listeningRevision, userId) {', 'async dispatchFollowup(chatId, text, role, nickname, listeningRevision, userId, proactiveJobId) {')
        text = text.replace('        chat.proactiveJobId = proactiveJobId;\n', '')
        text = replace(text, '        chat.lastFollowup = text;', '        (chat.pendingProactiveJobs ??= []).push(proactiveJobId);\n        chat.lastFollowup = text;')
        text = replace(text, "            chat.activeTurnUserId = chat.pendingTurnActors?.shift() ?? '';", "            chat.activeTurnUserId = chat.pendingTurnActors?.shift() ?? '';\n            chat.proactiveJobId = chat.pendingProactiveJobs?.shift();")
        text = replace(text, '        const send = this.outbound.sendToChat(chatId, text, timing ? { ...options, replyTiming: timing } : options);', '''        const proactiveJobId = options.modelReply ? this.chats.get(chatId)?.proactiveJobId : undefined;
        const send = this.outbound.sendToChat(chatId, text, timing ? { ...options, replyTiming: timing } : options).then(ids => {
            if (proactiveJobId) for (const id of ids ?? []) noteProactiveSent(this, proactiveJobId, id);
            return ids;
        });''')
    elif name == 'inbound.js':
        text = replace(text, "import { renderProfileBlock } from './profiles.js';", "import { renderProfileBlock } from './profiles.js';\nimport { renderCommitments } from './companionship.js';")
        text = replace(text, '        const profileBlock = await renderProfileBlock(this.ctx.config.mediaDir, userId, nickname);', '        const profileBlock = await renderProfileBlock(this.ctx.config.mediaDir, userId, nickname);\n        const commitments = await renderCommitments(this.ctx.config.mediaDir, chatId, userId);\n        if (commitments) final = commitments + "\\n" + final;')
        text = replace(text, 'parts.push({ final, role, nickname, messageId:', 'parts.push({ final, role, nickname, userId, messageId:')
        text = replace(text, 'this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain, inbound.listeningRevision)', 'this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain, inbound.listeningRevision, userId)')
        text = replace(text, 'this.ctx.dispatchFollowup(chatId, final, role, nickname, inbound.listeningRevision)', 'this.ctx.dispatchFollowup(chatId, final, role, nickname, inbound.listeningRevision, userId)')
    elif name == 'tools.js':
        text = replace(text, "import { lookImage } from './vision.js';", "import { lookImage } from './vision.js';\nimport { proactiveTools } from './proactive.js';")
        text = replace(text, '    register(makeSelfExpressionTool(defineTool, bridge));', '    register(makeSelfExpressionTool(defineTool, bridge));\n    for (const tool of proactiveTools(defineTool, bridge)) register(tool);')
        text = replace(text, "import { lookImage } from './vision.js';", "import { lookImage } from './vision.js';\nimport { creativeTools } from './creative.js';")
        text = replace(text, '    register(makeSelfExpressionTool(defineTool, bridge));', '    register(makeSelfExpressionTool(defineTool, bridge));\n    for (const tool of creativeTools(defineTool, bridge)) register(tool);')
        text = replace(text, "import { lookImage } from './vision.js';", "import { lookImage } from './vision.js';\nimport { companionshipTools, relayText, requireOpportunity } from './companionship.js';")
        text = replace(text, '    register(makeSelfExpressionTool(defineTool, bridge));', '    register(makeSelfExpressionTool(defineTool, bridge));\n    for (const tool of companionshipTools(defineTool, bridge)) register(tool);')
        text = replace(text, "import { lookImage } from './vision.js';", "import { lookImage } from './vision.js';\nimport { makeHelperTool } from './helper.js';")
        text = replace(text, '    for (const tool of companionshipTools(defineTool, bridge)) register(tool);', '''    for (const tool of companionshipTools(defineTool, bridge)) register(tool);
    register(makeHelperTool(defineTool, bridge, helperCtx => registerTools({ tools: { register: tool =>
        ['web_search', 'web_fetch'].includes(tool.name) ? helperCtx.tools.register(tool) : () => {}
    } }, bridge, connection, limits)));''')
    elif name == 'outbound.js':
        text = replace(text, "            const reject = this.writeGateRejectReason(chatId, 'send_msg');", """            const conversationalMedia = segments.some(s => ['image','record','face','mface'].includes(s.type))
                && segments.every(s => ['text','image','record','face','mface'].includes(s.type));
            const reject = conversationalMedia ? null : this.writeGateRejectReason(chatId, 'send_msg');""")
    return text

def main():
    edits = {}
    proactive_only = '--proactive-only' in sys.argv
    for name in (['bridge.js','tools.js'] if proactive_only else ['bridge.js','inbound.js','tools.js','outbound.js']):
        path = LIB/name
        raw = path.read_bytes()
        edits[path] = expected(name, raw.decode('utf8').replace('\r\n','\n')).replace('\n', '\r\n' if b'\r\n' in raw else '\n').encode('utf8')
    edits[LIB/'proactive.js'] = (MODULES/'onebot_proactive.js').read_bytes()
    if not proactive_only:
        for name in ['companionship', 'helper', 'singing', 'songbook', 'creative']:
            edits[LIB/(name+'.js')] = (MODULES/('onebot_'+name+'.js')).read_bytes()
    if '--check' in sys.argv:
        ok = all(p.exists() and p.read_bytes() == data for p,data in edits.items())
        print('companionship: ' + ('OK' if ok else 'OUT OF SYNC')); return 0 if ok else 1
    for path,data in edits.items(): path.write_bytes(data)
    print('companionship installed; restart DSH')
    return 0
if __name__ == '__main__': raise SystemExit(main())
