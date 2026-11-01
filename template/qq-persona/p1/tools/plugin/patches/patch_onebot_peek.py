"""Let 小鲸鲸 "peek" at group chat without listening to everything.

Upstream: with `requireMention: true`, every un-@'d group message is dropped
before the agent — zero cost, but she never notices the conversation. The user
wants a human-like middle ground:

  - after being @'d, she stays "awake" for a few rounds (sees the next messages,
    replies only if she feels like it — the persona may answer `[不回]`)
  - otherwise she randomly peeks: the admin's messages more often, other
    members rarely, with a cooldown + hourly cap so it cannot burn tokens
  - every peeked message is tagged `[旁听]` in the group prefix, so the model
    knows it was not addressed to her

Idempotent; run after `dsh plugin` upgrades:

  python tools/plugin/patches/patch_onebot_peek.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] group peek"
PREFIX_MARKER = "[dsh-p1] peek label"

OLD_GATE = """        const mentioned = detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);
        if (kind === 'group' && this.ctx.config.requireMention && !mentioned) {
            this.ctx.log('debug', 'ignoring unmentioned group message in ' + groupId);
            currentTrace()?.emit('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned });
            return;
        }
"""

NEW_GATE = """        const mentioned = detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);
        if (kind === 'group') {
            if (mentioned) {
                noteGroupMention(chatId);
            }
            else if (this.ctx.config.requireMention && !peekAllows(this.ctx, chatId, userId, inbound.text)) {
                this.ctx.log('debug', 'ignoring unmentioned group message in ' + groupId);
                currentTrace()?.emit('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned });
                return;
            }
            else if (!mentioned) {
                // [dsh-p1] group peek: let the agent decide whether to answer.
                this.ctx.log('debug', 'peek: unmentioned group message let through in ' + groupId);
                currentTrace()?.emit('mention', { ok: true, reason: '旁听：放行未 @ 的群消息' });
            }
        }
"""

HELPERS = f"""
// -- {MARKER} ------------------------------------------------------------
// After an @, the next few group messages are delivered (awake window); the
// agent answers only what it wants, `[不回]` otherwise. Outside the window we
// randomly peek: admin messages more often than other members, with a cooldown
// and an hourly cap. Every peeked message gets the `[旁听]` prefix (chat.js).
const PEEK_AWAKE_ROUNDS = 6;
const PEEK_ADMIN_CHANCE = 0.18;
const PEEK_MEMBER_CHANCE = 0.04;
const PEEK_COOLDOWN_MS = 180_000;
const PEEK_MAX_PER_HOUR = 8;
const PEEK_MIN_CHARS = 4;
const peekState = new Map();

function peekStat(chatId) {{
    let st = peekState.get(chatId);
    if (st === undefined) {{
        st = {{ awakeLeft: 0, lastPeekAt: 0, hourStart: 0, peekCount: 0 }};
        peekState.set(chatId, st);
    }}
    return st;
}}

function noteGroupMention(chatId) {{
    peekStat(chatId).awakeLeft = PEEK_AWAKE_ROUNDS;
}}

function peekAllows(ctx, chatId, userId, text) {{
    const st = peekStat(chatId);
    if (st.awakeLeft > 0) {{
        st.awakeLeft -= 1;
        return true;
    }}
    const now = Date.now();
    if (now - st.lastPeekAt < PEEK_COOLDOWN_MS)
        return false;
    if (now - st.hourStart > 3_600_000) {{
        st.hourStart = now;
        st.peekCount = 0;
    }}
    if (st.peekCount >= PEEK_MAX_PER_HOUR)
        return false;
    const body = String(text ?? '').trim();
    if (body.length < PEEK_MIN_CHARS)
        return false;
    const admins = Array.isArray(ctx.config.adminUsers) ? ctx.config.adminUsers : [];
    const chance = admins.includes(userId) ? PEEK_ADMIN_CHANCE : PEEK_MEMBER_CHANCE;
    if (Math.random() >= chance)
        return false;
    st.lastPeekAt = now;
    st.peekCount += 1;
    return true;
}}
"""

OLD_PREFIX = "    const mention = mentioned ? '[@我]' : '';\n"
NEW_PREFIX = (
    "    const mention = mentioned ? ' [@我]' : ' [旁听]';  // " + PREFIX_MARKER + "\n"
)


def apply_peek(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("peek already patched")
        return
    if OLD_GATE not in text:
        raise SystemExit("inbound.js anchor not found — plugin version changed")
    backup = path.with_suffix(".js.bak-peek")
    shutil.copy2(path, backup)
    path.write_text(text.replace(OLD_GATE, NEW_GATE, 1) + HELPERS, encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def apply_prefix(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if PREFIX_MARKER in text:
        print("prefix already patched")
        return
    if OLD_PREFIX not in text:
        raise SystemExit("chat.js anchor not found — plugin version changed")
    backup = path.with_suffix(".js.bak-peek")
    shutil.copy2(path, backup)
    path.write_text(text.replace(OLD_PREFIX, NEW_PREFIX, 1), encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def revert(path: Path) -> None:
    backup = path.with_suffix(".js.bak-peek")
    if not backup.exists():
        raise SystemExit(f"no backup for {path.name}")
    shutil.copy2(backup, path)
    backup.unlink()
    print(f"reverted {path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    inbound = LIB / "inbound.js"
    chat = LIB / "chat.js"
    if args.check:
        ok = MARKER in inbound.read_text(encoding="utf-8") and PREFIX_MARKER in chat.read_text(encoding="utf-8")
        print("patched" if ok else "NOT patched")
        raise SystemExit(0 if ok else 1)
    if args.revert:
        revert(inbound)
        revert(chat)
        return
    apply_peek(inbound)
    apply_prefix(chat)


if __name__ == "__main__":
    main()
