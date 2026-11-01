/**
 * [dsh-p1] 作息 (sleep schedule) for 小鲸鲸.
 *
 * 23:00–01:00 wind-down: she stays awake while someone is still chatting, says
 * goodnight when she actually lies down, and must be asleep by 01:00.
 * 01:00–07:00 hard sleep: messages are dropped (even 老大's), except 老大 can
 * wake her with 「快起床」. 07:00–09:00 she is up. 老大 can also say 「别睡」 to
 * extend the evening; others can ask for a short extension (capped).
 *
 * Stored in <mediaDir>/sleep.json:
 *   {status: 'awake'|'winding'|'asleep', asleepAt, wakeAt, extendUntil,
 *    lastActiveAt, lastGoodnightAt}
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILE = 'sleep.json';
const IDLE_SLEEP_MS = 20 * 60_000;
const OTHERS_EXTEND_MS = 20 * 60_000;
const ADMIN_EXTEND_MS = 60 * 60_000;

let cache = { at: 0, mediaDir: '', state: null };

function pathFor(mediaDir) {
    return join(mediaDir, FILE);
}

function minutesOfDay(now) {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
}

function atClock(now, hour, minute = 0) {
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
}

/** Next occurrence of a clock time (rolls to tomorrow when already past). */
function nextClock(now, hour, minute = 0) {
    const t = atClock(now, hour, minute);
    if (t <= now) {
        const d = new Date(t);
        d.setDate(d.getDate() + 1);
        return d.getTime();
    }
    return t;
}

export function freshState(now = Date.now()) {
    return {
        status: 'awake',
        asleepAt: 0,
        wakeAt: 0,
        extendUntil: 0,
        lastActiveAt: now,
        lastGoodnightAt: 0,
        overrideUntil: 0,
        wokenAt: 0,
        noSleepUntil: 0,
    };
}

/** Pure: what should the status be at `now`, given the stored state? */
export function computeStatus(state, now) {
    // An explicit wake/keep-awake overrides the clock window.
    const override = Number(state.overrideUntil) > now;
    if (override)
        return 'awake'; // [dsh-p1] v2.62: 老大说别睡/再陪我 → 高于 falling
    if (Number(state.sleepPendingAt) > now)
        return 'falling';
    const m = minutesOfDay(now);
    const asleepWindow = m >= 60 && m < 7 * 60; // 01:00–07:00
    if (state.status === 'asleep') {
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
    }
    if (asleepWindow) {
        // 老大说了「再陪我会儿」、宽限还没到点：01:00 的硬睡让位（最多撑到 02:30）。
        if (Number(state.extendUntilAdmin ?? 0) > now)
            return 'winding';
        return 'asleep';
    }
    if (m >= 23 * 60 || m < 60)
        return 'winding';
    return 'awake';
}

/** Hard sleep time tonight (01:00 after the current evening). */
export function hardSleepAt(now) {
    const m = minutesOfDay(now);
    const d = new Date(now);
    if (m < 60)
        d.setDate(d.getDate()); // 00:xx today → 01:00 today
    else {
        d.setDate(d.getDate() + 1); // 23:xx → 01:00 tomorrow
    }
    d.setHours(1, 0, 0, 0);
    return d.getTime();
}

export function lastActive(state) {
    return Number(state.lastActiveAt) || 0;
}

/** Someone sent a message: maybe extend the evening. */
export function noteMessage(state, now, userId, text, admins = []) {
    state.lastActiveAt = now;
    const status = computeStatus(state, now);
    if (status !== 'winding')
        return state;
    const body = String(text ?? '');
    const asks = /(别睡|再陪|再聊|陪我|晚点睡|等会儿睡|再待)/.test(body);
    if (!asks)
        return state;
    const isAdmin = admins.map(String).includes(String(userId));
    const cap = isAdmin ? nextClock(now, 2, 30) : nextClock(now, 1, 30);
    const next = Math.min(now + (isAdmin ? ADMIN_EXTEND_MS : OTHERS_EXTEND_MS), cap);
    state.extendUntil = Math.max(state.extendUntil ?? 0, next);
    // 老大给的宽限最多到 02:30，那就得真能撑过 01:00，不然等于骗他；非老大只到 01:30。
    if (isAdmin && next > Number(state.extendUntilAdmin ?? 0))
        state.extendUntilAdmin = next;
    return state;
}

/**
 * [dsh-p1] v2.45: 老大白天也能一句话让她真的去睡。
 * 只认「立刻/马上/立即/现在/赶紧/这就 + 睡」这种即时句；「快睡/睡觉吧」仍按人格规则只当提醒。
 */
const SLEEP_NOW_RE = /(立刻|马上|立即|现在|赶紧|这就|快|早点|该)[^。！？!?\n]{0,6}(去)?(睡|躺下|歇)|睡吧|去睡觉|睡觉去|该睡了|赶紧睡|快睡|早点睡|先睡了/;
const NO_SLEEP_RE = /(别睡|不睡|先别睡|别去睡|不许睡)/;
const FALLING_MS = 10 * 60_000; // [dsh-p1] v2.62: 正在入睡（被打断就醒）
const NAP_FLOOR_MS = 30 * 60_000; // 刚睡下 30 分钟内别被别的规则叫醒

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
    const clock = body.match(/睡到\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点:：]/);
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


/**
 * Should this message be dropped? Returns {drop, wake, sleep}.
 * Asleep → drop everything except 老大's wake command.
 * Awake + 老大's immediate sleep order → 落状态，但这条放过去（她要回一句晚安）。
 */
// [dsh-p1] v2.50: 唤醒意图识别。她说睡就真睡，但老大一喊就得醒——所以这里宁可宽一点。
const WAKE_RE = /(起床|醒醒|醒一醒|醒了吗|醒了没|别睡|不睡|睡够|该起了|起吧|还睡|还在睡|睡到几点|几点了|睁开眼|叫我起来|叫你起来|喊你起来|(?<![听看说想站坐拿捡收搬叫喊道])起来)/;

export function looksLikeWake(text) {
    return WAKE_RE.test(String(text ?? ''));
}
export function gate(state, now, userId, text, admins = []) {
    const status = computeStatus(state, now);
    const body = String(text ?? '');
    const isAdmin = admins.map(String).includes(String(userId));
    if (status === 'falling') {
        // [dsh-p1] v2.62: 正在入睡，谁说话都算打断 —— 直接苏醒，正常回话
        state.sleepPendingAt = 0;
        state.sleepIntent = null;
        state.wokenAt = now;
        return { drop: false, wake: true, status: 'awake', wokeFromFalling: true };
    }
    if (status === 'asleep') {
        // [dsh-p1] v2.50: 不再只认一句「快起床」。老大怎么喊都行——起床/醒醒/别睡了/
        // 还睡呢/几点了/叫我起来……只要意思够明确就叫醒她；「听起来/想起来」这类不算。
        if (isAdmin && looksLikeWake(body)) {
            state.sleepPendingAt = 0; // 刚说睡又被叫起来：别再被待办放倒
            state.napUntil = 0;
            state.napIndefinite = 0;
            state.sleepIntent = null;
            return { drop: false, wake: true, status: 'awake' };
        }
        return { drop: true, wake: false, status };
    }
    if (isAdmin && SLEEP_NOW_RE.test(body) && !NO_SLEEP_RE.test(body)) {
        // [dsh-p1] v2.62: 先进入「正在入睡」，10 分钟内没人打断才真睡
        state.overrideUntil = 0;
        state.extendUntil = 0;
        state.sleepIntent = sleepIntentOf(body);
        state.sleepPendingAt = now + FALLING_MS;
        state.fallingAt = now;
        return { drop: false, wake: false, sleep: true, status };
    }
    return { drop: false, wake: false, status };
}

/** Called every minute by the bridge. Returns {status, wentToSleep, woke}. */
export function tick(state, now) {
    const previous = state.status;
    let status = computeStatus(state, now);
    // 老大白天叫醒也会把 override 顶到「明早 07:00」，那是十几小时；白天被叫醒
    // 不该因此整宿不睡。睡眠窗外超过 6 小时的 override 收到 6 小时，
    // 到 23:00 仍会正常进入睡前时段。
    const minuteNow = minutesOfDay(now);
    const hardWindow = minuteNow >= 60 && minuteNow < 7 * 60;
    if (!hardWindow && Number(state.overrideUntil) - now > 6 * 3_600_000) {
        state.overrideUntil = now + 6 * 3_600_000;
        state.wakeCappedAt = now;
    }
    const override = Number(state.overrideUntil) > now;
    if (override)
        status = 'awake';
    if (status === 'winding') {
        const hard = hardSleepAt(now);
        const idle = now - lastActive(state) >= IDLE_SLEEP_MS;
        const extended = Number(state.extendUntil) > now;
        const adminExtended = extended && Number(state.extendUntilAdmin ?? 0) > now;
        if ((now >= hard && !adminExtended) || (idle && !extended))
            status = 'asleep';
    }
    // [dsh-p1] v2.45: 老大白天的一句「立刻/马上睡」——这条消息已经让她回过晚安了，
    // 下一分钟把她真正放倒。override/extend 已在 gate 里清过，这里不再动它。
    if (Number(state.sleepPendingAt) > 0 && now >= Number(state.sleepPendingAt)) {
        state.sleepPendingAt = 0;
        const intent = state.sleepIntent && typeof state.sleepIntent === 'object' ? state.sleepIntent : { kind: 'random' };
        state.napUntil = napUntilFor(intent, now);
        state.napIndefinite = intent.kind === 'indefinite' ? 1 : 0;
        state.sleepIntent = null;
        state.status = 'asleep';
        state.asleepAt = now;
        state.wakeAt = 0;
        return { status: 'asleep', wentToSleep: previous !== 'asleep', woke: false };
    }
    state.status = status;
    if (status === 'asleep' && previous !== 'asleep') {
        state.asleepAt = now;
        // 到点自然睡下的是「夜睡」：不设时长，早上 07:00–09:00 自然醒。
        state.napUntil = 0;
        state.napIndefinite = 0;
        return { status, wentToSleep: true, woke: false };
    }
    if (status === 'awake' && previous === 'asleep') {
        state.wakeAt = now;
        return { status, wentToSleep: false, woke: true };
    }
    return { status, wentToSleep: false, woke: false };
}

export async function loadSleep(mediaDir) {
    const now = Date.now();
    if (cache.mediaDir === mediaDir && cache.state !== null && now - cache.at < 5_000)
        return cache.state;
    let state = freshState(now);
    try {
        const parsed = JSON.parse(await readFile(pathFor(mediaDir), 'utf8'));
        if (parsed !== null && typeof parsed === 'object')
            state = { ...state, ...parsed };
    }
    catch { /* first run */ }
    cache = { at: now, mediaDir, state };
    return state;
}

export async function saveSleep(mediaDir, state) {
    await mkdir(dirname(pathFor(mediaDir)), { recursive: true });
    await writeFile(pathFor(mediaDir), JSON.stringify(state, null, 1), 'utf8');
    cache = { at: Date.now(), mediaDir, state };
}

export function resetSleepCache() {
    cache = { at: 0, mediaDir: '', state: null };
}

/** Generate from the live chat; a phrase pool is still a fixed reply. */
export async function dispatchSleepGreeting(bridge, chatId, phase) {
    if (chatId === '' || !['asleep', 'awake'].includes(phase))
        return false;
    const event = phase === 'asleep' ? '你现在准备睡下' : '你现在刚醒来';
    try {
        await bridge.dispatchFollowup(chatId,
            '[作息事件] ' + event + '。这不是对方新发的消息。结合最近对话、关系和当下状态，自己决定是否轻轻说一句收尾或招呼；没由头或刚说过就 [不回]。不使用固定台词、不编经历、不点评事件、不发操作指令。',
            'member'); // an internal event never grants the admin's tools
        return true;
    }
    catch (error) {
        bridge.deps?.log?.('warn', 'sleep greeting dispatch failed: ' + String(error));
        return false; // no canned fallback
    }
}

// -- [dsh-p1] sleep settle passthrough (v2.27) --------------------------------
// 同意/拒绝 QQ号 are admin actions on a pending friend request, not chat: they
// must settle even while she is asleep, and must not wake her. The bridge
// checks this before the sleep gate and skips the drop. bridge.js's
// handleFriendApprovalReply owns the authoritative parsing of these shapes —
// keep the two anchored regexes in sync with it.
const SETTLE_FULL_RE = /^\/?(同意|通过|拒绝|不同意)\s*(?:QQ|qq)?\s*[:：]?\s*\d{5,}$/;
const SETTLE_BARE_RE = /^\/?(同意|通过|拒绝|不同意)(?:这个|这条|一下)?$/;

export function isAdminSettleText(text) {
    const cleaned = String(text ?? '')
        .replace(/\[CQ:[^\]]*\]/g, '')             // OneBot CQ codes (reply quotes)
        .replace(/^\[(引用|回复)\]\s*/, '')          // normalized reply prefix
        .replace(/^[\s「『"'“”‘’（(【\[]+/, '')
        .replace(/[\s」』"'“”‘’）)】\]]+$/, '')
        .trim();
    return SETTLE_FULL_RE.test(cleaned) || SETTLE_BARE_RE.test(cleaned);
}
