"""Remove the bot-flavoured system notices from the QQ channel.

Seen in the group: "当前任务运行中，新消息已排队..." and "消息太频繁，请稍后再试".
Both read like a machine, not a person.

  - queue mode: silently queue the message (no notice at all); the reply comes
    when the running turn ends, which is what a human would do
  - rate limit: v2.11 (4.37) retired the per-minute drop window entirely —
    `rateLimited` is now a queue-backlog guard (PENDING_TURN_CAP) that drops
    silently and never sends any notice. This script no longer patches it;
    it only asserts the v2.11 rework is present so a plugin upgrade that
    reverts inbound.js fails loudly here instead of leaking notices live.
    Re-port the rework from git history (inbound.js.bak-ratequota diff) if
    this check fails after an upgrade.
  - steer mode's "已提交" notice: silenced in bridge.js since v2.11 too
    (auto-steer path only; the explicit /steer command keeps its receipt).

Idempotent; re-run after `dsh plugin` upgrades:

  python tools/plugin/patches/patch_onebot_quiet.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] quiet notices"
RATE_MARKER = "[dsh-p1] v2.11 防雪崩限流"
CANNED_RATE_TEXT = "回不过来"

QUEUE_OLD = """        if (!this.queueNoticeChats.has(chatId)) {
            this.queueNoticeChats.add(chatId);
            this.sendToChat(chatId, QUEUE_NOTICE_TEXT).catch((error) => {
                this.deps.log('debug', '排队提示发送失败: ' + describeError(error));
                currentTrace()?.emit('notice', { ok: false, reason: '排队提示发送失败: ' + describeError(error) });
            });
        }
"""

QUEUE_NEW = """        // [dsh-p1] quiet notices: queue silently; a human does not announce it.
"""


def apply_queue(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("queue notice already patched")
        return
    if QUEUE_OLD not in text:
        raise SystemExit("bridge.js queue-notice anchor changed — plugin version mismatch")
    backup = path.with_suffix(".js.bak-quiet")
    shutil.copy2(path, backup)
    path.write_text(text.replace(QUEUE_OLD, QUEUE_NEW, 1), encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def check_rate(inbound: Path) -> bool:
    """v2.11 rate limiter must be present and the canned text gone."""
    text = inbound.read_text(encoding="utf-8")
    if RATE_MARKER not in text or CANNED_RATE_TEXT in text:
        return False
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    bridge = LIB / "bridge.js"
    inbound = LIB / "inbound.js"
    if args.check:
        ok = MARKER in bridge.read_text(encoding="utf-8") and check_rate(inbound)
        print("patched" if ok else "NOT patched")
        raise SystemExit(0 if ok else 1)
    if args.revert:
        backup = bridge.with_suffix(".js.bak-quiet")
        if backup.exists():
            shutil.copy2(backup, bridge)
            backup.unlink()
            print(f"reverted {bridge}")
        return
    apply_queue(bridge)
    if not check_rate(inbound):
        print(
            "WARNING: inbound.js rate limiter is not the v2.11 backlog rework "
            "(canned notice absent, or per-minute drop window back after an upgrade) — "
            "re-port it from the inbound.js.bak-ratequota diff / git v2.11, do not let the old notice ship."
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
