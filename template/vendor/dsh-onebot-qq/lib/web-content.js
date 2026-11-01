/** Reader extraction is local: scripts never execute and no second model is used. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {publicFetch,publicUrl} from './public-fetch.js';
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'bot-home')) && dirname(root) !== root) root = dirname(root);
const require = createRequire(join(root, 'bot-home/web-runtime/package.json'));
let parser;
function libraries() {
    return parser ??= { Readability: require('@mozilla/readability').Readability, parseHTML: require('linkedom').parseHTML };
}
export function extractWebText(raw, type = 'text/html', url = '') {
    if (!/html/i.test(type)) return String(raw).trim().slice(0, 6000);
    const { Readability, parseHTML } = libraries();
    const html = /<body\b/i.test(raw) ? raw
        : '<html><body>' + raw.replace(/<\/?html[^>]*>/gi, '') + '</body></html>';
    const { document } = parseHTML(html);
    for (const node of document.querySelectorAll('script,style,noscript,template,svg,nav,footer,form')) node.remove();
    // linkedom does not fetch resources, run scripts or create a browser window.
    let article;
    try { article = new Readability(document.cloneNode(true), { charThreshold: 120, maxElemsToParse: 30_000 }).parse(); }
    catch { /* Short pages / non-article structures use their remaining text. */ }
    const body = article?.textContent?.trim() || document.querySelector('article,main')?.textContent || document.body?.textContent || document.textContent || '';
    return body.replace(/\s+/g, ' ').trim().slice(0, 6000);
}

export async function boundedWebBody(response, max = 2_000_000) {
    if (Number(response.headers.get('content-length')) > max) throw new Error('web_body_too_large');
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = []; let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > max) throw new Error('web_body_too_large');
            chunks.push(Buffer.from(value));
        }
    }
    finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
}

export async function htmlSearch(query, limit, signal) {
    const response = await publicFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
        {signal,headers:{'user-agent':'Mozilla/5.0'}});
    if (!response.ok) throw new Error('search_html_http_' + response.status);
    const {document} = libraries().parseHTML(await boundedWebBody(response));
    const rows = [];
    for (const anchor of document.querySelectorAll('a.result__a')) {
        try {
            const redirect = new URL(anchor.getAttribute('href'),'https://html.duckduckgo.com');
            const url = publicUrl(redirect.searchParams.get('uddg') || redirect.href).href;
            const title = anchor.textContent.replace(/\s+/g,' ').trim().slice(0,160);
            const snippet = anchor.closest('.result')?.querySelector('.result__snippet')?.textContent?.replace(/\s+/g,' ').trim().slice(0,240) || '';
            if (title && !rows.some(row => row.url===url)) rows.push({title,url,snippet});
            if (rows.length>=limit) break;
        } catch { /* Invalid search result links are data, not executable input. */ }
    }
    return rows;
}

export function supportedSearchResults(query, rows) {
    // Some RSS edge responses carry unrelated cached items. Obvious unsupported
    // Latin proper names must not be presented as a successful factual search.
    const terms=(query.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)||[])
        .filter(term=>!['what','when','where','which','with','this','that','from','about','please','github','official','search'].includes(term));
    if (!terms.length) return rows;
    const support=rows.some(row=>terms.some(term=>(row.title+' '+row.snippet+' '+row.url).toLowerCase().includes(term)));
    return support ? rows : [];
}
