"""Allow private messages from QQ friends (not only admins), no strangers.

`dmPolicy: open` admits admins only; there is no built-in "friends only" mode.
This patch keeps the admin gate and adds a cached `get_friend_list` lookup, so:

  - admins                         -> allowed (unchanged)
  - people on the bot's friend list -> allowed (new)
  - everyone else                  -> dropped (unchanged)

The friend list is fetched at most once per 10 minutes; if the call fails the
cache stays empty and only admins can DM (fail-closed). v2.20: a cache MISS
re-fetches once (30s throttled) so friends approved after the cache was loaded
are not silently dropped for up to 10 minutes, and bridge.js's
recordFriendAdded calls noteFriendAdded() to admit a just-approved friend
immediately.

  python tools/plugin/patches/patch_onebot_friends.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
MARKER = "[dsh-p1] friends can DM"

OLD = """        if (kind === 'private') {
            if (!dmAllowed(userId, policy)) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                return;
            }
        }
"""

NEW = """        if (kind === 'private') {
            // [dsh-p1] friends can DM: admins as before, plus anyone on the
            // bot's friend list (cached; fail-closed when the query fails).
            if (!dmAllowed(userId, policy) && !(await isFriendSender(this.ctx, userId))) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                return;
            }
        }
"""

HELPERS = f"""
// -- {MARKER} -----------------------------------------------------------
// QQ has no "friends may DM" policy in this plugin; check get_friend_list with
// a 10-minute cache. Failure keeps the set empty => admins only (fail-closed).
// v2.20: a cache miss re-fetches once (30s throttled) so friends approved
// after the cache was loaded are not silently dropped for up to 10 minutes;
// noteFriendAdded() admits a just-approved friend immediately.
const friendCache = {{ at: 0, ids: new Set() }};
const FRIEND_CACHE_MS = 600_000;
const FRIEND_RECHECK_MS = 30_000;

async function refreshFriendCache(ctx) {{
    try {{
        const res = await ctx.call('get_friend_list', {{}});
        const list = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
        const ids = new Set();
        for (const friend of list) {{
            const id = String(friend?.user_id ?? friend?.uin ?? '');
            if (id !== '')
                ids.add(id);
        }}
        friendCache.ids = ids;
    }}
    catch (error) {{
        ctx.log('warn', 'get_friend_list failed, friends-only DM stays closed: ' + String(error));
    }}
}}

async function isFriendSender(ctx, userId) {{
    const now = Date.now();
    if (now - friendCache.at > FRIEND_CACHE_MS) {{
        friendCache.at = now;
        await refreshFriendCache(ctx);
        return friendCache.ids.has(String(userId));
    }}
    if (friendCache.ids.has(String(userId)))
        return true;
    if (now - friendCache.at > FRIEND_RECHECK_MS) {{
        friendCache.at = now;
        await refreshFriendCache(ctx);
    }}
    return friendCache.ids.has(String(userId));
}}
export {{ isFriendSender, friendCache, FRIEND_CACHE_MS, FRIEND_RECHECK_MS }};

/** [dsh-p1] v2.20: an approval just succeeded — admit the new friend
 * immediately instead of waiting out the cache TTL. */
export function noteFriendAdded(userId) {{
    const id = String(userId ?? '');
    if (id !== '')
        friendCache.ids.add(id);
}}
"""


def apply(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("friends patch already applied")
        return
    if OLD not in text:
        raise SystemExit("inbound.js anchor not found — plugin version changed")
    backup = path.with_suffix(".js.bak-friends")
    shutil.copy2(path, backup)
    path.write_text(text.replace(OLD, NEW, 1) + HELPERS, encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def revert(path: Path) -> None:
    backup = path.with_suffix(".js.bak-friends")
    if not backup.exists():
        raise SystemExit("no backup to restore")
    shutil.copy2(backup, path)
    backup.unlink()
    print("reverted")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    path = LIB / "inbound.js"
    if args.check:
        ok = MARKER in path.read_text(encoding="utf-8")
        print("patched" if ok else "NOT patched")
        raise SystemExit(0 if ok else 1)
    if args.revert:
        revert(path)
        return
    apply(path)


if __name__ == "__main__":
    main()
