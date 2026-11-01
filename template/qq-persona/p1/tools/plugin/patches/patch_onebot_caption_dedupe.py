"""v2.74: retire cross-turn caption TTL; canonical modules own turn-scoped receipts.

--check is read-only. Reapplication preserves self-sleep and never reinstalls
the obsolete punctuation-insensitive two-minute reply filter.
"""

from __future__ import annotations

import io
import sys
import subprocess
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
LIB = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib"
TOOLS = LIB / "tools.js"
REPLY = LIB / "reply.js"

REMEMBER = """            if (typeof a.caption === 'string' && a.caption.trim() !== '') // [dsh-p1] v2.60
                bridge.__lastCaption = { chatId, text: a.caption.trim(), at: Date.now() };
"""

def main() -> int:
    # Retire the cross-turn TTL guard. Canonical modules own turn-scoped receipts
    # and self-sleep, so installers cannot overwrite either with a stale hook.
    raw = TOOLS.read_bytes()
    text = raw.decode('utf8').replace('\r\n', '\n')
    new = text.replace(REMEMBER, '').replace('\n', '\r\n' if b'\r\n' in raw else '\n').encode('utf8')
    checking = '--check' in sys.argv
    if checking and raw != new:
        print('legacy caption TTL hook still installed')
        return 1
    if not checking: TOOLS.write_bytes(new)
    for name in ['patch_onebot_chat_flow.py','patch_onebot_single_reply.py']:
        command = [sys.executable, str(Path(__file__).with_name(name))] + (['--check'] if checking else [])
        if subprocess.run(command).returncode: return 1
    print('turn-scoped caption receipts verified' if checking else 'turn-scoped caption receipts installed')
    return 0


if __name__ == "__main__":
    sys.exit(main())
