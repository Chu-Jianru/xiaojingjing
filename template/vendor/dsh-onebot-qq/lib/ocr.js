/**
 * [dsh-p1] 图片 OCR：把本地图片交给 NapCat 的 `ocr_image`，拿回图里的文字。
 *
 * NapCat 不同版本的返回形状不一样：
 *   - OneBot HTTP 代理：{ status, retcode, data: [{ text, ... }] }
 *   - 插件连接层：data 可能已经是数组，或 { texts: [...] }
 * 所以这里统一解析成一段文本，解析器单独导出方便单测。
 *
 * 失败/超时/空文本都返回 ''（调用方决定要不要说「没看清」），不抛给聊天。
 */

import { readFile, stat } from 'node:fs/promises';

export const OCR_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const OCR_DEFAULT_TIMEOUT_MS = 12_000;

/** 从各种返回形状里提取文字（纯函数）。 */
export function ocrTextFromResponse(response) {
    let list = [];
    if (Array.isArray(response)) {
        list = response;
    }
    else if (Array.isArray(response?.texts)) {
        list = response.texts;
    }
    else if (Array.isArray(response?.data)) {
        list = response.data;
    }
    else if (Array.isArray(response?.data?.texts)) {
        list = response.data.texts;
    }
    const seen = new Set();
    const lines = [];
    for (const item of list) {
        const text = (typeof item === 'string' ? item : String(item?.text ?? ''))
            .replace(/\s+/g, ' ')
            .trim();
        if (text === '') continue;
        // OCR 对同一行可能多给几个空格，去重键忽略所有空白。
        const key = text.replace(/\s+/g, '');
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(text);
    }
    return lines.join('\n');
}

/**
 * OCR 一张本地图片。
 * @param {{path:string, call:(action:string,params:object)=>Promise<any>, maxBytes?:number, timeoutMs?:number}} options
 * @returns {Promise<string>} 识别出的文字（可能为空）
 */
export async function ocrImageFile(options) {
    const path = String(options?.path ?? '');
    if (path === '') throw new Error('ocr: path 不能为空');
    const maxBytes = Number(options?.maxBytes) > 0 ? Number(options.maxBytes) : OCR_DEFAULT_MAX_BYTES;
    const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : OCR_DEFAULT_TIMEOUT_MS;
    const info = await stat(path);
    if (info.size > maxBytes) throw new Error('ocr: 图片太大（' + info.size + '）');
    const data = await readFile(path);
    const call = options.call;
    if (typeof call !== 'function') throw new Error('ocr: call 未接线');
    let timer;
    try {
        const response = await Promise.race([
            call('ocr_image', { image: 'base64://' + data.toString('base64') }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('ocr: 超时 ' + timeoutMs + 'ms')), timeoutMs);
            }),
        ]);
        return ocrTextFromResponse(response);
    }
    finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
