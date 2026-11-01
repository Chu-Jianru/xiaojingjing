// 重建表情包指纹索引（含 OCR 文本，用于近似图消歧）
// 跑法：node tools\stickers\build_sticker_index.mjs
// 需要 QQ/NapCat 在线（走 OneBot HTTP 3000 的 ocr_image）；离线时会只建指纹、OCR 为空。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = (() => {
    let d = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(d, 'bot-home')) && existsSync(join(d, 'qq-persona'))) return d;
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    return d;
})();

const LIB = join(REPO, 'bot-home', 'profiles', 'companion', 'node_modules', 'dsh-onebot-qq', 'lib');
const mediaDir = join(REPO, 'bot-home', 'media', 'onebot');
const personaDir = join(REPO, 'qq-persona', 'p1');
const CONFIG = process.env.NAPCAT_ONEBOT_CONFIG
    ?? 'C:/Users/USER/NapCat-p1/shell/versions/9.9.33-52230/resources/app/napcat/config/onebot11___BOT_QQ__.json';

let base = 'http://127.0.0.1:3000';
let token = String(process.env.NAPCAT_ONEBOT_TOKEN ?? '');
try {
    const config = JSON.parse(await readFile(CONFIG, 'utf8'));
    const http = (config.network?.httpServers ?? []).find(server => server.enable === true)
        ?? (config.network?.httpServers ?? [])[0];
    if (http !== undefined) {
        base = 'http://127.0.0.1:' + http.port;
        if (typeof http.token === 'string' && http.token !== '') token = http.token;
    }
}
catch { /* keep defaults */ }

async function ocrFile(path) {
    let body;
    try {
        body = JSON.stringify({ image: 'base64://' + (await readFile(path)).toString('base64') });
    }
    catch {
        return '';
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const response = await fetch(base + '/ocr_image', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token === '' ? {} : { Authorization: 'Bearer ' + token }),
                },
                body,
                signal: AbortSignal.timeout(20_000),
            });
            const json = await response.json();
            const list = Array.isArray(json?.data)
                ? json.data
                : (Array.isArray(json?.data?.texts) ? json.data.texts : []);
            return list
                .map(item => (typeof item === 'string' ? item : String(item?.text ?? '')))
                .join('\n');
        }
        catch {
            if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    return '';
}

const { buildStickerIndex } = await import(pathToFileURL(LIB + '/sticker-index.js').href);
const started = Date.now();
const index = await buildStickerIndex({ mediaDir, personaDir, ocr: ocrFile });
const withMeaning = index.items.filter(item => item.meaning !== '').length;
const withOcr = index.items.filter(item => item.ocrText !== '').length;
console.log('indexed ' + index.items.length + ' sticker(s), ' + withMeaning + ' with meaning, '
    + withOcr + ' with OCR text (' + Math.round((Date.now() - started) / 1000) + 's)');
console.log('written: ' + mediaDir + '/stickers/fingerprints.json');
