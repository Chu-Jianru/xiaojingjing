"""Let admin settle commands through the sleep gate; dedup the backlog replay.

v2.27, two fixes from the 2026-10-26 02:2x night (boss approved two friend
requests while the bot was asleep and nothing happened for ~7 minutes):

  1. sleep settle passthrough — 「同意/拒绝 QQ号」 (and a bare 同意/拒绝 riding a
     QQ reply to a notification) is an admin action on a pending request, not
     chat. The sleep gate used to queue it with everything else, so an
     approval sent at night only ran after the wake-time backlog replay got
     around to it. The dispatch now skips the sleep drop for admin messages
     whose text is a settle command (isAdminSettleText from the sleep module);
     the settle hook later in the same handler answers them, so she stays
     asleep and no model turn is spent.

  2. backlog/catchup dedup — messages queued by the sleep gate are never
     marked seen, so a reconnect between queueing and waking replays them via
     catchup FIRST, and the wake-time flushSleepBacklog then delivered the
     same events again. The flush now drops events whose message_id the
     catchup registry already delivered (CatchUp.hasSeen), keeping the catchup
     retry semantics for anything catchup itself gate-dropped.

Files:
  - lib/sleep.js    — installed whole-file from modules/onebot_sleep.js (adds
                      the isAdminSettleText export; the module had no owning
                      patch before, this script claims the deploy).
  - lib/bridge.js   — text patch: import + sleep-gate passthrough + flush dedup.
  - modules/onebot_catchup.js — hasSeen() (deployed by patch_onebot_catchup.py).

Idempotent; re-run after plugin upgrades.

  python tools/plugin/patches/patch_onebot_sleep_settle.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
BRIDGE = LIB / "bridge.js"
SLEEP = LIB / "sleep.js"
SLEEP_SRC = REPO / "qq-persona/p1/tools/plugin/modules/onebot_sleep.js"
BRIDGE_BAK = LIB / "bridge.js.bak-sleepsettle"
SLEEP_BAK = LIB / "sleep.js.bak-sleepsettle"

MARKER_BRIDGE = "[dsh-p1] sleep settle passthrough (v2.27)"


def refresh_greetings(text: str) -> str:
    if "dispatchSleepGreeting } from './sleep.js'" not in text:
        text = text.replace("isAdminSettleText } from './sleep.js';", "isAdminSettleText, dispatchSleepGreeting } from './sleep.js';")
    text = re.sub(
        r"            const goodnights = \[.*?\n            catch \(error\) \{ bridge.deps.log\('warn', 'sleep: goodnight send failed: '.*?\n",
        "            await dispatchSleepGreeting(bridge, adminChat, 'asleep');\n", text, flags=re.S)
    text = re.sub(
        r"            try \{ await bridge.sendToChat\(state.lastChatId, '小鲸鲸要睡了，晚安'\); \}\n            catch \{ /\* best effort \*/ \}\n",
        "            await dispatchSleepGreeting(bridge, state.lastChatId, 'asleep');\n", text)
    text = re.sub(
        r"            const mornings = \[.*?\n            catch \(error\) \{ bridge.deps.log\('warn', 'sleep: morning send failed: '.*?\n",
        "            await dispatchSleepGreeting(bridge, 'private:' + String(admins[0]), 'awake');\n", text, flags=re.S)
    if "const goodnights =" in text or "const mornings =" in text or text.count("await dispatchSleepGreeting(") != 3:
        raise SystemExit("sleep greeting hooks changed — expected three generated greetings")
    return text

IMPORT_OLD = "import { gate as sleepGate, tick as sleepTick, loadSleep, saveSleep, noteMessage as sleepNote } from './sleep.js';"
IMPORT_NEW = "import { gate as sleepGate, tick as sleepTick, loadSleep, saveSleep, noteMessage as sleepNote, isAdminSettleText } from './sleep.js';"

VERDICT_OLD = "                    const verdict = sleepGate(sleepState, Date.now(), event.user_id, String(event.raw_message ?? ''), admins);"
VERDICT_NEW = """                    // [dsh-p1] sleep settle passthrough (v2.27): 同意/拒绝 <QQ> from
                    // the admin is an action on a pending request, not chat — it
                    // must settle while she is asleep (handleFriendApprovalReply
                    // answers it) and must not wake her.
                    const settlePassthrough = admins.map(String).includes(String(event.user_id))
                        && isAdminSettleText(String(event.raw_message ?? ''));
                    const verdict = settlePassthrough
                        ? { drop: false, wake: false }
                        : sleepGate(sleepState, Date.now(), event.user_id, String(event.raw_message ?? ''), admins);"""

FLUSH_OLD = """        const pending = [...this.sleepBacklog.values()].flat();
        this.sleepBacklog.clear();"""
FLUSH_NEW = """        // [dsh-p1] backlog/catchup dedup (v2.27): a reconnect between queueing
        // and waking replays these through catchup first (they were never seen
        // when the sleep gate queued them) — skip what it already delivered so
        // she never answers the same message twice.
        const backlog = [...this.sleepBacklog.values()].flat();
        const pending = backlog.filter(event => {
            const chatId = event.group_id !== undefined && event.group_id !== null && String(event.group_id) !== ''
                ? 'group:' + String(event.group_id)
                : 'private:' + String(event.user_id);
            const id = String(event?.message_id ?? '');
            return id === '' || !this.catchup?.hasSeen?.(chatId, id);
        });
        if (backlog.length > pending.length)
            this.deps.log('info', 'sleep backlog: skipped ' + (backlog.length - pending.length) + ' message(s) already replayed by catchup');
        this.sleepBacklog.clear();"""


def install_sleep_module() -> None:
    source = SLEEP_SRC.read_text(encoding="utf-8")
    if SLEEP.exists() and SLEEP.read_text(encoding="utf-8") == source:
        print("sleep.js up to date")
        return
    if not SLEEP_BAK.exists():
        shutil.copy2(SLEEP, SLEEP_BAK)
    SLEEP.write_text(source, encoding="utf-8")
    print(f"installed {SLEEP}")


def apply() -> None:
    install_sleep_module()
    bridge_text = BRIDGE.read_text(encoding="utf-8")
    if MARKER_BRIDGE in bridge_text:
        refreshed = refresh_greetings(bridge_text)
        if refreshed != bridge_text:
            BRIDGE.write_text(refreshed, encoding="utf-8")
        print("bridge.js sleep hooks refreshed")
        return
    for name, anchor in (
        ("bridge.js import", IMPORT_OLD),
        ("bridge.js verdict", VERDICT_OLD),
        ("bridge.js flush", FLUSH_OLD),
    ):
        if bridge_text.count(anchor) != 1:
            raise SystemExit(f"{name} anchor not unique/found (plugin version mismatch); aborting")
    if not BRIDGE_BAK.exists():
        shutil.copy2(BRIDGE, BRIDGE_BAK)
    bridge_text = bridge_text.replace(IMPORT_OLD, IMPORT_NEW, 1)
    bridge_text = bridge_text.replace(VERDICT_OLD, VERDICT_NEW, 1)
    bridge_text = bridge_text.replace(FLUSH_OLD, FLUSH_NEW, 1)
    bridge_text = refresh_greetings(bridge_text)
    BRIDGE.write_text(bridge_text, encoding="utf-8")
    print(f"patched {BRIDGE} (backup: {BRIDGE_BAK.name})")


def revert() -> None:
    for path, backup in ((BRIDGE, BRIDGE_BAK), (SLEEP, SLEEP_BAK)):
        if backup.exists():
            shutil.copy2(backup, path)
            backup.unlink()
            print(f"reverted {path.name}")
        else:
            print(f"{path.name}: no backup")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.check:
        ok = (MARKER_BRIDGE in BRIDGE.read_text(encoding="utf-8")
              and SLEEP.exists()
              and SLEEP.read_text(encoding="utf-8") == SLEEP_SRC.read_text(encoding="utf-8"))
        ok = ok and refresh_greetings(BRIDGE.read_text(encoding="utf-8")) == BRIDGE.read_text(encoding="utf-8")
        print("patched" if ok else "NOT patched")
        raise SystemExit(0 if ok else 1)
    if args.revert:
        revert()
        return
    apply()


if __name__ == "__main__":
    main()
