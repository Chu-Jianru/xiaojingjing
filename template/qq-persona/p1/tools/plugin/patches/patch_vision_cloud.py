"""v2.52: let the vision sidecar use a cloud model (OpenAI Chat Completions).

Local ONNX Qwen2-VL-2B stays as the fallback. Env:
  DSH_VISION_CLOUD=1
  DSH_VISION_BASE=https://llmapi.paratera.com/v1
  DSH_VISION_API_KEY=sk-...
  DSH_VISION_MODEL=GLM-4V-Flash
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
TARGET = REPO / "qq-persona" / "p1" / "tools" / "ops" / "vision-sidecar.mjs"
MARK = "// [dsh-p1] v2.52"

CLOUD_BLOCK = """
// [dsh-p1] v2.52: 云视觉。DSH_VISION_CLOUD=1 时优先走云端 OpenAI 兼容接口，
// 本地 Qwen2-VL 只当兜底；不设这个变量就和原来完全一样。
const CLOUD = {
    enabled: String(process.env.DSH_VISION_CLOUD ?? '') === '1',
    base: String(process.env.DSH_VISION_BASE ?? '').replace(/\\/+$/, ''),
    key: String(process.env.DSH_VISION_API_KEY ?? ''),
    model: String(process.env.DSH_VISION_MODEL ?? 'GLM-4V-Flash'),
    timeoutMs: Number(process.env.DSH_VISION_CLOUD_TIMEOUT_MS ?? 60_000),
};
const CLOUD_MEMO = new Map();
const CLOUD_PROMPT = String(process.env.DSH_VISION_PROMPT ?? '') ||
    '看这张图，用中文说清楚：画面是什么、图里有什么字（原样念出来）、氛围或梗是什么。'
    + '不超过 120 字，不要客套，不要复述问题。';

async function cloudDescribe(path) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path);
    if (buf.length > 8 * 1024 * 1024)
        throw new Error('image too large (>8MB)');
    const ext = String(path).split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif' : 'image/png';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLOUD.timeoutMs);
    timer.unref?.();
    try {
        const res = await fetch(CLOUD.base + '/chat/completions', {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CLOUD.key },
            body: JSON.stringify({
                model: CLOUD.model,
                max_tokens: 260,
                temperature: 0.3,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: CLOUD_PROMPT },
                        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } },
                    ],
                }],
            }),
        });
        const text = await res.text();
        if (!res.ok)
            throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 120));
        const json = JSON.parse(text);
        const answer = json?.choices?.[0]?.message?.content;
        if (!answer)
            throw new Error('empty answer');
        return String(answer).trim().slice(0, 600);
    }
    finally {
        clearTimeout(timer);
    }
}
"""

BRANCH = """
        if (CLOUD.enabled && CLOUD.base !== '' && CLOUD.key !== '') {
            const memo = CLOUD_MEMO.get(key);
            if (memo !== undefined)
                return { text: memo };
            if (!wait)
                return { pending: true };
            try {
                const text = await cloudDescribe(path);
                CLOUD_MEMO.set(key, text);
                if (CLOUD_MEMO.size > VISION_CACHE_LIMIT)
                    CLOUD_MEMO.delete(CLOUD_MEMO.keys().next().value);
                log('cloud vision ok (' + CLOUD.model + '): ' + text.slice(0, 60));
                return { text };
            }
            catch (error) {
                log('cloud vision failed: ' + String(error?.message ?? error) + ' — fallback to local');
            }
        }
"""


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    if MARK in text:
        print("vision-sidecar.mjs: already patched (v2.52)")
        return 0
    anchor_const = "export const VISION_CACHE_LIMIT = 200;"
    if anchor_const not in text:
        print("anchor missing: VISION_CACHE_LIMIT")
        return 2
    text = text.replace(anchor_const, anchor_const + "\n" + CLOUD_BLOCK, 1)
    anchor_desc = "    const cache = await readCache();"
    if anchor_desc not in text:
        print("anchor missing: readCache")
        return 2
    text = text.replace(anchor_desc, BRANCH + anchor_desc, 1)
    io.open(TARGET, "w", encoding="utf-8", newline="\n").write(text)
    print("vision-sidecar.mjs: cloud branch installed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
