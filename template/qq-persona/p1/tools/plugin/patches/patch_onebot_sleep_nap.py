"""v2.49: daytime naps with intent — duration, "sleep forever", "sleep all day".

Adds to onebot_sleep.js:
  - `sleepIntentOf(text)`   parse 老大's wording into a nap intent
  - `napUntilFor(intent)`   30min–4h random, fixed clock, evening, short, indefinite
  - computeStatus honours `napUntil` (wake at the end, but roll into night sleep
    instead of waking her at 22:00+ just to say goodnight again)
  - gate/tick keep `napUntil`/`napIndefinite` in sync; night sleep stays indefinite

Idempotent: re-running does nothing once the marker line is present.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
TARGET = REPO / "qq-persona" / "p1" / "tools" / "plugin" / "modules" / "onebot_sleep.js"
MARK = "// [dsh-p1] v2.49"

HELPERS = """
// [dsh-p1] v2.49: 白天小睡要说人话——「睡一会儿」30 分钟到 4 小时的随机，
// 「一直睡/睡到我叫你」就是不设时长，「睡一整天」到晚上，「睡到 8 点」按钟点。
const NAP_MIN_MS = 30 * 60_000;
const NAP_MAX_MS = 4 * 3_600_000;

export function sleepIntentOf(text) {
    const body = String(text ?? '');
    if (/(一直睡|睡到.{0,6}(叫我|喊我|你叫我|你喊我)|等我(叫|喊)|不叫(我)?就别醒|别叫醒我|睡死|别叫|不必叫)/.test(body))
        return { kind: 'indefinite', at: 0 };
    if (/(睡一整天|睡一天|整天(都)?睡|今天都睡|睡到晚上|睡到天黑)/.test(body))
        return { kind: 'evening', at: 0 };
    const clock = body.match(/睡到\\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\\s*(\\d{1,2})\\s*[点:：]/);
    if (clock) {
        let hour = Number(clock[2]);
        if (/(下午|傍晚|晚上)/.test(clock[1] || '') && hour < 12)
            hour += 12;
        return { kind: 'clock', at: hour };
    }
    if (/(眯一会|眯一下|眯一会儿|小睡|打个盹|睡一会儿|睡一小会|睡半(个)?小时|睡二十分钟)/.test(body))
        return { kind: 'short', at: 0 };
    return { kind: 'random', at: 0 };
}

export function napUntilFor(intent, now) {
    const kind = String(intent && intent.kind ? intent.kind : 'random');
    if (kind === 'indefinite')
        return 0;
    if (kind === 'evening') {
        const d = new Date(now);
        d.setHours(22, 0, 0, 0);
        let at = d.getTime();
        if (at <= now)
            at += 24 * 3_600_000;
        return at;
    }
    if (kind === 'short')
        return now + (20 + Math.floor(Math.random() * 20)) * 60_000;
    if (kind === 'clock') {
        const hour = Math.max(0, Math.min(23, Number(intent.at) || 0));
        const d = new Date(now);
        d.setHours(hour, 0, 0, 0);
        let at = d.getTime();
        if (at <= now)
            at += 24 * 3_600_000;
        return at;
    }
    const span = NAP_MAX_MS - NAP_MIN_MS;
    return now + NAP_MIN_MS + Math.floor(Math.random() * span);
}
"""

ASLEEP_OLD = """    if (state.status === 'asleep') {
        // 睡眠窗内就是睡；07:00-09:00 自然醒。窗口外（白天被叫去睡，或重启后错过
        // 醒来窗口）最多睡 NAP_CAP_MS，否则她会一直判成睡着，直到第二天早上才醒。
        if (asleepWindow)
            return 'asleep';
        if (m >= 7 * 60 && m < 9 * 60)
            return 'awake';
        const sleptFor = now - Number(state.asleepAt || 0);
        if (sleptFor < NAP_CAP_MS)
            return 'asleep';
        return (m >= 23 * 60 || m < 60) ? 'winding' : 'awake';
    }"""

ASLEEP_NEW = """    if (state.status === 'asleep') {
        // [dsh-p1] v2.49: 白天小睡有时长（napUntil）；「一直睡」= napUntil 0 且
        // napIndefinite 1，只有老大喊「快起床」才醒；夜里睡下也是 0，早上自然醒。
        const until = Number(state.napUntil || 0);
        if (until > 0) {
            if (now < until)
                return 'asleep';
            // 到点了，但如果已经进了夜里（22:00 之后 / 01:00–07:00），就顺势接着睡，
            // 不把她叫醒一下再睡——那会多一次「晚安」，两个作息指令就打架了。
            if (asleepWindow || m >= 22 * 60)
                return 'asleep';
            return 'awake';
        }
        if (asleepWindow)
            return 'asleep';
        if (m >= 7 * 60 && m < 9 * 60)
            return 'awake';
        if (Number(state.napIndefinite || 0) > 0)
            return 'asleep'; // 「一直睡，等我叫你」
        const sleptFor = now - Number(state.asleepAt || 0);
        if (sleptFor < NAP_FLOOR_MS)
            return 'asleep';
        return 'awake'; // 夜睡错过了醒来窗口（比如重启到中午）：白天就醒着，别装死
    }"""

GATE_OLD = """        // 下一分钟 tick 时再生效，避免同一轮的提示词里就写着「睡觉中」。
        state.sleepPendingAt = now;"""

GATE_NEW = """        // 下一分钟 tick 时再生效，避免同一轮的提示词里就写着「睡觉中」。
        state.sleepIntent = sleepIntentOf(body);
        state.sleepPendingAt = now;"""

WAKE_OLD = """            state.sleepPendingAt = 0; // 刚说睡又被叫起来：别再被待办放倒
            return { drop: false, wake: true, status: 'awake' };"""

WAKE_NEW = """            state.sleepPendingAt = 0; // 刚说睡又被叫起来：别再被待办放倒
            state.napUntil = 0;
            state.napIndefinite = 0;
            state.sleepIntent = null;
            return { drop: false, wake: true, status: 'awake' };"""

PENDING_OLD = """    if (Number(state.sleepPendingAt) > 0 && now >= Number(state.sleepPendingAt)) {
        state.sleepPendingAt = 0;
        state.status = 'asleep';
        state.asleepAt = now;
        state.wakeAt = 0;"""

PENDING_NEW = """    if (Number(state.sleepPendingAt) > 0 && now >= Number(state.sleepPendingAt)) {
        state.sleepPendingAt = 0;
        const intent = state.sleepIntent && typeof state.sleepIntent === 'object' ? state.sleepIntent : { kind: 'random' };
        state.napUntil = napUntilFor(intent, now);
        state.napIndefinite = intent.kind === 'indefinite' ? 1 : 0;
        state.sleepIntent = null;
        state.status = 'asleep';
        state.asleepAt = now;
        state.wakeAt = 0;"""

NIGHT_OLD = """    if (status === 'asleep' && previous !== 'asleep') {
        state.asleepAt = now;
        return { status, wentToSleep: true, woke: false };"""

NIGHT_NEW = """    if (status === 'asleep' && previous !== 'asleep') {
        state.asleepAt = now;
        // 到点自然睡下的是「夜睡」：不设时长，早上 07:00–09:00 自然醒。
        state.napUntil = 0;
        state.napIndefinite = 0;
        return { status, wentToSleep: true, woke: false };"""


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    if MARK in text:
        print("onebot_sleep.js: already patched (v2.49)")
        return 0
    pairs = [
        ("NAP_CAP declaration anchor", "const NAP_CAP_MS = 120 * 60_000; // 白天小睡上限：2 小时", None),
        ("computeStatus asleep", ASLEEP_OLD, ASLEEP_NEW),
        ("gate pending", GATE_OLD, GATE_NEW),
        ("gate wake", WAKE_OLD, WAKE_NEW),
        ("tick pending", PENDING_OLD, PENDING_NEW),
        ("tick night", NIGHT_OLD, NIGHT_NEW),
    ]
    for name, old, new in pairs:
        if new is None:
            continue
        if old not in text:
            print(f"anchor missing: {name}")
            return 2
        text = text.replace(old, new)
    # 常量定义紧跟 SLEEP_NOW_RE 之后
    anchor = "const NAP_CAP_MS = 120 * 60_000; // 白天小睡上限：2 小时"
    if anchor not in text:
        print("anchor missing: NAP_CAP constant")
        return 2
    text = text.replace(anchor, "const NAP_FLOOR_MS = 30 * 60_000; // 刚睡下 30 分钟内别被别的规则叫醒\n" + HELPERS)
    io.open(TARGET, "w", encoding="utf-8", newline="\n").write(text)
    print("onebot_sleep.js: nap intent patch applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
