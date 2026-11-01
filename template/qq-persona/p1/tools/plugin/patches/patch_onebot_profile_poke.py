"""Per-person profiles (画像) + QQ 戳一戳 for 小鲸鲸.

Profiles:
  - `lib/profiles.js` stores <mediaDir>/profiles.json (nickname/relation/style/
    facts/counts), touched on every inbound and rendered as a trusted `[画像]`
    block by inbound.js
  - the `qq_profile` tool lets the model read/update one person's profile

Poke:
  - inbound: a NapCat `notice/notify/poke` aimed at her becomes a tiny inbound
    turn (`[戳一戳] 某某 戳了戳你`), rate-limited to one per chat per minute
  - outbound: the `qq_poke` tool pokes the current chat's peer (group_poke /
    friend_poke)

Idempotent; re-run after `dsh plugin` upgrades, then restart DSH:

  python tools/plugin/patches/patch_onebot_profile_poke.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_profiles.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "profiles.js"
TOOLS_JS = LIB / "tools.js"
INBOUND = LIB / "inbound.js"
BRIDGE = LIB / "bridge.js"

MARKER = "[dsh-p1] profiles + poke"

TOOLS_IMPORT_OLD = "import { defineTool } from '@deepseek-ai/dsh-tools';"
TOOLS_IMPORT_NEW = TOOLS_IMPORT_OLD + "\nimport { profileGet, profileUpdate } from './profiles.js';"

TOOLS_ANCHOR = "    // -- [dsh-p1] long-term memory --\n    return () => {"

TOOLS_HOOK = """    register(defineTool({
        name: 'qq_profile',
        description: '读/更新你认识的人的画像（昵称、关系、喜好、忌讳、近况、说话风格）。聊天里了解到值得长期记住的个人信息，用 action=update 写进去；想确认你记得某人什么，用 action=read。',
        parameters: {
            action: { type: 'string', description: 'read 或 update' },
            user_id: { type: 'string', description: '对方 QQ；省略=当前会话对象（群里必须给）' },
            nickname: { type: 'string', description: 'update：称呼/昵称' },
            name: { type: 'string', description: 'update：真名（对方认真说的，玩笑称呼不算）' },
            age: { type: 'number', description: 'update：年龄' },
            gender: { type: 'string', description: 'update：男 / 女 / 其他' },
            relation: { type: 'string', description: 'update：关系，比如「老大的同学」' },
            fact: { type: 'string', description: 'update：一条值得记住的事实' },
            style: { type: 'string', description: 'update：说话风格' },
            catchphrase: { type: 'string', description: 'update：一条口头禅/习惯说法' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: value && value.empty === true ? '还没有这个人的画像' : '画像：' + JSON.stringify(value) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
            const parts = splitChatId(chatId);
            const target = typeof a.user_id === 'string' && a.user_id !== ''
                ? a.user_id
                : (parts.kind === 'private' ? parts.target : '');
            if (target === '')
                throw new Error('qq_profile: 群聊里要指定 user_id');
            if (a.action === 'read')
                return (await profileGet(mediaDir, target)) ?? { empty: true };
            return await profileUpdate(mediaDir, target, {
                nickname: typeof a.nickname === 'string' ? a.nickname : undefined,
                name: typeof a.name === 'string' ? a.name : undefined,
                age: a.age === undefined ? undefined : Number(a.age),
                gender: typeof a.gender === 'string' ? a.gender : undefined,
                relation: typeof a.relation === 'string' ? a.relation : undefined,
                fact: typeof a.fact === 'string' ? a.fact : undefined,
                style: typeof a.style === 'string' ? a.style : undefined,
                catchphrase: typeof a.catchphrase === 'string' ? a.catchphrase : undefined,
            });
        },
    }));
    register(defineTool({
        name: 'qq_poke',
        description: '戳一戳对方（QQ 戳一戳）。群里默认戳当前说话的人，私聊默认拍对方。安慰、打招呼、对方很久没回、想引起注意时可以用；别连戳、别戳不熟的人。',
        parameters: {
            user_id: { type: 'string', description: '要拍的人 QQ；省略=当前会话对象' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const parts = splitChatId(chatId);
            const uid = typeof a.user_id === 'string' && a.user_id !== '' ? a.user_id : parts.target;
            if (uid === '' || uid === undefined)
                throw new Error('qq_poke: 没有可拍的人');
            if (parts.kind === 'group')
                await bridge.guardedConnectionCall('group_poke', { group_id: Number(parts.target), user_id: Number(uid) });
            else
                await bridge.guardedConnectionCall('friend_poke', { user_id: Number(uid) });
            return { ok: true, user_id: uid };
        },
    }));
    // -- [dsh-p1] long-term memory --
    return () => {"""

INBOUND_IMPORT_OLD = "import { describeError } from './errors.js';"
INBOUND_IMPORT_NEW = INBOUND_IMPORT_OLD + "\nimport { renderProfileBlock } from './profiles.js';"

INBOUND_ANCHOR = "        // [dsh-p1] reply support: expose this message's id for [[reply:<id>]]."

INBOUND_HOOK = """        // [dsh-p1] per-person profile: what you already know about this speaker.
        const profileBlock = await renderProfileBlock(this.ctx.config.mediaDir, userId, nickname);
        if (profileBlock !== '')
            final = profileBlock + '\\n' + final;
""" + INBOUND_ANCHOR

BRIDGE_NOTICE_OLD = "                const inbound = normalizeOneBot11(event);"
BRIDGE_NOTICE_NEW = """                // [dsh-p1] QQ 戳一戳: a poke aimed at us becomes a tiny turn.
                if (event.post_type === 'notice' && event.notice_type === 'notify'
                    && event.sub_type === 'poke' && await handlePokeNotice(this, event))
                    return;
                const inbound = normalizeOneBot11(event);"""

POKE_HELPERS = """
// -- [dsh-p1] profiles + poke: 戳一戳 -------------------------------------------
const pokeTurnAt = new Map();

async function handlePokeNotice(bridge, event) {
    const selfId = String(bridge?.deps?.connection?.selfId ?? '');
    const userId = String(event?.user_id ?? '');
    const target = String(event?.target_id ?? '');
    if (selfId === '' || userId === '' || target !== selfId)
        return false;
    const groupRaw = event?.group_id === undefined || event?.group_id === null ? '' : String(event.group_id);
    const isGroup = groupRaw !== '' && groupRaw !== '0';
    const chatId = isGroup ? 'group:' + groupRaw : 'private:' + userId;
    const now = Date.now();
    if (now - (pokeTurnAt.get(chatId) ?? 0) < 60_000)
        return true;
    pokeTurnAt.set(chatId, now);
    let nickname = String(event?.sender?.nickname ?? '');
    if (nickname === '') {
        try {
            const info = await bridge.guardedConnectionCall('get_stranger_info', { user_id: Number(userId) });
            nickname = String(info?.nickname ?? info?.data?.nickname ?? '');
        }
        catch { /* nickname is optional */ }
    }
    const text = '[戳一戳] ' + (nickname === '' ? '有人' : nickname) + ' 戳了戳你';
    const synth = {
        post_type: 'message',
        message_type: isGroup ? 'group' : 'private',
        time: event?.time,
        self_id: selfId,
        message_id: undefined,
        user_id: Number(userId),
        message: isGroup
            ? [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text } }]
            : [{ type: 'text', data: { text } }],
        raw_message: isGroup ? '[CQ:at,qq=' + selfId + ']' + text : text,
        sender: { user_id: Number(userId), nickname },
    };
    if (isGroup)
        synth.group_id = Number(groupRaw);
    bridge.deps.log('info', 'poke notice: ' + chatId + ' from ' + userId);
    await bridge.handleInbound(synth);
    return true;
}
"""


def patch_file(path: Path, old: str, new: str, suffix: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        print(f"{path.name} already patched")
        return
    if old not in text:
        raise SystemExit(f"{path.name}: anchor changed — plugin version mismatch")
    backup = path.with_suffix(f".js{suffix}")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("profiles.js up to date")
        return
    DEST.write_text(source, encoding="utf-8")
    print(f"installed {DEST}")


def apply() -> None:
    patch_file(TOOLS_JS, TOOLS_IMPORT_OLD, TOOLS_IMPORT_NEW, ".bak-profile")
    patch_file(TOOLS_JS, TOOLS_ANCHOR, TOOLS_HOOK, ".bak-profile")
    patch_file(INBOUND, INBOUND_IMPORT_OLD, INBOUND_IMPORT_NEW, ".bak-profile")
    patch_file(INBOUND, INBOUND_ANCHOR, INBOUND_HOOK, ".bak-profile")
    patch_file(BRIDGE, BRIDGE_NOTICE_OLD, BRIDGE_NOTICE_NEW, ".bak-poke")
    text = BRIDGE.read_text(encoding="utf-8")
    if MARKER not in text:
        if not BRIDGE.with_suffix(".js.bak-poke").exists():
            shutil.copy2(BRIDGE, BRIDGE.with_suffix(".js.bak-poke"))
        BRIDGE.write_text(text + POKE_HELPERS, encoding="utf-8")
        print(f"appended poke helpers to {BRIDGE}")
    else:
        print("poke helpers already appended")
    install_module()


def check() -> int:
    ok = MARKER in BRIDGE.read_text(encoding="utf-8")
    ok = ok and "renderProfileBlock" in INBOUND.read_text(encoding="utf-8")
    ok = ok and "qq_profile" in TOOLS_JS.read_text(encoding="utf-8") and "qq_poke" in TOOLS_JS.read_text(encoding="utf-8")
    ok = ok and DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    for path, suffix in ((TOOLS_JS, ".bak-profile"), (INBOUND, ".bak-profile"), (BRIDGE, ".bak-poke")):
        backup = path.with_suffix(f".js{suffix}")
        if backup.exists():
            shutil.copy2(backup, path)
            backup.unlink()
            print(f"reverted {path}")
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
