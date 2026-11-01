"""Deploy configurable expressive TTS + tool descriptions; --check / --revert."""
from __future__ import annotations
import argparse
from pathlib import Path
import re
import shutil
import sys

REPO = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir() and (p / 'qq-persona').is_dir())
LIB = REPO / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
SOURCE = Path(__file__).resolve().parents[1] / 'modules/onebot_tts.js'
DEST = LIB / 'tts.js'
TOOLS = LIB / 'tools.js'
BACKUP = DEST.with_suffix('.js.bak-voice')
TOOLS_BACKUP = TOOLS.with_suffix('.js.bak-tts-expressive')
DESCRIPTION = '向当前QQ会话发语音。text最多120字，沿用固定参考声线；锁定时不能用旧path换声。语音本身是回复，送达后不重复同句文字或发送确认；合成不可用时按语境用文字。'
VOICE = '通常省略，沿用用户固定的参考声线；锁定时不能临时换声，旧音色ID仅在配置允许换声时生效。'
UUID_IMPORT = "import { randomUUID as ttsUuid } from 'node:crypto';"
PATH_GUARD = """            // [dsh-p1] a locked self-voice cannot reuse an unrelated old recording.
            if (filePath !== '' && (await speechConfig()).voiceLocked) {
                if (typeof a.text === 'string' && a.text.trim() !== '') filePath = '';
                else throw new Error('qq_send_voice: 固定声线请提供text；转发原录音应使用转发工具');
            }
"""


def updated_tools(text):
    start = text.index("        name: 'qq_send_voice',")
    end = text.index("        name: 'qq_send_video',", start)
    block = text[start:end]
    block, n = re.subn(r"description: '[^'\n]*',", "description: '" + DESCRIPTION + "',", block, count=1)
    if n != 1: raise SystemExit('qq_send_voice description anchor missing')
    block, n = re.subn(r"voice: \{ type: 'string', description: '[^'\n]*' \}",
                       "voice: { type: 'string', description: '" + VOICE + "' }", block, count=1)
    if n != 1: raise SystemExit('qq_send_voice voice anchor missing')
    block = block.replace("'tts-' + Date.now() + '.mp3'", "'tts-' + Date.now() + '-' + ttsUuid() + '.mp3'")
    if '// [dsh-p1] a locked self-voice' not in block:
        anchor = '            let synthesized = false;'
        if block.count(anchor) != 1: raise SystemExit('qq_send_voice path guard anchor missing')
        block = block.replace(anchor, PATH_GUARD + anchor, 1)
    text = text[:start] + block + text[end:]
    text = text.replace("import { synthesizeSpeech } from './tts.js';", "import { synthesizeSpeech, speechConfig } from './tts.js';", 1)
    if UUID_IMPORT not in text:
        text = text.replace("import { synthesizeSpeech, speechConfig } from './tts.js';", "import { synthesizeSpeech, speechConfig } from './tts.js';\n" + UUID_IMPORT, 1)
    if UUID_IMPORT not in text or "Date.now() + '-' + ttsUuid()" not in text:
        raise SystemExit('qq_send_voice filename/import anchor missing')
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--revert', action='store_true')
    args = parser.parse_args()
    if args.revert:
        if BACKUP.exists(): shutil.copyfile(BACKUP, DEST)
        if TOOLS_BACKUP.exists(): shutil.copyfile(TOOLS_BACKUP, TOOLS)
        return
    old = TOOLS.read_text(encoding='utf-8')
    new = updated_tools(old)
    if args.check:
        ok = DEST.read_bytes() == SOURCE.read_bytes() and old == new
        print('patched' if ok else 'TTS patch needs refresh')
        sys.exit(0 if ok else 1)
    if not BACKUP.exists(): shutil.copyfile(DEST, BACKUP)
    if not TOOLS_BACKUP.exists(): shutil.copyfile(TOOLS, TOOLS_BACKUP)
    if old != new:
        newline = '\r\n' if b'\r\n' in TOOLS.read_bytes() else '\n'
        TOOLS.write_text(new, encoding='utf-8', newline=newline)
    shutil.copyfile(SOURCE, DEST)
    print('tts.js installed; qq_send_voice descriptions and unique filenames refreshed')


if __name__ == '__main__':
    main()
