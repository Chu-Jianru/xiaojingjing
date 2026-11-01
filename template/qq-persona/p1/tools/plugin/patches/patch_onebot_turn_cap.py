"""[dsh-p1] 群聊回合上限 + 旁听收紧（P5 调优，v2.02）.

3.40 的实测：群聊一个会话占全天 90% token（活跃时段 ~50 回合/小时），
随机旁听参数是早期定的，对话保活（v1.96）上线后放行量大增。

本补丁两件事：
1. 收紧随机旁听：老大 6%→3%、成员 1%→0.5%、冷却 10→15 分钟、每小时 4→3 次
   （@/叫名字/老大发言/规则触发/续话/保活窗口都不受影响——只动"纯随机"那条）；
2. 新增每群每小时总回合上限 TURN_CAP_PER_HOUR=30：非 @、非老大的放行
   （唤醒窗口/续话/规则/旁听）合计超过 30 条/小时后不再开新回合，直到下一小时。
   刷屏时段最多每小时 30 回合，正常聊天（平均 2 分钟一条）碰不到顶。

  python tools/plugin/patches/patch_onebot_turn_cap.py            # apply / refresh
  python tools/plugin/patches/patch_onebot_turn_cap.py --check
  python tools/plugin/patches/patch_onebot_turn_cap.py --revert
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
INBOUND = LIB / "inbound.js"
BAK = INBOUND.with_suffix(".js.bak-turncap")

MARKER = "[dsh-p1] turn cap"

CONST_OLD = """const PEEK_AWAKE_ROUNDS = 3;
const PEEK_ADMIN_CHANCE = 0.06;
const PEEK_MEMBER_CHANCE = 0.01;
const PEEK_COOLDOWN_MS = 600_000;
const PEEK_MAX_PER_HOUR = 4;
const PEEK_MIN_CHARS = 4;
"""
CONST_NEW = """const PEEK_AWAKE_ROUNDS = 3;
// [dsh-p1] v2.02: random-peek tightened (3.40 data: group = 90% of tokens)
const PEEK_ADMIN_CHANCE = 0.03;
const PEEK_MEMBER_CHANCE = 0.005;
const PEEK_COOLDOWN_MS = 900_000;
const PEEK_MAX_PER_HOUR = 3;
const PEEK_MIN_CHARS = 4;
// MARKER: total non-@/non-admin group turns per rolling hour; busy spam is
// capped while normal conversation (~1 msg / 2 min) never hits it.
const TURN_CAP_PER_HOUR = 30;
const turnCapState = new Map();

export function turnCapAllows(groupId, cap = TURN_CAP_PER_HOUR, now = Date.now()) {
    let st = turnCapState.get(groupId);
    if (st === undefined) {
        st = { hourStart: now, count: 0 };
        turnCapState.set(groupId, st);
    }
    if (now - st.hourStart > 3_600_000) {
        st.hourStart = now;
        st.count = 0;
    }
    if (st.count >= cap)
        return false;
    st.count += 1;
    return true;
}
"""

GUARD_OLD = """            else {
                const follow = followUpCaller.get(chatId);
"""
GUARD_NEW = """            else {
                // MARKER: hourly budget for undirected passes (wake window /
                // follow-up / rule trigger / random peek). Direct mentions and
                // the admin never pass through here, so they are never capped.
                if (!groupAdmins.includes(String(userId)) && !turnCapAllows(groupId)) {
                    this.ctx.log('debug', 'turn cap reached in ' + groupId);
                    currentTrace()?.emit('mention', { ok: false, reason: '群回合上限：本小时放行额度用完' });
                    return;
                }
                const follow = followUpCaller.get(chatId);
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def replace_once(text: str, old: str, new: str, what: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{what}: anchor found {n} times (expected 1); aborting")
    return text.replace(old, new, 1)


def apply() -> None:
    text = read(INBOUND)
    if "turnCapAllows" in text:
        print("inbound.js: already patched")
        return
    shutil.copyfile(INBOUND, BAK)
    text = replace_once(text, CONST_OLD, CONST_NEW.replace("MARKER", MARKER, 1), "peek constants + turn cap")
    text = replace_once(text, GUARD_OLD, GUARD_NEW.replace("MARKER", MARKER, 1), "cap guard")
    INBOUND.write_text(text, encoding="utf-8", newline="\n")
    print("inbound.js: peek tightened + turn cap 30/h (backup .bak-turncap)")
    print('done — truly restart DSH now (scripts\\stop-companion.cmd + schtasks /run /tn "DSH-companion-p1")')


def check() -> int:
    text = read(INBOUND)
    ok = True
    for needle in ("export function turnCapAllows", "TURN_CAP_PER_HOUR = 30", "turn cap reached", "PEEK_ADMIN_CHANCE = 0.03"):
        hit = needle in text
        print(f"inbound.js {needle[:36]}: {'ok' if hit else 'MISSING'}")
        ok = ok and hit
    return 0 if ok else 1


def revert() -> None:
    if BAK.exists():
        shutil.copyfile(BAK, INBOUND)
        print(f"restored inbound.js from {BAK.name}")
    else:
        print(f"{BAK.name}: no backup")


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
