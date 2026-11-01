"""v2.53: give her a working web_search / web_fetch (no API key needed).

The bundled `web-search-deepseek` provider is unusable here: it targets
api.deepseek.com with a Paratera key (401), and Paratera's models accept the
`web_search` tool schema but never actually run it (verified: the model answers
“我无法直接实时搜索”). So the tools live where her other tools live — the
onebot plugin — and use public HTML instead of a paid search API.

Idempotent: re-running does nothing once the marker is present.
"""

from __future__ import annotations

import io
import sys
import argparse
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
TARGET = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib" / "tools.js"
MARK = "// -- [dsh-p1] v2.53: web_search / web_fetch"

BLOCK = r"""    // -- [dsh-p1] v2.53: web_search / web_fetch（不依赖任何 key，走公开 HTML）--
    register(defineTool({
        name: 'web_search',
        description: '联网搜索：查新闻、资料、具体数据、典故出处。返回标题/链接/摘要，最多 8 条；要看正文再用 web_fetch。闲聊和表情不用搜。',
        parameters: {
            query: { type: 'string', required: true, description: '搜索词，尽量具体（人名/事件/数字一起给）' },
            count: { type: 'number', description: '返回条数 1-8，默认 5' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') || '无结果' }],
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const a = args;
            const query = String(a.query ?? '').trim();
            if (query === '')
                throw new Error('web_search: query 不能为空');
            const want = Math.min(Math.max(Number.isFinite(a.count) ? Math.floor(a.count) : 5, 1), 8);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20_000);
            try {
                try {
                    const results = supportedSearchResults(query, await htmlSearch(query, want, ctrl.signal));
                    if (results.length) return results.map((item,index) => (index+1) + '. ' + item.title + '\n' + item.url + '\n' + item.snippet).join('\n\n');
                } catch { /* A failed/blocked HTML search may use the bounded RSS backup. */ }
                const res = await publicFetch('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&format=rss&setlang=zh-CN&mkt=zh-CN', {
                    signal: ctrl.signal,
                    headers: {
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                        'accept-language': 'zh-CN,zh;q=0.9',
                    },
                });
                if (!res.ok)
                    throw new Error('HTTP ' + res.status);
                const xml = await boundedWebBody(res);
                const decode = (s) => String(s)
                    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
                    .replace(/&[a-z#0-9]+;/gi, ' ')
                    .replace(/\s+/g, ' ').trim();
                const out = [];
                const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
                for (const chunk of items) {
                    if (out.length >= want)
                        break;
                    const title = decode((chunk.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '');
                    const url = decode((chunk.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? '');
                    const snippet = decode((chunk.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? '');
                    if (title === '' || url === '')
                        continue;
                    out.push({ title, url, snippet });
                }
                if (supportedSearchResults(query,out).length === 0)
                    return '搜索没有返回可用结果；请换关键词或明确说明没有查到，不要编造实时信息。';
                return out.map((item, index) => (index + 1) + '. ' + item.title + '\n' + item.url + '\n' + (item.snippet ? item.snippet.slice(0, 240) : '')).join('\n\n');
            }
            finally {
                clearTimeout(timer);
            }
        },
    }));
    register(defineTool({
        name: 'web_fetch',
        description: '抓取网页正文（纯文本，最多约 6000 字）。搜索看到想细读的链接再抓；不要用它抓搜索结果页。查天气直接抓 https://wttr.in/城市拼音?format=3，一行就有实时温度。',
        parameters: {
            url: { type: 'string', required: true, description: 'http(s) 网址' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const url = String(args?.url ?? '').trim();
            if (!/^https?:\/\//i.test(url))
                throw new Error('web_fetch: 只支持 http(s) 网址');
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20_000);
            try {
                const ua = /wttr\.in|wttr\.in\//i.test(url)
                    ? 'curl/8.0'
                    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
                const res = await publicFetch(url, {
                    signal: ctrl.signal,
                    headers: {
                        'user-agent': ua,
                        'accept-language': 'zh-CN,zh;q=0.9',
                    },
                });
                if (!res.ok)
                    throw new Error('HTTP ' + res.status);
                const type = String(res.headers.get('content-type') ?? '');
                if (!/text|json|xml|html/i.test(type))
                    throw new Error('不是文本页面：' + type);
                return extractWebText(await boundedWebBody(res), type, url);
            }
            finally {
                clearTimeout(timer);
            }
        },
    }));
"""


def expected(text: str) -> str:
    old_imp = "import { extractWebText, boundedWebBody } from './web-content.js';"
    imp = "import { extractWebText, boundedWebBody, htmlSearch, supportedSearchResults } from './web-content.js';"
    text = text.replace(old_imp, imp, 1).replace("import { extractWebText, boundedWebBody, fallbackSearch } from './web-content.js';", imp, 1)
    if imp not in text:
        anchor_import = "import { lookImage } from './vision.js';"
        if text.count(anchor_import) != 1: raise SystemExit('web content: import anchor mismatch')
        text = text.replace(anchor_import, anchor_import + '\n' + imp, 1)
    cache_import = "import { cachedWebTool } from './read-cache.js';"
    if cache_import not in text: text = text.replace(imp, imp + '\n' + cache_import, 1)
    public_import = "import { publicFetch } from './public-fetch.js';"
    if public_import not in text: text = text.replace(imp, imp + '\n' + public_import, 1)
    block = BLOCK.replace('register(defineTool({', 'register(cachedWebTool(defineTool({').replace('    }));', '    })));')
    anchor = "    // -- [dsh-p1] long-term memory --"
    if text.count(anchor) != 1:
        raise SystemExit('web tools: long-term memory anchor mismatch')
    if MARK in text:
        start = text.index('    ' + MARK)
        end = text.index(anchor, start)
        return text[:start] + block + text[end:]
    return text.replace(anchor, block + anchor, 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    raw = TARGET.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    text = raw.decode('utf-8').replace('\r\n', '\n')
    new = expected(text).replace('\n', newline).encode('utf-8')
    source = Path(__file__).resolve().parent.parent / 'modules/onebot_web_content.js'
    dest = TARGET.parent / 'web-content.js'
    cache_source = source.with_name('onebot_read_cache.js')
    cache_dest = dest.with_name('read-cache.js')
    public_source = source.with_name('onebot_public_fetch.js')
    public_dest = dest.with_name('public-fetch.js')
    if args.check:
        ok = new == raw and dest.exists() and source.read_bytes() == dest.read_bytes() and cache_dest.exists() and cache_dest.read_bytes() == cache_source.read_bytes() and public_dest.exists() and public_dest.read_bytes() == public_source.read_bytes()
        print('patched' if ok else 'NOT patched')
        return 0 if ok else 1
    dest.write_bytes(source.read_bytes())
    cache_dest.write_bytes(cache_source.read_bytes())
    public_dest.write_bytes(public_source.read_bytes())
    if new != raw:
        TARGET.write_bytes(new)
    print('tools.js: web_search + web_fetch current')
    return 0


if __name__ == "__main__":
    sys.exit(main())
