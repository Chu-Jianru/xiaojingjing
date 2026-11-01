"""Persist notification history independently of the 24h approval cache.

Apply after friend-store/buddy patches; --check validates the real bridge hooks.
"""
from pathlib import Path
import argparse

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'bot-home').is_dir())
LIB = ROOT / 'bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib'
MODULES = Path(__file__).resolve().parent.parent / 'modules'
BRIDGE = LIB / 'bridge.js'
IMPORT = "import { friendNotificationsFor } from './friend-notifications.js';"


def transform(text):
    if IMPORT not in text:
        anchor = "import { FriendRequestStore } from './friend-store.js';"
        if anchor not in text:
            raise SystemExit('friend-store import missing')
        text = text.replace(anchor, anchor + '\n' + IMPORT, 1)
    start = text.index('    let nickname = String(event.nickname', text.index('async function handleFriendRequestEvent'))
    end = text.index('\n    return true;', start)
    text = text[:start] + "    // [dsh-p1] durable friend notifications: live events and scans share history.\n    try { await friendNotificationsFor(bridge, friendStore(bridge)).event(event); }\n    catch (error) { bridge.deps.log('warn', 'friend request: ' + describeError(error)); }" + text[end:]
    return text


def patch(text):
    if '[dsh-p1] durable friend notifications' not in text:
        text = transform(text)
    start = text.index('async function buddyWatchTick(bridge) {')
    end = text.index('\nfunction startBuddyWatch', start)
    text = text[:start] + '''async function buddyWatchTick(bridge) {
    try { await friendNotificationsFor(bridge, friendStore(bridge)).scan(); }
    catch (error) { bridge.deps.log('warn', 'buddy watch: ' + describeError(error)); }
    return '';
}
''' + text[end:]
    text = text.replace('const buddyNotified = new Set();\n', '')
    text = text.replace('        await store.delete(target);', '        await store.settle(target, pending.flag);')
    return text


def ready(text):
    return (IMPORT in text and '[dsh-p1] durable friend notifications' in text
            and 'friendNotificationsFor(bridge, friendStore(bridge)).event(event)' in text
            and 'friendNotificationsFor(bridge, friendStore(bridge)).scan()' in text
            and 'await store.settle(target, pending.flag)' in text
            and 'buddyNotified' not in text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    raw = BRIDGE.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    text = raw.decode('utf-8').replace('\r\n', '\n')
    pairs = [('onebot_friend_notifications.js', 'friend-notifications.js'), ('onebot_friend_store.js', 'friend-store.js')]
    if args.check:
        ok = ready(text) and all((LIB / dest).exists() and (LIB / dest).read_text(encoding='utf-8') == (MODULES / src).read_text(encoding='utf-8') for src, dest in pairs)
        print('patched' if ok else 'NOT patched')
        raise SystemExit(0 if ok else 1)
    result = patch(text)
    if result != text:
        BRIDGE.write_bytes(result.replace('\n', newline).encode('utf-8'))
    for src, dest in pairs:
        (LIB / dest).write_bytes((MODULES / src).read_bytes())
    print('durable friend notifications installed')


if __name__ == '__main__':
    main()
