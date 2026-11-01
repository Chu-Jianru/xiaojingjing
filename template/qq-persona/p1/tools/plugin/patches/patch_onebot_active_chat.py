"""[dsh-p1] 活跃对话保活 + 戳一戳自动回戳（v1.96, 2026-10-25）.

两个群里「人机感」的根因修复（当天日志实锤，见 README 4.32/4.33）：

1) 聊着聊着不回了 —— 她刚在群里回过话（13:12:53/59），60 秒后群友的追问
   （13:14:13「有没有可能他没睡觉」，没 @ 也没叫名字）被群门禁静默丢弃：
   唤醒窗口（被 @ 后 3 条）已被中间消息耗尽，followUpCaller 只认「最后 @ 她
   的那个人」（不是她刚回过的人），6%/1% 随机旁听没掷中。她自己的发言不刷新
   任何状态。
   修复：inbound.js 导出 noteSelfSent(chatId)——她自己在群里发出一条消息就把
   唤醒窗口拉满；bridge.sendToChat 对 group:* 调用它。活跃对话不再被掐断。

2) 戳一戳每次都要「声明」——第一次被戳走模型回合，模型总是回
   「戳回来了，什么事呀」这类报幕句（13:17:12）。
   修复：bridge 在第一次被戳时**先自动戳回**（动作层确定性完成），合成给模型
   的文本标注「已经自动戳回去了」；提示词改成多数 [不回]、要说话也不提「戳」。

Idempotent；改的是插件代码，打完必须真重启 DSH：

  python tools/plugin/patches/patch_onebot_active_chat.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_active_chat.py --check    # patched?
  python tools/plugin/patches/patch_onebot_active_chat.py --revert   # restore backups
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
INBOUND = LIB / "inbound.js"
BRIDGE = LIB / "bridge.js"
INBOUND_BAK = INBOUND.with_suffix(".js.bak-activechat")
BRIDGE_BAK = BRIDGE.with_suffix(".js.bak-activechat")

MARKER = "[dsh-p1] active chat"

# ---- inbound.js: export the peek gate helpers + noteSelfSent -----------------

PEEK_FN_OLD = "function peekAllows(ctx, chatId, userId, text) {"
PEEK_FN_NEW = "export function peekAllows(ctx, chatId, userId, text) {"

NOTE_SENT_OLD = """function noteGroupMention(chatId) {
    peekStat(chatId).awakeLeft = PEEK_AWAKE_ROUNDS;
}
"""
NOTE_SENT_NEW = NOTE_SENT_OLD + """
/** MARKER: her own group reply keeps the conversation awake — the next
 *  PEEK_AWAKE_ROUNDS group messages pass the gate even without an @, so a
 *  flowing back-and-forth never dies mid-thread ("聊着聊着不回了",
 *  2026-10-25: her replies refreshed nothing, the wake window was consumed
 *  by intervening messages and a follow-up question was silently gated). */
export function noteSelfSent(chatId) {
    const st = peekStat(chatId);
    st.awakeLeft = Math.max(st.awakeLeft, PEEK_AWAKE_ROUNDS);
}
"""

# ---- bridge.js: import + sendToChat hook + poke auto-back --------------------

# 4.51：import 行的形状会被后来的补丁继续改（v2.20 friends 加 noteFriendAdded 把
# noteSelfSent 挤到行中间，老的整行锚 "…noteSelfSent } from './inbound.js'" 从此
# 永远 MISS）——apply/check 一律按「有没有从 './inbound.js' 导入 noteSelfSent」的
# 正则判断，形状无关；apply 用 ensure_inbound_import 往现有行里插名字。
INBOUND_IMPORT_RE = re.compile(r"import \{([^}]*)\} from '\./inbound\.js';")


def import_has(text: str, name: str) -> bool:
    m = INBOUND_IMPORT_RE.search(text)
    if not m:
        return False
    return name in [n.strip() for n in m.group(1).split(',') if n.strip()]


def ensure_inbound_import(text: str, name: str, what: str) -> str:
    m = INBOUND_IMPORT_RE.search(text)
    if not m:
        raise SystemExit(f"{what}: no import from './inbound.js' found; aborting")
    names = [n.strip() for n in m.group(1).split(',') if n.strip()]
    if name in names:
        return text
    names.append(name)
    new_line = 'import { ' + ', '.join(names) + " } from './inbound.js';"
    return text[:m.start()] + new_line + text[m.end():]



SEND_OLD = """    sendToChat(chatId, text, options = {}) {
        return this.outbound.sendToChat(chatId, text, options);
    }
"""
SEND_NEW = """    sendToChat(chatId, text, options = {}) {
        // MARKER: her own group message refreshes the wake window, so the
        // conversation she just participated in keeps reaching her.
        if (typeof chatId === 'string' && chatId.startsWith('group:'))
            noteSelfSent(chatId);
        return this.outbound.sendToChat(chatId, text, options);
    }
"""

POKE_MARK_OLD = """    pokeTextAt.set(chatId, now);
"""
POKE_MARK_NEW = """    pokeTextAt.set(chatId, now);
    // MARKER: poke back deterministically before the model turn, so the
    // action needs no narration. The synth text below tells her it already
    // happened; the prompt keeps her from poking twice or announcing it.
    await pokeBack(bridge, isGroup, groupRaw, userId);
"""

POKE_TEXT_OLD = """    const text = '[戳一戳] ' + (nickname === '' ? '有人' : nickname) + ' 戳了你一下';
"""
POKE_TEXT_NEW = """    const text = '[戳一戳] ' + (nickname === '' ? '有人' : nickname) + ' 戳了你一下（你已经自动戳回去了，别再戳同一个人）';
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def replace_once(text: str, old: str, new: str, what: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{what}: anchor found {n} times (expected 1); aborting")
    return text.replace(old, new, 1)


def apply() -> None:
    text = read(INBOUND)
    if "noteSelfSent" not in text:
        shutil.copyfile(INBOUND, INBOUND_BAK)
        text = replace_once(text, PEEK_FN_OLD, PEEK_FN_NEW, "inbound peekAllows export")
        text = replace_once(text, NOTE_SENT_OLD, NOTE_SENT_NEW.replace("MARKER", MARKER, 1), "inbound noteSelfSent")
        write(INBOUND, text)
        print("inbound.js: noteSelfSent exported (backup .bak-activechat)")
    else:
        print("inbound.js: already patched")

    text = read(BRIDGE)
    if "noteSelfSent" not in text:
        shutil.copyfile(BRIDGE, BRIDGE_BAK)
        text = ensure_inbound_import(text, "noteSelfSent", "bridge import")
        text = replace_once(text, SEND_OLD, SEND_NEW.replace("MARKER", MARKER, 1), "bridge sendToChat hook")
        text = replace_once(text, POKE_MARK_OLD, POKE_MARK_NEW.replace("MARKER", MARKER, 1), "bridge poke auto-back")
        text = replace_once(text, POKE_TEXT_OLD, POKE_TEXT_NEW, "bridge poke synth text")
        write(BRIDGE, text)
        print("bridge.js: sendToChat hook + poke auto-back (backup .bak-activechat)")
    else:
        print("bridge.js: already patched")
    print('done — truly restart DSH now (scripts\\stop-companion.cmd + schtasks /run /tn "DSH-companion-p1")')


def check() -> int:
    ok = True
    for name, path, needles in (
        ("inbound.js", INBOUND, ["export function noteSelfSent", "export function peekAllows"]),
        ("bridge.js", BRIDGE, [
            "noteSelfSent(chatId)",
            "await pokeBack(bridge, isGroup, groupRaw, userId);",
            "你已经自动戳回去了",
        ]),
    ):
        text = read(path)
        for needle in needles:
            hit = needle in text
            print(f"{name} {needle[:40]}: {'ok' if hit else 'MISSING'}")
            ok = ok and hit
    bridge_text = read(BRIDGE)
    hit = import_has(bridge_text, "noteSelfSent")
    print(f"bridge.js noteSelfSent imported from './inbound.js': {'ok' if hit else 'MISSING'}")
    return 0 if ok and hit else 1


def revert() -> None:
    for cur, bak in ((INBOUND, INBOUND_BAK), (BRIDGE, BRIDGE_BAK)):
        if bak.exists():
            shutil.copyfile(bak, cur)
            print(f"restored {cur.name} from {bak.name}")
        else:
            print(f"{bak.name}: no backup (nothing to restore)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--revert", action="store_true")
    args = parser.parse_args()
    if args.check:
        sys.exit(check())
    if args.revert:
        revert()
        return
    apply()


if __name__ == "__main__":
    main()
