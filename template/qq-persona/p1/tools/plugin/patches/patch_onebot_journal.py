"""v2.33: event/mood-driven private diaries and autonomous Qzone posts.

Idempotent installation. Existing runtime settings are preserved. No network
write or model generation occurs while installing/checking this patch.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
LIB = REPO / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
MODULES = Path(__file__).resolve().parent.parent / 'modules'
SETTINGS = REPO / 'bot-home/media/onebot/journal-settings.json'

IMPORT_BRIDGE = "import { journalFor, observeJournal, journalSessionEvent, startJournal, stopJournal } from './journal-runner.js';"
IMPORT_TOOLS = "import { journalFor } from './journal-runner.js';\nimport { isOwnerJournalTurn, isOwnerStatusTurn } from './journal.js';"

TOOLS = """    // [dsh-p1] journal tools: owner DM only; automatic writing uses a separate session.
    const ownerJournal = exec => {
        if (!isOwnerJournalTurn(bridge, exec.agent?.session.id))
            throw new Error('journal_owner_private_only');
        if (bridge.deps.config.inject?.intercepting)
            throw new Error('journal_dry_run');
        return journalFor(bridge);
    };
    register(defineTool({
        name: 'qq_diary',
        description: '自己的本地私密日记。仅老大私聊可用；read看最近几篇，preview独立构思但不保存，write保存你已写好的正文。平时会按事件/心情/小概率自主考虑，不是每日任务，不把日记或私聊内容拿去群里/说说里复述，不固定报幕。',
        parameters: {
            action: { type: 'string', required: true, enum: ['read', 'preview', 'write'] },
            title: { type: 'string', description: '日记标题，可空' },
            text: { type: 'string', description: 'write时的日记正文，最多1200字，不凑长度' },
            limit: { type: 'number', description: 'read篇数，默认3，最多10' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args ?? {};
            const journal = ownerJournal(exec);
            if (a.action === 'read') return await journal.recent('diary', a.limit);
            if (a.action === 'preview') return await journal.preview('diary');
            if (a.action === 'write') return await journal.saveWriting('diary', { title: a.title, text: a.text });
            throw new Error('journal_action_invalid');
        },
    }));
    register(defineTool({
        name: 'qq_post_status',
        description: '自己的QQ空间说说，默认好友可见。老大在私聊/群聊要求发布不受自主次数与间隔限制；其他人也可以请求，结合关系、内容和自己的意愿决定，亲近的人更容易答应，非老大仍受发布节奏限制。preview构思不发，read仅查已公开记录，publish发布确定正文（最多180字），idea保存适合公开的自己的念头供平时自主分享，不立即发。不能泄露他人隐私、复制日记或编经历；只有published并有tid才算成功，unknown不重发。',
        parameters: {
            action: { type: 'string', required: true, enum: ['read', 'preview', 'publish', 'idea'] },
            text: { type: 'string', description: 'publish时的正文，不带内部说明和发送回执' },
            limit: { type: 'number', description: 'read条数，默认3，最多10' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args ?? {};
            const sessionId = exec.agent?.session.id;
            const chatId = bridge.chatForSession?.(sessionId);
            const chat = bridge.chats?.get(chatId);
            if (!chat || !['admin', 'member'].includes(chat.activeTurnRole)) throw new Error('status_chat_turn_required');
            if (bridge.deps.config.inject?.intercepting) throw new Error('journal_dry_run');
            const journal = journalFor(bridge);
            const ownerRequested = isOwnerStatusTurn(bridge, sessionId);
            if (a.action === 'read') return (await journal.recent('status', a.limit)).filter(e => e.status === 'published');
            if (a.action === 'preview') return await journal.preview('status');
            if (a.action === 'idea') return await journal.rememberIdea(a.text);
            if (a.action === 'publish') {
                await requireOpportunity(bridge, sessionId, 'status');
                return await journal.saveWriting('status', { text: a.text }, { ownerRequested, trigger: ownerRequested ? 'owner_request' : 'social_choice' });
            }
            throw new Error('journal_action_invalid');
        },
    }));
"""


def insert(text: str, anchor: str, replacement: str, marker: str) -> str:
    if marker in text:
        return text
    if text.count(anchor) != 1:
        raise SystemExit(f'journal patch: anchor not unique/found: {marker}')
    return text.replace(anchor, replacement, 1)


def expected(path: Path) -> str:
    text = path.read_text(encoding='utf-8')
    if path.name == 'bridge.js':
        anchor = "import { CatchUp } from './catchup.js';"
        text = insert(text, anchor, anchor + '\n' + IMPORT_BRIDGE, IMPORT_BRIDGE)
        anchor = '            interceptBusyTurn: (chatId, text, role, nickname, plain) => this.interceptBusyTurn(chatId, text, role, nickname, plain),'
        text = insert(text, anchor, anchor + '\n            observeJournal: inbound => observeJournal(this, inbound),', 'observeJournal: inbound =>')
        anchor = "            this.deps.log('info', 'bridge ready (' + this.registry.chats.size + ' resumed chat(s))');"
        text = insert(text, anchor, '            startJournal(this, createUserMessage);\n' + anchor, 'startJournal(this, createUserMessage);')
        anchor = '        this.stopping = true;'
        text = insert(text, anchor, anchor + '\n        await stopJournal(this);', 'await stopJournal(this);')
        anchor = '    onSessionEvent(session, event) {'
        text = insert(text, anchor, anchor + '\n        if (journalSessionEvent(this, session, event)) return;', 'journalSessionEvent(this, session, event)')
    elif path.name == 'inbound.js':
        anchor = '        const plain = inbound.media.length === 0 && inbound.replyId === undefined && inbound.forwardId === undefined;'
        text = insert(text, anchor, '        this.ctx.observeJournal?.(inbound);\n' + anchor, 'this.ctx.observeJournal?.(inbound);')
    elif path.name == 'tools.js':
        anchor = "import { lookImage } from './vision.js';"
        text = text.replace("import { isOwnerJournalTurn } from './journal.js';", "import { isOwnerJournalTurn, isOwnerStatusTurn } from './journal.js';")
        text = insert(text, anchor, anchor + '\n' + IMPORT_TOOLS, IMPORT_TOOLS)
        anchor = "    register(defineTool({\n        name: 'qq_napcat_api',"
        if "name: 'qq_diary'" in text:
            text, count = re.subn(r"    // \[dsh-p1\] journal tools:.*?name: 'qq_post_status',.*?\n    \}\)\);\n", lambda _: TOOLS, text, flags=re.S)
            if count != 1: raise SystemExit('journal tool migration mismatch')
        else:
            text = insert(text, anchor, TOOLS + anchor, "name: 'qq_diary'")
    return text


def check() -> bool:
    ok = True
    for source, target in [('onebot_journal.js', 'journal.js'), ('onebot_journal_runner.js', 'journal-runner.js')]:
        ok = ok and (LIB / target).exists() and (LIB / target).read_text(encoding='utf-8') == (MODULES / source).read_text(encoding='utf-8')
    for name in ['bridge.js', 'inbound.js', 'tools.js']:
        p = LIB / name
        ok = ok and p.read_text(encoding='utf-8') == expected(p)
    tools = (LIB / 'tools.js').read_text(encoding='utf-8')
    ok = ok and tools.count("name: 'qq_diary'") == 1 and tools.count("name: 'qq_post_status'") == 1
    try:
        c = json.loads(SETTINGS.read_text(encoding='utf-8'))
        ok = ok and isinstance(c.get('enabled'), bool)
    except (OSError, ValueError):
        ok = False
    return ok


def apply() -> None:
    # Validate all hooks before modifying any live file.
    edits = {LIB / name: expected(LIB / name) for name in ['bridge.js', 'inbound.js', 'tools.js']}
    for source, target in [('onebot_journal.js', 'journal.js'), ('onebot_journal_runner.js', 'journal-runner.js')]:
        (LIB / target).write_bytes((MODULES / source).read_bytes())
    for path, text in edits.items():
        if path.read_text(encoding='utf-8') != text:
            path.write_text(text, encoding='utf-8', newline='\r\n' if b'\r\n' in path.read_bytes() else '\n')
    if not SETTINGS.exists():
        SETTINGS.write_text((REPO / 'qq-persona/p1/journal-settings.json').read_text(encoding='utf-8'), encoding='utf-8')
    print('journal installed; restart DSH to activate')


def revert() -> None:
    # Remove only our exact hooks. Keep journals, settings and module files;
    # never restore a stale whole-file backup over later plugin changes.
    removals = {
        'bridge.js': [IMPORT_BRIDGE + '\n',
                      '            observeJournal: inbound => observeJournal(this, inbound),\n',
                      '            startJournal(this, createUserMessage);\n',
                      '        await stopJournal(this);\n',
                      '        if (journalSessionEvent(this, session, event)) return;\n'],
        'inbound.js': ['        this.ctx.observeJournal?.(inbound);\n'],
        'tools.js': [IMPORT_TOOLS + '\n', TOOLS],
    }
    for name, parts in removals.items():
        path = LIB / name
        text = path.read_text(encoding='utf-8')
        for part in parts:
            text = text.replace(part, '', 1)
        path.write_text(text, encoding='utf-8', newline='\r\n' if b'\r\n' in path.read_bytes() else '\n')
    print('journal hooks removed; saved writing preserved; restart DSH')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()
    if args.check:
        ok = check()
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    if args.revert:
        revert()
    else:
        apply()
