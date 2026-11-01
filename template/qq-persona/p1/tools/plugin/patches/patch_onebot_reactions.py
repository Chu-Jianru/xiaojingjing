"""v2.34: contextual reactions, real text captions, and a per-chat anti-loop guard."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
LIB = REPO / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SRC = Path(__file__).resolve().parent.parent / 'modules/onebot_reactions.js'
DEST = LIB / 'reactions.js'

MODE = """            response_mode: {
                type: 'string', enum: ['with_text', 'reaction_only', 'requested'],
                description: '表情回复先判断语境：with_text=本轮需要回答/确认/纠正/接话，caption写真正要回的话；reaction_only=纯情绪反应确实足够；requested=对方仅要图或表情，同时要你说话时仍用with_text。',
            },
"""

IMAGE = """    register(defineTool({
        name: 'qq_send_image',
        description: '发送图片。普通截图/资料图最多9张；自己的表情包只是点缀。该说话时用with_text并把实质回复写进caption；只有纯情绪反应才reaction_only，明确索图才requested。sent=false表示没发，继续用自己的话接住内容，不用别的表情工具绕过。',
        parameters: {
            sources: { type: 'array', items: { type: 'string' }, required: true, description: '本地绝对路径或http(s) URL；普通表情反应最多一张' },
            chat_id: { type: 'string', description: '目标会话，省略为当前会话' },
            as_sticker: { type: 'boolean', description: '从QQ收藏夹取出的表情URL填true，按表情消息发送；普通照片不填' },
            caption: { type: 'string', description: '需要文字时，这里写本轮真正想回对方的话，与图一起发；不是图片旁白，已发的文字最终回复不重复' },
MODE        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = reactionArgs(args, stripMarkerResidue);
            const sources = Array.isArray(a.sources) ? a.sources.filter(s => typeof s === 'string') : [];
            if (sources.length === 0 || sources.length > 9) throw new Error('qq_send_image: sources须有1至9张图片');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const send = async () => {
                const allowedRoots = await mediaRoots(bridge, exec);
                const segments = [];
                if (typeof a.caption === 'string' && a.caption.trim() !== '')
                    segments.push({ type: 'text', data: { text: a.caption } });
                for (const source of sources) {
                    const extra = a.as_sticker === true || isStickerSource(source) ? { sub_type: 1 } : {};
                    segments.push({ type: 'image', data: isUrl(source)
                        ? { url: source, ...extra }
                        : { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots), ...extra } });
                }
                return await bridge.sendSegments(chatId, segments);
            };
            const count = a.as_sticker === true ? sources.length : sources.filter(isStickerSource).length;
            if (count) return await sendReaction(bridge, chatId, a, send, sources.length, { ownerRequested: isReactionOwnerTurn(bridge, exec.agent?.session.id) });
            const id = await send();
            return { sent: true, textSent: typeof a.caption === 'string' && a.caption.trim() !== '', messageId: id ?? null };
        },
    }));
""".replace('MODE', MODE)

FACE = """    register(defineTool({
        name: 'qq_send_face',
        description: '发QQ原生/超级表情，只作语境合适的点缀。先判断：需要回答、确认、纠正或接一句话时用with_text并写caption实质回复；纯情绪反应才reaction_only，明确索表情才requested。sent=false表示没有发，按内容自行说话，不能只发[不回]掩盖漏答，也不换另一种表情绕过。',
        parameters: {
            id: { type: 'number', description: '经典表情编号' },
            emoji_id: { type: 'string', description: '超级表情emoji_id' },
            emoji_package_id: { type: 'string', description: '超级表情包id' },
            key: { type: 'string' },
            summary: { type: 'string' },
            caption: { type: 'string', description: '本轮需要回应的具体内容，与表情一起发，最终回复不重复已发送文字' },
MODE        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = reactionArgs(args, stripMarkerResidue);
            const chatId = resolveChat(bridge, exec, undefined);
            return await sendReaction(bridge, chatId, a, async () => {
                const segment = typeof a.emoji_id === 'string' && a.emoji_id !== ''
                    ? { type: 'mface', data: { emoji_id: a.emoji_id, emoji_package_id: String(a.emoji_package_id ?? ''), key: String(a.key ?? ''), summary: String(a.summary ?? '') } }
                    : { type: 'face', data: { id: String(a.id ?? 14) } };
                const segments = typeof a.caption === 'string' && a.caption.trim() !== ''
                    ? [{ type: 'text', data: { text: a.caption } }, segment] : [segment];
                return await bridge.sendSegments(chatId, segments);
            }, 1, { ownerRequested: isReactionOwnerTurn(bridge, exec.agent?.session.id) });
        },
    }));
""".replace('MODE', MODE)


def put(text: str, old: str, new: str, marker: str) -> str:
    if marker in text: return text
    if text.count(old) != 1: raise SystemExit('reaction hook mismatch: ' + marker)
    return text.replace(old, new, 1)


def expected(path: Path) -> str:
    text = path.read_text(encoding='utf-8')
    if path.name == 'tools.js':
        # The old renderer said "sent" for EVERY value, even sent=false, hiding
        # refusals and textSent from the model and encouraging a final [不回].
        text, count = re.subn(
            r"function sendOutput\(\) \{.*?\n\}\n(?=/\*\* Resolve the target)",
            "function sendOutput() {\n    return { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }] };\n}\n",
            text, flags=re.S)
        if count != 1: raise SystemExit('reaction sendOutput hook mismatch')
        anchor = "import { lookImage } from './vision.js';"
        text = text.replace("import { isAdminTurn } from './agent-api.js';\n", '')
        old_import = "import { sendReaction, isStickerSource } from './reactions.js';"
        imports = "import { sendReaction, isStickerSource, reactionArgs } from './reactions.js';\nimport { stripMarkerResidue } from './outbound.js';\nimport { isAdminTurn as isReactionOwnerTurn } from './agent-api.js';"
        if "import { sendReaction, isStickerSource, reactionArgs } from './reactions.js';" in text and "import { isAdminTurn as isReactionOwnerTurn } from './agent-api.js';" not in text:
            text = text.replace("import { stripMarkerResidue } from './outbound.js';", "import { stripMarkerResidue } from './outbound.js';\nimport { isAdminTurn as isReactionOwnerTurn } from './agent-api.js';", 1)
        if old_import in text: text = text.replace(old_import, imports, 1)
        text = put(text, anchor, anchor + '\n' + imports, imports)
        for name, block in [('qq_send_image', IMAGE), ('qq_send_face', FACE)]:
            pattern = r"    register\(defineTool\(\{\n        name: '" + name + r"',.*?\n    \}\)\);\n"
            text, count = re.subn(pattern, lambda _: block, text, flags=re.S)
            if count != 1: raise SystemExit('reaction tool mismatch: ' + name)
    elif path.name == 'bridge.js':
        text = '\n'.join(line for line in text.split('\n') if 'reactionHint: (chatId, isOwner' not in line)
        text = text.replace('reactionHint: chatId => reactionPolicy(this).hint(chatId),', "reactionHint: (chatId, isOwner = false) => isOwner ? '' : reactionPolicy(this).hint(chatId),")
        anchor = "import { CatchUp } from './catchup.js';"
        text = put(text, anchor, anchor + "\nimport { reactionPolicy } from './reactions.js';", "import { reactionPolicy }")
        anchor = '            recordSent: (chatId, id) => this.lastSentByChat.set(chatId, String(id)),'
        text = put(text, anchor, anchor + '\n            onTextSent: (chatId, segments) => reactionPolicy(this).noteText(chatId, segments),', 'onTextSent: (chatId, segments) =>')
        anchor = '            observeJournal: inbound => observeJournal(this, inbound),'
        text = put(text, anchor, anchor + "\n            reactionHint: (chatId, isOwner = false) => isOwner ? String() : reactionPolicy(this).hint(chatId),", "reactionHint: (chatId, isOwner")
        anchor = "        if (event.type === 'turn/start') {"
        text = put(text, anchor, anchor + '\n            reactionPolicy(this).beginTurn(chatId);', 'reactionPolicy(this).beginTurn(chatId);')
    elif path.name == 'outbound.js':
        anchor = "        const data = await this.ctx.call('send_msg', params, chatId);"
        text = put(text, anchor, anchor + '\n        this.ctx.onTextSent?.(chatId, segments);', 'this.ctx.onTextSent?.(chatId, segments);')
    elif path.name == 'inbound.js':
        text = text.replace('this.ctx.reactionHint?.(chatId)', 'this.ctx.reactionHint?.(chatId, isAdmin)')
        anchor = "        // [dsh-p1] rules: trusted instructions the admin set through chat."
        addition = """        // [dsh-p1] reaction context: break repeated face/sticker-only replies.
        const reactionHint = this.ctx.reactionHint?.(chatId, isAdmin) ?? '';
        if (reactionHint !== '') final = reactionHint + '\\n' + final;
"""
        text = put(text, anchor, addition + anchor, 'const reactionHint = this.ctx.reactionHint?.(chatId, isAdmin)')
    return text


def apply() -> None:
    edits = {LIB / n: expected(LIB / n) for n in ['tools.js', 'bridge.js', 'outbound.js', 'inbound.js']}
    DEST.write_text(SRC.read_text(encoding='utf-8'), encoding='utf-8')
    for p, text in edits.items():
        if text != p.read_text(encoding='utf-8'):
            newline = '\r\n' if b'\r\n' in p.read_bytes() else '\n'
            p.write_text(text, encoding='utf-8', newline=newline)
    print('contextual reaction hooks installed; restart DSH')


def check() -> bool:
    return DEST.exists() and DEST.read_text(encoding='utf-8') == SRC.read_text(encoding='utf-8') and all(
        (LIB / n).read_text(encoding='utf-8') == expected(LIB / n) for n in ['tools.js', 'bridge.js', 'outbound.js', 'inbound.js'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        ok = check()
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    apply()
