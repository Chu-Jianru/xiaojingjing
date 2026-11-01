"""v2.48: make the "just put to bed" prompt note reachable.

inbound.js used to build the sleep note like this:

    let sleepNote = '';
    if (sleepPhase !== 'asleep') {
        if (sleepPhase === 'asleep' && justSlept)
            sleepNote = '（回一句晚安就安静，不用长）';

The inner test can never be true inside `sleepPhase !== 'asleep'`, so the one
turn that runs while asleep (the goodnight turn) never got the hint and she
wrote a normal-length reply instead of a short goodnight. Hoisting the
`asleep` case out of the guard fixes it, and the noSleepUntil / wokenAt /
wakeAt hints keep working for awake turns.

Idempotent. Run after any `dsh plugin ... update/install`, then restart DSH:

  python tools/plugin/patches/patch_onebot_inbound_sleep_note.py
  python tools/plugin/patches/patch_onebot_inbound_sleep_note.py --check
  python tools/plugin/patches/patch_onebot_inbound_sleep_note.py --revert
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
TARGET = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib" / "inbound.js"
MARK = "// [dsh-p1] v2.48"

OLD = """        let sleepNote = '';
        if (sleepPhase !== 'asleep') {
            if (sleepPhase === 'asleep' && justSlept)
                sleepNote = '（回一句晚安就安静，不用长）';
            else if (Number(sleepNow.noSleepUntil) > Date.now())
                sleepNote = '（老大说今天不睡，少提困）';
            else if (Number(sleepNow.wokenAt) > 0 && Date.now() - Number(sleepNow.wokenAt) < 30 * 60_000)
                sleepNote = '（刚被叫醒，可以迷糊、说困）';
            else if (Number(sleepNow.wakeAt) > 0 && Date.now() - Number(sleepNow.wakeAt) > 3 * 3_600_000)
                sleepNote = '（醒挺久了，可以说想睡，也可以不说）';
        }"""

NEW = """        let sleepNote = '';
        // [dsh-p1] v2.48: 原来这段嵌在 sleepPhase !== 'asleep' 里，永远进不来，
        // 睡前那一轮反而拿不到「回一句晚安就安静」，于是她照样写一长段。
        if (sleepPhase === 'asleep') {
            if (justSlept)
                sleepNote = '（回一句晚安就安静，不用长）';
        }
        else if (Number(sleepNow.noSleepUntil) > Date.now())
            sleepNote = '（老大说今天不睡，少提困）';
        else if (Number(sleepNow.wokenAt) > 0 && Date.now() - Number(sleepNow.wokenAt) < 30 * 60_000)
            sleepNote = '（刚被叫醒，可以迷糊、说困）';
        else if (Number(sleepNow.wakeAt) > 0 && Date.now() - Number(sleepNow.wakeAt) > 3 * 3_600_000)
            sleepNote = '（醒挺久了，可以说想睡，也可以不说）';"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    if not TARGET.exists():
        print(f"missing: {TARGET}")
        return 2
    text = TARGET.read_text(encoding="utf-8")
    patched = MARK in text

    if args.check:
        print("inbound.js: " + ("patched" if patched else "NOT patched"))
        return 0 if patched else 1

    if args.revert:
        if not patched:
            print("inbound.js: nothing to revert")
            return 0
        if NEW not in text:
            print("inbound.js: patched block not found verbatim; refusing to guess")
            return 2
        TARGET.write_text(text.replace(NEW, OLD), encoding="utf-8")
        print("inbound.js: reverted")
        return 0

    if patched:
        print("inbound.js: already patched")
        return 0
    if OLD not in text:
        print("inbound.js: anchor not found (plugin version changed?)")
        return 2
    TARGET.write_text(text.replace(OLD, NEW), encoding="utf-8")
    print("inbound.js: sleep note fixed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
