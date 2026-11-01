"""v2.59: downscale before uploading to the cloud vision model.

A 1154x1920 sticker took GLM-4V-Flash 35 s and blew past the 60 s cloud
timeout; 1024px max keeps the same readability at a fraction of the payload.
Uses Pillow when available (bundled runtime), silently falls back to the
original file when it is not.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
TARGET = REPO / "qq-persona" / "p1" / "tools" / "ops" / "vision-sidecar.mjs"
MARK = "// [dsh-p1] v2.59"

HELPER = r"""
// [dsh-p1] v2.59: 上传前缩到 1024 以内（1.15k×1.9k 的图要 35s，缩完 10s 级）
const SHRINK_MAX = Number(process.env.DSH_VISION_SHRINK_MAX ?? 1024);

async function shrinkForCloud(file) {
    const { spawnSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const targets = [
        process.env.DSH_VISION_PYTHON,
        'C:\\Users\\USER\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
        'python',
    ].filter(Boolean);
    const code = 'import sys\n'
        + 'from PIL import Image\n'
        + 'im = Image.open(sys.argv[1])\n'
        + 'im.thumbnail((int(sys.argv[3]), int(sys.argv[3])))\n'
        + 'im.convert("RGB").save(sys.argv[2], "JPEG", quality=85)\n';
    const out = join(tmpdir(), 'vision-shrink-' + process.pid + '-' + Date.now() + '.jpg');
    for (const python of targets) {
        try {
            const done = spawnSync(python, ['-c', code, file, out, String(SHRINK_MAX)], { timeout: 20_000, windowsHide: true });
            if (done.status === 0)
                return { file: out, mime: 'image/jpeg', temp: true };
        }
        catch { /* try next */ }
    }
    return { file, mime: null, temp: false };
}
"""

OLD = """    const ext = String(path).split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif' : 'image/png';"""

NEW = """    const ext = String(path).split('.').pop().toLowerCase();
    const shrink = await shrinkForCloud(path);
    let mime;
    if (shrink.temp) {
        const { readFile: readShrunk } = await import('node:fs/promises');
        buf = await readShrunk(shrink.file);
        mime = shrink.mime;
    }
    else {
        mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'webp' ? 'image/webp'
                : ext === 'gif' ? 'image/gif' : 'image/png';
    }"""


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    if MARK in text:
        print("already patched (v2.59)")
        return 0
    if OLD not in text:
        print("anchor missing")
        return 2
    text = text.replace("    const buf = await readFile(path);\n", "    let buf = await readFile(path);\n", 1)
    text = text.replace(OLD, NEW, 1)
    text = text.replace("export const VISION_CACHE_LIMIT = 200;", "export const VISION_CACHE_LIMIT = 200;\n" + HELPER, 1)
    io.open(TARGET, "w", encoding="utf-8", newline="\n").write(text)
    print("shrink installed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
