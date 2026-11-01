"""v2.56: let her put a picture into QQ's 「喜爱」 (favourite stickers).

NapCat exposes `add_custom_face {file}` — verified live: it returns
`{result:0,isExist:0}` and `fetch_custom_face` then lists the new qpic URL,
which is exactly the heart tab in QQ's sticker panel. So the tool is a thin
wrapper, plus a download step for http(s) sources.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
TARGET = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib" / "tools.js"
MARK = "// -- [dsh-p1] v2.56: qq_add_sticker"

OLD_IMPORT = "import { appendFile, mkdir, readFile } from 'node:fs/promises';"
NEW_IMPORT = "import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';"

BLOCK = r"""    // -- [dsh-p1] v2.56: qq_add_sticker（收进 QQ「喜爱」表情）--
    register(defineTool({
        name: 'qq_add_sticker',
        description: '把一张图收进 QQ 的「喜爱」表情（表情面板里那个爱心页）。老大说“收起来/存表情/加进喜爱”，或者你自己觉得这张图以后还想用，就调它。file 填本地绝对路径或 http(s) 图片链接。',
        parameters: {
            file: { type: 'string', required: true, description: '本地绝对路径，或 http(s) 图片地址' },
            meaning: { type: 'string', description: '自己已看懂的含义和适用情绪，最多160字；不知道留空，不猜' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}) }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const src = String(args?.file ?? '').trim();
            if (src === '')
                throw new Error('qq_add_sticker: file 不能为空');
            const allowedRoots = await mediaRoots(bridge, exec);
            const target = await prepareSticker(src, bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK,
                (path, max) => fencedMediaFile(path, max, allowedRoots));
            const data = await connection.call('add_custom_face', { file: target });
            if (Number(data?.result) !== 0) throw new Error('qq_add_sticker: 未取得成功结果');
            await rememberFavorite(bridge.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK, target, args?.meaning, src);
            return {
                ok: true,
                already: Number(data?.isExist ?? 0) === 1,
                file: target,
            };
        },
    }));
"""


def main() -> int:
    raw = TARGET.read_bytes()
    text = raw.decode('utf8').replace('\r\n', '\n')
    imp = "import { prepareSticker } from './sticker-input.js';"
    if imp not in text: text = text.replace("import { lookImage } from './vision.js';", "import { lookImage } from './vision.js';\n" + imp, 1)
    if OLD_IMPORT not in text and NEW_IMPORT not in text:
        print("import anchor missing")
        return 2
    text = text.replace(OLD_IMPORT, NEW_IMPORT, 1)
    anchor = "    // -- [dsh-p1] v2.53: web_search / web_fetch"
    if anchor not in text:
        anchor = "    // -- [dsh-p1] long-term memory --"
    if anchor not in text:
        print("tool anchor missing")
        return 2
    if MARK in text:
        start = text.index('    ' + MARK)
        text = text[:start] + BLOCK + text[text.index(anchor,start):]
    else:
        text = text.replace(anchor, BLOCK + anchor, 1)
    new = text.replace('\n', '\r\n' if b'\r\n' in raw else '\n').encode('utf8')
    modules = Path(__file__).resolve().parent.parent / 'modules'
    sources = [('onebot_sticker_input.js','sticker-input.js'),('onebot_public_fetch.js','public-fetch.js')]
    if '--check' in sys.argv:
        ok = raw == new and all((TARGET.parent / d).exists() and (TARGET.parent / d).read_bytes() == (modules / s).read_bytes() for s,d in sources)
        print('patched' if ok else 'NOT patched')
        return 0 if ok else 1
    TARGET.write_bytes(new)
    for s,d in sources: (TARGET.parent / d).write_bytes((modules / s).read_bytes())
    print("tools.js: qq_add_sticker installed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
