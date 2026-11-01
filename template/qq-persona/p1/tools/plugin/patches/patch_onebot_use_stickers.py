"""v2.58: let her use the stickers she collected (QQ 「喜爱」).

`fetch_custom_face` returns the favourite-sticker URLs (verified live: the qpic
URL added by `add_custom_face` shows up here). `qq_send_image` already accepts
http(s) sources, so listing is enough — she picks a URL and sends it.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
TARGET = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib" / "tools.js"
MARK = "// -- [dsh-p1] v2.58: qq_stickers"

BLOCK = r"""    // -- [dsh-p1] v2.58: qq_stickers（自己收藏的「喜爱」表情）--
    register(defineTool({
        name: 'qq_stickers',
        description: '按含义找自己的表情库（含呆猫八条），query写情绪/想表达的意思；返回meaning和path，用qq_send_image发送。source=favorites才查询QQ爱心页链接，未知含义的图先看懂再用。不必等索图命令。',
        parameters: {
            query: { type: 'string', description: '如 八条 委屈、开心、困惑、贴贴；默认按本地库列出少量' },
            source: { type: 'string', enum: ['library', 'favorites'], description: '默认library；favorites查询QQ收藏' },
            limit: { type: 'number', description: '默认8，最多12' },
            offset: { type: 'number', description: '收藏夹翻页起点；上次next_offset不为空时可继续找，不只看最前几张' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const limit = Math.min(Math.max(typeof args?.limit === 'number' ? Math.floor(args.limit) : 8, 1), 12);
            if (args?.source !== 'favorites') {
                const mediaDir = bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
                return { stickers: await findStickers(join(REPO, 'qq-persona/p1'), mediaDir, args?.query, limit) };
            }
            const data = await connection.call('fetch_custom_face', {});
            return await findFavorites(bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK, data, args?.query, limit, args?.offset);
        },
    }));
"""


def main() -> int:
    raw = TARGET.read_bytes()
    text = raw.decode('utf-8').replace('\r\n', '\n')
    original = text
    text = text.replace("import { findStickers } from './sticker-catalog.js';", "import { findStickers, findFavorites, rememberFavorite } from './sticker-catalog.js';")
    imp = "import { findStickers, findFavorites, rememberFavorite } from './sticker-catalog.js';"
    if imp not in text:
        text = text.replace("import { lookImage } from './vision.js';", "import { lookImage } from './vision.js';\n" + imp, 1)
    anchor = "    // -- [dsh-p1] v2.56: qq_add_sticker"
    if anchor not in text:
        print("anchor missing")
        return 2
    if MARK in text:
        start = text.index('    ' + MARK)
        text = text[:start] + BLOCK + text[text.index(anchor, start):]
    else:
        text = text.replace(anchor, BLOCK + anchor, 1)
    src = Path(__file__).resolve().parent.parent / 'modules/onebot_sticker_catalog.js'
    dest = TARGET.parent / 'sticker-catalog.js'
    new = text.replace('\n', '\r\n' if b'\r\n' in raw else '\n').encode('utf8')
    if '--check' in sys.argv:
        ok = raw == new and dest.exists() and dest.read_bytes() == src.read_bytes()
        print('patched' if ok else 'NOT patched')
        return 0 if ok else 1
    TARGET.write_bytes(new)
    dest.write_bytes(src.read_bytes())
    print("tools.js: qq_stickers semantic catalog installed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
