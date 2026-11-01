"""v2.62: 「正在入睡」过渡态（falling）——10 分钟内睡着，被打断就醒。

行为：
- 老大说「快睡/睡吧/去睡/该睡了/赶紧睡…」→ 进入 falling（10 分钟倒计时），这条消息照样回；
- 她自己说「我睡了/去睡了/要睡了」→ 同样进入 falling；
- falling 期间任何人说话（含老大普通的话）→ 立刻苏醒，取消倒计时，正常回话；
- 10 分钟内没人打断 → 落 asleep：白天按小睡限制（30min–4h 或「一直睡」），夜里按时起床；
- 老大喊起床/醒醒 在 falling 里也直接取消。
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
LIB = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib"
SLEEP = LIB / "sleep.js"
INBOUND = LIB / "inbound.js"
REPLY = LIB / "reply.js"
MARK = "// [dsh-p1] v2.62"

SLEEP_CONST = """const FALLING_MS = 10 * 60_000; // [dsh-p1] v2.62: 正在入睡（被打断就醒）
"""

SLEEP_NOW_NEW = """const SLEEP_NOW_RE = /(立刻|马上|立即|现在|赶紧|这就|快|早点|该)[^。！？!?\\n]{0,6}(去)?(睡|躺下|歇)|睡吧|去睡觉|睡觉去|该睡了|赶紧睡|快睡|早点睡|先睡了/;"""

COMPUTE_INSERT = """    const override = Number(state.overrideUntil) > now;
    if (override)
        return 'awake'; // [dsh-p1] v2.62: 老大说别睡/再陪我 → 高于 falling
    if (Number(state.sleepPendingAt) > now)
        return 'falling';
"""

GATE_FALLING = """    if (status === 'falling') {
        // [dsh-p1] v2.62: 正在入睡，谁说话都算打断 —— 直接苏醒，正常回话
        state.sleepPendingAt = 0;
        state.sleepIntent = null;
        state.wokenAt = now;
        return { drop: false, wake: true, status: 'awake', wokeFromFalling: true };
    }
"""

SLEEP_ORDER = """    if (isAdmin && SLEEP_NOW_RE.test(body) && !NO_SLEEP_RE.test(body)) {
        // [dsh-p1] v2.62: 先进入「正在入睡」，10 分钟内没人打断才真睡
        state.overrideUntil = 0;
        state.extendUntil = 0;
        state.sleepIntent = sleepIntentOf(body);
        state.sleepPendingAt = now + FALLING_MS;
        state.fallingAt = now;
        return { drop: false, wake: false, sleep: true, status };
    }
"""

INBOUND_LABEL_OLD = """        let sleepLabel = sleepPhase === 'asleep' ? '睡觉中' : (sleepPhase === 'winding' ? '睡前时段' : '醒着');"""
INBOUND_LABEL_NEW = """        let sleepLabel = sleepPhase === 'asleep' ? '睡觉中'
            : sleepPhase === 'falling' ? '正犯困，快睡着了'
                : (sleepPhase === 'winding' ? '睡前时段' : '醒着');"""

INBOUND_NOTE_OLD = """        else if (Number(sleepNow.noSleepUntil) > Date.now())"""
INBOUND_NOTE_NEW = """        else if (sleepPhase === 'falling')
            sleepNote = '（你正在入睡，十分钟内没人打扰就睡着了；这一句有人说话就把你弄醒了，正常接）';
        else if (Number(sleepNow.noSleepUntil) > Date.now())"""


def patch_sleep() -> str:
    text = io.open(SLEEP, encoding="utf-8").read()
    if MARK in text:
        return "sleep.js already"
    if "const SLEEP_NOW_RE = " not in text:
        return "sleep.js: SLEEP_NOW_RE missing"
    start = text.index("const SLEEP_NOW_RE = ")
    end = text.index("\n", start)
    text = text[:start] + SLEEP_NOW_NEW + text[end:]
    text = text.replace("const NAP_FLOOR_MS", SLEEP_CONST + "const NAP_FLOOR_MS", 1)
    text = text.replace("""    if (Number(state.overrideUntil) > now)
        return 'awake';""", COMPUTE_INSERT.rstrip("\n"), 1)
    text = text.replace("""    if (status === 'asleep') {""", GATE_FALLING + """    if (status === 'asleep') {""", 1)
    old_order_start = text.index("    if (isAdmin && SLEEP_NOW_RE.test(body) && !NO_SLEEP_RE.test(body)) {")
    old_order_end = text.index("\n    }\n", old_order_start) + len("\n    }\n")
    text = text[:old_order_start] + SLEEP_ORDER + text[old_order_end:]
    io.open(SLEEP, "w", encoding="utf-8", newline="\n").write(text)
    return "sleep.js patched"


def patch_inbound() -> str:
    text = io.open(INBOUND, encoding="utf-8").read()
    if INBOUND_LABEL_OLD not in text or INBOUND_NOTE_OLD not in text:
        return "inbound.js: anchors missing"
    text = text.replace(INBOUND_LABEL_OLD, INBOUND_LABEL_NEW, 1)
    text = text.replace(INBOUND_NOTE_OLD, INBOUND_NOTE_NEW, 1)
    io.open(INBOUND, "w", encoding="utf-8", newline="\n").write(text)
    return "inbound.js patched"


def patch_reply() -> str:
    text = io.open(REPLY, encoding="utf-8").read()
    if MARK + " self" in text:
        return "reply.js already"
    anchor = "        const ids = await bridge.sendToChat(chatId, text, {"
    if anchor not in text:
        return "reply.js: anchor missing"
    hook = """        // [dsh-p1] v2.62: 她自己说要去睡 —— 进「正在入睡」，10 分钟内没人说话就睡着
        if (/(我|小鲸鲸)?(先|这就|马上)?(去)?(睡|躺)了|睡觉去了|要睡了|困得不行.{0,4}睡/.test(plain)) {
            try {
                const st = await loadSleep(bridge.deps.config.mediaDir);
                if (computeStatus(st, Date.now()) === 'awake') {
                    st.sleepPendingAt = Date.now() + 10 * 60_000;
                    st.sleepIntent = { kind: 'random' };
                    st.fallingAt = Date.now();
                    await saveSleep(bridge.deps.config.mediaDir, st);
                }
            }
            catch { /* 记不上就只是她嘴上说说 */ }
        }
"""
    text = text.replace(anchor, hook + anchor, 1)
    io.open(REPLY, "w", encoding="utf-8", newline="\n").write(text)
    return "reply.js patched"


def main() -> int:
    for fn in (patch_sleep, patch_inbound, patch_reply):
        print(fn())
    return 0


if __name__ == "__main__":
    sys.exit(main())
