"""P0 断线补拉 (catch-up after reconnect) for the dsh-onebot-qq plugin.

The plugin has no offline queue: messages sent while the WS is disconnected (or
while DSH restarts) never reach the agent. This patch drops a `catchup.js`
module into the plugin and hooks it into the bridge:

  - connection status -> CatchUp.onConnected()/onDisconnected()
  - every dispatched inbound message -> CatchUp.noteSeen()   (watermark)
  - bridge stop     -> CatchUp.stop()                         (flush state)

v2.24 additions (group context replay):
  - bridge passes `isAdmin` into CatchUp — the admin's group messages are
    replay anchors (the live pipeline never drops them; 4.47-B);
  - inbound gate lets replayed non-mention messages through as [旁听]
    context, and normalize carries the original say-time so the group
    prefix shows when the message was actually said, not when it was
    replayed (4.47-A).

v2.21 additions (friend-list enumeration):
  - pickChats() awaits the provider; bridge's listChats becomes async and
    appends `private:<uin>` for every friend missing from the registry, so
    a friend whose first messages were dropped (DM gate / outage) gets
    their backlog replayed on the next connect; maxChats raised to 48.

State lives in <mediaDir>/catchup-state.json. See the module header for the
dedupe/mention rules.

Idempotent; source of truth is tools/plugin/modules/onebot_catchup.js. Re-run after any
`dsh plugin ... update/install`, then truly restart DSH:

  python tools/plugin/patches/patch_onebot_catchup.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_catchup.py --check    # patched?
  python tools/plugin/patches/patch_onebot_catchup.py --revert   # restore bridge.js
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_catchup.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "catchup.js"
BRIDGE = LIB / "bridge.js"
BACKUP = BRIDGE.with_suffix(".js.bak-catchup")

MARKER = "[dsh-p1] P0 catch-up"

# v2.08: login-complete lifecycle event also triggers catch-up (a WS reconnect
# right after a QQ crash fires catch-up BEFORE login finishes; the lifecycle
# event is the "now actually online" signal)
INDEX = LIB / "index.js"
INDEX_BAK = INDEX.with_suffix(".js.bak-catchup-lifecycle")
ONMETA_OLD = """    connection.onMeta = (event) => {
        logMetaEvent(connection.selfId, event, config.logLevel);
    };"""
ONMETA_NEW = """    connection.onMeta = (event) => {
        logMetaEvent(connection.selfId, event, config.logLevel);
        // [dsh-p1] v2.08: QQ login completed (crash -> relogin path) — the
        // WS-connected catch-up ran while still waiting for login, so run
        // it again now that history is actually fetchable.
        if (event?.meta_event_type === 'lifecycle' && (event?.sub_type === 'connect' || event?.sub_type === undefined))
            void bridge.catchup?.onConnected();
    };"""


IMPORT_OLD = "import { healthReport, exportDiagnostics } from './health.js';"
IMPORT_NEW = IMPORT_OLD + "\nimport { CatchUp } from './catchup.js';"

CTOR_OLD = "        this.inbound = new InboundPipeline({"
CTOR_NEW = """        // [dsh-p1] P0 catch-up: replay messages missed while offline.
        this.catchup = new CatchUp({
            mediaDir: () => deps.config.mediaDir,
            selfId: () => this.deps.connection.selfId,
            connected: () => this.deps.connection.connected,
            call: (action, params) => this.guardedConnectionCall(action, params),
            handleEvent: event => this.handleInbound(event),
            // [dsh-p1] v2.21: registry alone misses friends whose first
            // messages were dropped before any session existed (DM gate /
            // outage) — enumerate the whole friend list so their backlog
            // replays too. maxChats raised: the default 8 would slice
            // appended friends off whenever the registry is busy.
            maxChats: 48,
            listChats: async () => {
                const chats = [...this.chats.values()]
                    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
                    .map(chat => chat.chatId);
                const known = new Set(chats);
                try {
                    const res = await this.guardedConnectionCall('get_friend_list', {});
                    const rows = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
                    const selfId = String(this.deps.connection.selfId ?? '');
                    for (const row of rows) {
                        const uin = String(row?.user_id ?? '');
                        const chatId = 'private:' + uin;
                        if (uin === '' || uin === selfId || known.has(chatId))
                            continue;
                        known.add(chatId);
                        chats.push(chatId);
                    }
                }
                catch { /* registry-only when the friend list is unavailable */ }
                return chats;
            },
            ready: () => this.registry.mappingLoaded,
            log: (level, message) => this.deps.log(level, message),
        });
""" + CTOR_OLD

STATUS_OLD = """        connection.onStatus = (connected) => {
            this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'));
            if (connected)
                this.outbound.drainPendingSends();
        };"""

STATUS_NEW = """        connection.onStatus = (connected) => {
            this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'));
            if (connected)
                this.outbound.drainPendingSends();
            // [dsh-p1] P0 catch-up: the module decides whether the gap is real.
            if (connected)
                void this.catchup.onConnected();
            else
                this.catchup.onDisconnected();
        };"""

SEEN_OLD = "                await this.processInbound(inbound);"
SEEN_NEW = """                const handled = await this.processInbound(inbound);
                // [dsh-p1] P0 catch-up: remember the id so a reconnect never
                // replays a message this process already handled. v2.23: the
                // pipeline reports false on a DROP (gate / backlog) — marking
                // dropped messages seen is what made them unrecoverable.
                if (!injected && handled !== false)
                    this.catchup.noteSeen(inbound);"""

STOP_OLD = """    async stop() {
        this.stopping = true;"""
STOP_NEW = """    async stop() {
        this.stopping = true;
        // [dsh-p1] P0 catch-up: flush the watermark before the chats go.
        await this.catchup.stop();"""

# [dsh-p1] v2.24 (4.47-B): group replay anchors include the admin — the live
# pipeline never drops admin messages ("老大在群里说话：放行"), so the replay
# must not either. Same union of policy+config admin lists the gate uses.
ADMIN_OLD = """            ready: () => this.registry.mappingLoaded,
            log: (level, message) => this.deps.log(level, message),
        });"""
ADMIN_NEW = """            ready: () => this.registry.mappingLoaded,
            // [dsh-p1] v2.24: group replay anchor — the admin's group messages
            // always reach her live; the replay must not drop them either.
            isAdmin: userId => {
                const admins = [
                    ...(Array.isArray(deps.policy?.adminUsers) ? deps.policy.adminUsers : []),
                    ...(Array.isArray(deps.config?.adminUsers) ? deps.config.adminUsers : []),
                ].map(String);
                return admins.includes(String(userId));
            },
            log: (level, message) => this.deps.log(level, message),
        });"""


def bridge_text() -> str:
    return BRIDGE.read_text(encoding="utf-8")


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("catchup.js up to date")
        return
    DEST.write_text(source, encoding="utf-8")
    print(f"installed {DEST}")


def apply_index() -> None:
    text = INDEX.read_text(encoding="utf-8")
    if "v2.08" in text and "bridge.catchup?.onConnected()" in text:
        print("index.js: already patched")
        return
    if text.count(ONMETA_OLD) != 1:
        raise SystemExit("index.js: onMeta anchor not found (plugin update?); aborting")
    if not INDEX_BAK.exists():
        shutil.copy2(INDEX, INDEX_BAK)
    INDEX.write_text(text.replace(ONMETA_OLD, ONMETA_NEW, 1), encoding="utf-8")
    print("index.js: lifecycle -> catch-up hook (backup .bak-catchup-lifecycle)")


def revert_index() -> None:
    if INDEX_BAK.exists():
        shutil.copy2(INDEX_BAK, INDEX)
        print("restored index.js")
    else:
        print("index lifecycle: no backup")


INBOUND_MARK_BAK = LIB / "inbound.js.bak-catchup-mark"
NORMALIZE_OLD = """        messageId,
        nickname,
    };
}"""
NORMALIZE_NEW = """        messageId,
        nickname,
        catchup: event.catchup === true,
    };
}"""
MARK_OLD = """        // [dsh-p1] reply support: expose this message's id for [[reply:<id>]].
        if (inbound.messageId !== undefined && inbound.messageId !== '')
            final = '[本条ID:' + inbound.messageId + ']\\n' + final;"""
MARK_NEW = """        // [dsh-p1] reply support: expose this message's id for [[reply:<id>]].
        if (inbound.messageId !== undefined && inbound.messageId !== '')
            final = '[本条ID:' + inbound.messageId + ']\\n' + final;
        // [dsh-p1] catch-up source tag; quoting is a contextual choice.
        if (inbound.catchup === true)
            final = '[补回]\\n' + final;"""


def apply_mark() -> None:
    text = (LIB / "inbound.js").read_text(encoding="utf-8")
    if "[补回]" in text:
        print("inbound.js: mark already patched")
        return
    if text.count(NORMALIZE_OLD) != 1 or text.count(MARK_OLD) != 1:
        raise SystemExit("inbound.js: mark anchors not found; aborting")
    if not INBOUND_MARK_BAK.exists():
        shutil.copy2(LIB / "inbound.js", INBOUND_MARK_BAK)
    text = text.replace(NORMALIZE_OLD, NORMALIZE_NEW, 1)
    text = text.replace(MARK_OLD, MARK_NEW, 1)
    (LIB / "inbound.js").write_text(text, encoding="utf-8")
    print("inbound.js: [补回] tag wired (backup .bak-catchup-mark)")


def revert_mark() -> None:
    if INBOUND_MARK_BAK.exists():
        shutil.copy2(INBOUND_MARK_BAK, LIB / "inbound.js")
        print("restored inbound.js (mark)")


# [dsh-p1] v2.24 (4.47-A): replayed backlog context must survive the group
# gate, and the group prefix must show the original say-time (a message from
# hours ago must not present itself as "just now"). Three seams, one step:
#   1. gate: a replayed non-mention message rides with its anchor — catch-up
#      already selected it; peek/turn-cap would drop exactly the context the
#      replay exists to provide, and backlog must not spend the live budget.
#   2. normalize: carry the event's original time (OneBot unix seconds).
#   3. prefix call site: pass it through to buildGroupMessagePrefix.
INBOUND_CTX_BAK = LIB / "inbound.js.bak-catchup-context"
GATE_OLD = """            else {
                // [dsh-p1] turn cap: hourly budget for undirected passes (wake window /"""
GATE_NEW = """            else if (inbound.catchup === true) {
                // [dsh-p1] v2.24: replayed backlog context rides with its anchor —
                // catch-up already selected it (anchor ± context window); peek /
                // turn-cap would drop exactly the context the replay exists to
                // provide, and backlog must not spend the live hourly budget.
                this.ctx.log('debug', 'catch-up context in ' + groupId + ': replayed non-mention message rides with its anchor');
                currentTrace()?.emit('mention', { ok: true, reason: '补回上下文：随锚点放行' });
            }
            else {
                // [dsh-p1] turn cap: hourly budget for undirected passes (wake window /"""
SAID_OLD = """        messageId,
        nickname,
        catchup: event.catchup === true,
    };
}"""
SAID_NEW = """        messageId,
        nickname,
        catchup: event.catchup === true,
        catchupSaidAtMs: event.catchup === true ? (Number(event?.time) || 0) * 1000 : 0,
    };
}"""
CALL_OLD = "            final = buildGroupMessagePrefix(nickname, userId, mentioned) + final;"
CALL_NEW = "            final = buildGroupMessagePrefix(nickname, userId, mentioned, inbound.catchupSaidAtMs) + final;"


def apply_context() -> None:
    path = LIB / "inbound.js"
    text = path.read_text(encoding="utf-8")
    if "catch-up context in " in text:
        print("inbound.js: context gate already patched")
        return
    for name, anchor in (("gate", GATE_OLD), ("say-time", SAID_OLD), ("prefix call", CALL_OLD)):
        if text.count(anchor) != 1:
            raise SystemExit(f"inbound.js: {name} anchor found {text.count(anchor)} times (expected 1); aborting")
    if not INBOUND_CTX_BAK.exists():
        shutil.copy2(path, INBOUND_CTX_BAK)
    text = text.replace(GATE_OLD, GATE_NEW, 1)
    text = text.replace(SAID_OLD, SAID_NEW, 1)
    text = text.replace(CALL_OLD, CALL_NEW, 1)
    path.write_text(text, encoding="utf-8")
    print("inbound.js: catch-up context gate + say-time wired (backup .bak-catchup-context)")


def revert_context() -> None:
    if INBOUND_CTX_BAK.exists():
        shutil.copy2(INBOUND_CTX_BAK, LIB / "inbound.js")
        print("restored inbound.js (context)")
    else:
        print("inbound context: no backup")


# [dsh-p1] v2.24 (4.47-A): the group prefix stamps the message's own say-time
# when it has one (catch-up replays), wall clock otherwise — same [HH:MM …]
# shape, so downstream prefix stripping (commands.js) is unaffected.
CHAT_PREFIX_BAK = LIB / "chat.js.bak-catchup-prefix"
PREFIX_OLD = """export function buildGroupMessagePrefix(nickname, userId, mentioned) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');"""
PREFIX_NEW = """export function buildGroupMessagePrefix(nickname, userId, mentioned, saidAtMs = 0) {
    // [dsh-p1] v2.24: replayed backlog shows the original say-time — a message
    // from hours ago must not present itself as "just now".
    const clock = saidAtMs > 0 ? new Date(saidAtMs) : new Date();
    const hh = String(clock.getHours()).padStart(2, '0');
    const mm = String(clock.getMinutes()).padStart(2, '0');"""


def apply_prefix() -> None:
    path = LIB / "chat.js"
    text = path.read_text(encoding="utf-8")
    if "saidAtMs" in text:
        print("chat.js: prefix say-time already patched")
        return
    if text.count(PREFIX_OLD) != 1:
        raise SystemExit(f"chat.js: prefix anchor found {text.count(PREFIX_OLD)} times (expected 1); aborting")
    if not CHAT_PREFIX_BAK.exists():
        shutil.copy2(path, CHAT_PREFIX_BAK)
    path.write_text(text.replace(PREFIX_OLD, PREFIX_NEW, 1), encoding="utf-8")
    print("chat.js: group prefix stamps the say-time (backup .bak-catchup-prefix)")


def revert_prefix() -> None:
    if CHAT_PREFIX_BAK.exists():
        shutil.copy2(CHAT_PREFIX_BAK, LIB / "chat.js")
        print("restored chat.js (prefix)")
    else:
        print("chat.js prefix: no backup")


def apply_delivery_contract() -> None:
    """v2.32: carry the delivery result through every bridge layer."""
    text = bridge_text()
    text = text.replace("        await this.inbound.processInbound(inbound);", "        return await this.inbound.processInbound(inbound);")
    text = text.replace("            await runWithTrace(scope, async () => {", "            return await runWithTrace(scope, async () => {")
    old = """                if (!injected && handled !== false)
                    this.catchup.noteSeen(inbound);"""
    if "this.catchup.noteDeferred(inbound);" not in text:
        if text.count(old) != 1:
            raise SystemExit("delivery result: bridge hook changed")
        text = text.replace(old, old + """
                if (!injected && handled === false)
                    this.catchup.noteDeferred(inbound);
                return handled;""", 1)
    # Queuing is not delivery. A sleeping/fragment-held message is retryable.
    text = text.replace("scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping });\n                    return;", "scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping });\n                    return false;")
    text = text.replace("this.pendingFragments.set(key, { text: fragText, timer });\n                            return;", "this.pendingFragments.set(key, { text: fragText, timer });\n                            return false;")
    text = text.replace("' while asleep');\n                        return;", "' while asleep');\n                        return false;")
    text = text.replace("this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error));\n        }", "this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error));\n            return false;\n        }")
    if text != bridge_text():
        BRIDGE.write_text(text, encoding="utf-8")

    path = LIB / "inbound.js"
    inbound = path.read_text(encoding="utf-8")
    old = """    async processInbound(inbound) {
        if (this.duplicated(inbound))
            return;"""
    new = """    async processInbound(inbound) {
        // [dsh-p1] delivery result: release dedup reservations on rejection/error.
        if (inbound.messageId === undefined || inbound.messageId === null || inbound.messageId === '')
            return await this.processInboundBody(inbound);
        const key = inbound.chatId + '#' + inbound.messageId;
        this.pendingDeliveries ??= new Set();
        if (this.pendingDeliveries.has(key))
            return false;
        if (this.duplicated(inbound))
            return;
        this.pendingDeliveries.add(key);
        try {
            const handled = await this.processInboundBody(inbound);
            if (handled === false)
                this.seenMessages.delete(key);
            return handled;
        }
        catch (error) {
            this.seenMessages.delete(key);
            throw error;
        }
        finally {
            this.pendingDeliveries.delete(key);
        }
    }
    async processInboundBody(inbound) {"""
    if "pendingDeliveries" not in inbound:
        if inbound.count(old) != 1:
            raise SystemExit("delivery result: inbound hook changed")
        path.write_text(inbound.replace(old, new, 1), encoding="utf-8")
    elif "return await this.processInboundBody(inbound);" not in inbound:
        anchor = "        // [dsh-p1] delivery result: release dedup reservations on rejection/error."
        path.write_text(inbound.replace(anchor, anchor + "\n        if (inbound.messageId === undefined || inbound.messageId === null || inbound.messageId === '')\n            return await this.processInboundBody(inbound);", 1), encoding="utf-8")


def apply() -> None:
    apply_index()
    apply_mark()
    apply_context()
    apply_prefix()
    apply_delivery_contract()
    text = bridge_text()
    replacements = [
        ("import", "from './catchup.js'", IMPORT_OLD, IMPORT_NEW),
        ("constructor", "this.catchup = new CatchUp(", CTOR_OLD, CTOR_NEW),
        ("onStatus", "this.catchup.onConnected", STATUS_OLD, STATUS_NEW),
        ("noteSeen", "this.catchup.noteSeen", SEEN_OLD, SEEN_NEW),
        ("stop", "await this.catchup.stop()", STOP_OLD, STOP_NEW),
        ("isAdmin", "isAdmin: userId => {", ADMIN_OLD, ADMIN_NEW),
    ]
    pending = [item for item in replacements if item[1] not in text]
    if not pending:
        print("bridge.js already patched")
        install_module()
        return
    missing = [name for name, _marker, anchor, _new in pending if anchor not in text]
    if missing:
        raise SystemExit("bridge.js anchors changed (plugin version mismatch): " + ", ".join(missing))
    # Keep the first backup only: it is the pristine released bridge.js used by --revert.
    if not BACKUP.exists():
        shutil.copy2(BRIDGE, BACKUP)
    patched = text
    for _name, _marker, anchor, new in pending:
        patched = patched.replace(anchor, new, 1)
    BRIDGE.write_text(patched, encoding="utf-8")
    print(f"patched {BRIDGE} (backup: {BACKUP.name})")
    install_module()


def check() -> int:
    text = bridge_text()
    ok = all(marker in text for marker in (
        "from './catchup.js'", "this.catchup = new CatchUp(",
        "this.catchup.onConnected", "this.catchup.noteSeen", "await this.catchup.stop()",
        "isAdmin: userId => {",
    ))
    inbound = (LIB / "inbound.js").read_text(encoding="utf-8")
    ok = ok and "catch-up context in " in inbound and "catchupSaidAtMs" in inbound
    ok = ok and "saidAtMs" in (LIB / "chat.js").read_text(encoding="utf-8")
    ok = ok and DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    ok = ok and "return await this.inbound.processInbound(inbound);" in text
    ok = ok and "return await runWithTrace(scope, async () => {" in text
    ok = ok and "this.catchup.noteDeferred(inbound);" in text
    ok = ok and "pendingDeliveries" in inbound
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    revert_index()
    revert_mark()
    revert_context()
    revert_prefix()
    if BACKUP.exists():
        shutil.copy2(BACKUP, BRIDGE)
        BACKUP.unlink()
        print(f"reverted {BRIDGE}")
    else:
        print("no bridge.js backup; nothing reverted")
    if DEST.exists():
        DEST.unlink()
        print(f"removed {DEST}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.check:
        sys.exit(check())
    if args.revert:
        revert()
        return
    apply()


if __name__ == "__main__":
    main()
