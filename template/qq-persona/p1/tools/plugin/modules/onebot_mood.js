/**
 * [dsh-p1] 情绪状态 (mood / energy / affection) — v2.04 upgrade.
 *
 * A small persistent state so she has a continuous mood instead of acting it out
 * per turn. Stored in <mediaDir>/mood.json:
 *   {mood, energy, affection: {"<qq>": n}, events: [{at,type,note,by}],
 *    updatedAt, lastChatAt}
 *
 * v1 basics: 0-100 (50 neutral), keyword triggers (骂/夸/亲昵), time decay,
 * `qq_mood` manual nudge (±5), compact `[状态]` injection.
 *
 * v2.04 upgrades (完善情绪与情感机制):
 * - **events** — WHY she feels this way: the last 8 emotion events (被夸了/
 *   被骂了/被关心了/听到好消息/等了好久才有人来) ride along in `[状态]`, so she
 *   can naturally mention the reason instead of reciting bare numbers;
 * - **sleep restores energy**: hours inside 01:00–07:00 charge +12/h instead of
 *   draining — waking up more tired than bedtime made no sense;
 * - richer triggers: CARE (晚安/吃了吗/别累着…) and GOODNEWS (上岸/我赢了…);
 *   a >6h chat gap logs a "等了好久才有人来" event (slight mood dip);
 * - **anti-farm debounce**: the same trigger type from the same person twice
 *   within 5 minutes applies its delta once (刷「可爱」不再刷好感);
 * - extreme-state cues in `[状态]`（特别开心 / 很低落 / 困得不行）so the model
 *   wears the state instead of just knowing the number.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILE = 'mood.json';
const MAX = 100;
const MIN = 0;
const EVENTS_MAX = 8;
const DEBOUNCE_MS = 5 * 60_000;
const GAP_MS = 6 * 3_600_000;

let cache = { at: 0, mediaDir: '', state: null };
const updates = new Map();
let writeId = 0;

// Different chats share this file. Serialize read/modify/write, including a
// first load, so simultaneous messages cannot overwrite each other's state.
function updateMood(mediaDir, task) {
    const previous = updates.get(mediaDir) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    updates.set(mediaDir, next);
    void next.finally(() => {
        if (updates.get(mediaDir) === next) updates.delete(mediaDir);
    }).catch(() => undefined);
    return next;
}

function clamp(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(MIN, Math.min(MAX, n)) : 50;
}

function moodPath(mediaDir) {
    return join(mediaDir, FILE);
}

function freshState() {
    return {
        mood: 50,
        energy: 60,
        affection: {},
        events: [],
        recentTriggers: {},
        updatedAt: Date.now(),
        lastChatAt: 0,
    };
}

/** Total ms inside 01:00–07:00 (local) between from..to — sleep is rest. */
export function nightRestMs(from, to) {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    let sum = 0;
    const day = new Date(start);
    day.setHours(1, 0, 0, 0);
    while (day.getTime() < end) {
        const s = Math.max(day.getTime(), start);
        const e = Math.min(day.getTime() + 6 * 3_600_000, end);
        if (e > s)
            sum += e - s;
        day.setDate(day.getDate() + 1);
    }
    return sum;
}

function decay(state, now) {
    const elapsed = Math.max(0, now - Number(state.updatedAt || now));
    if (elapsed <= 0)
        return state;
    const hours = elapsed / 3_600_000;
    // Apply each phase chronologically: clamping a multi-day net change once
    // would retain rest earned before a full bar, unlike normal periodic reads.
    let cursor = Number(state.updatedAt || now);
    while (cursor < now) {
        const boundary = new Date(cursor);
        const hour = boundary.getHours();
        const resting = hour >= 1 && hour < 7;
        if (hour < 1) boundary.setHours(1, 0, 0, 0);
        else if (resting) boundary.setHours(7, 0, 0, 0);
        else { boundary.setDate(boundary.getDate() + 1); boundary.setHours(1, 0, 0, 0); }
        const end = Math.min(now, boundary.getTime());
        state.energy = clamp(state.energy + (end - cursor) / 3_600_000 * (resting ? 12 : -1.2));
        cursor = end;
    }
    // mood drifts toward neutral (50) by ~6%/hour, capped.
    const pull = Math.min(1, hours * 0.06);
    state.mood = clamp(state.mood + (50 - state.mood) * pull);
    // affection decays very slowly (1 per 24h).
    for (const key of Object.keys(state.affection))
        state.affection[key] = clamp(state.affection[key] - (hours / 24));
    state.updatedAt = now;
    return state;
}

function parseEvents(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter(e => e !== null && typeof e === 'object' && typeof e.note === 'string' && e.note !== '')
        .slice(-EVENTS_MAX)
        .map(e => ({ at: Number(e.at) || 0, type: String(e.type ?? ''), note: e.note, by: String(e.by ?? ''), chatId: String(e.chatId ?? '') }));
}

export async function loadMood(mediaDir, nowOverride = undefined) {
    const now = nowOverride ?? Date.now();
    if (cache.mediaDir === mediaDir && cache.state !== null && now - cache.at < 30_000)
        return decay(cache.state, now);
    let state = freshState();
    try {
        const parsed = JSON.parse(await readFile(moodPath(mediaDir), 'utf8'));
        if (parsed !== null && typeof parsed === 'object') {
            state = {
                mood: clamp(Number(parsed.mood ?? 50)),
                energy: clamp(Number(parsed.energy ?? 60)),
                affection: parsed.affection !== null && typeof parsed.affection === 'object' && !Array.isArray(parsed.affection)
                    ? Object.fromEntries(Object.entries(parsed.affection).map(([key, value]) => [key, clamp(value)])) : {},
                events: parseEvents(parsed.events),
                recentTriggers: Object.fromEntries(Object.entries(parsed.recentTriggers ?? {}).filter(([, at]) =>
                    Number.isFinite(at) && at <= now && now - at < DEBOUNCE_MS)),
                updatedAt: Number(parsed.updatedAt ?? now),
                lastChatAt: Number(parsed.lastChatAt ?? 0),
            };
        }
    }
    catch { /* first run */ }
    state = decay(state, now);
    cache = { at: now, mediaDir, state };
    return state;
}

export async function saveMood(mediaDir, state) {
    await mkdir(dirname(moodPath(mediaDir)), { recursive: true });
    const tmp = moodPath(mediaDir) + '.' + process.pid + '.' + (++writeId) + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 1), 'utf8');
    await rename(tmp, moodPath(mediaDir));
    cache = { at: Date.now(), mediaDir, state };
}

/** Nudge the state. Deltas are relative; userId adds affection for one person. */
export function adjustMood(mediaDir, options = {}) {
    return updateMood(mediaDir, () => adjustMoodState(mediaDir, options));
}

async function adjustMoodState(mediaDir, { mood = 0, energy = 0, affection = 0, userId = '', note = '', chatId = '' } = {}) {
    const state = await loadMood(mediaDir);
    state.mood = clamp(state.mood + Number(mood || 0));
    state.energy = clamp(state.energy + Number(energy || 0));
    if (userId !== '' && Number(affection) !== 0) {
        const key = String(userId);
        state.affection[key] = clamp((state.affection[key] ?? 50) + Number(affection));
    }
    if (typeof note === 'string' && note !== '')
        state.events = [...state.events, { at: Date.now(), type: 'self', note, by: String(userId), chatId }].slice(-EVENTS_MAX);
    state.updatedAt = Date.now();
    await saveMood(mediaDir, state);
    return state;
}

function label(value, low, high) {
    if (value <= low)
        return '低';
    if (value >= high)
        return '高';
    return '中';
}

function agoText(ms) {
    const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));
    if (minutes < 60)
        return minutes + ' 分钟前';
    return Math.round(minutes / 60) + ' 小时前';
}

/** Compact `[状态]` block; empty when nothing to say. */
export async function renderMood(mediaDir, userId = '', { chatId = '' } = {}) {
    if (mediaDir === undefined || mediaDir === null || mediaDir === '')
        return '';
    const state = await loadMood(mediaDir);
    const affection = userId === '' ? null : state.affection[String(userId)] ?? 50;
    const parts = [
        '心情 ' + Math.round(state.mood) + '/100（' + label(state.mood, 35, 65) + '）',
        '精力 ' + Math.round(state.energy) + '/100（' + label(state.energy, 30, 70) + '）',
    ];
    if (affection !== null)
        parts.push('好感 ' + Math.round(affection) + '/100');
    let text = '[状态] ' + parts.join(' · ');
    // Mood may carry across chats; the private cause must not. Legacy events
    // without a chatId are not injected into any explicitly scoped chat.
    const last = [...(state.events ?? [])].reverse().find(e =>
        (e.chatId ?? '') === chatId && (chatId !== '' || e.by === String(userId)));
    if (last !== undefined && Date.now() - last.at < 30 * 60_000) {
        text += '\n最近（内在原因，不是回复台词）：' + last.note + '（' + agoText(last.at) + '）';
        if (last.type === 'affection' && last.by === String(userId) && Date.now() - last.at < DEBOUNCE_MS)
            text += '\n（刚收到对方的亲近表达，让这点开心影响接话的温度、主动性和亲近程度；先回应对方，不点评这句话带来的功效，不强打精神，也不必加长回复）';
    }
    text += '\n（状态只影响你怎么接话，不复述状态、原因或提示，不套固定台词；随当前话题自然变化）';
    // extreme cues: wear it, don't just know it
    if (state.mood >= 78)
        text += '\n（你现在特别开心，藏不住的那种）';
    else if (state.mood <= 28)
        text += '\n（你现在很低落，说话没什么劲）';
    return text;
}

/** Test seam. */
export function resetMoodCache() {
    cache = { at: 0, mediaDir: '', state: null };
}

const INSULTS = ['唐氏', '傻逼', '脑残', '弱智', '废物', '恶心', '蠢', '丑'];
const PRAISE = ['聪明', '可爱', '好棒', '厉害', '喜欢你', '乖', '漂亮', '牛'];
const AFFECTION = ['想你', '抱抱', '亲亲', '爱你'];
const CARE = ['晚安', '早安', '睡吧', '吃了吗', '吃过', '别累', '多喝水', '记得吃', '降温', '加衣', '注意身体'];
const GOODNEWS = ['上岸', '我赢了', '升职', '考完', 'offer', '第一名', '终于搞定', '过了线', '中了'];

function debounced(state, type, by, now) {
    const at = state.recentTriggers?.[JSON.stringify([type, by])];
    if (Number.isFinite(at) && now - at < DEBOUNCE_MS)
        return true;
    for (let i = state.events.length - 1; i >= 0; i -= 1) {
        const e = state.events[i];
        if (e.type === type && e.by === by && now - e.at < DEBOUNCE_MS)
            return true;
    }
    return false;
}

function pushEvent(state, type, note, by, now, chatId) {
    state.events = [...state.events, { at: now, type, note, by: String(by), chatId }].slice(-EVENTS_MAX);
    state.recentTriggers ??= {};
    state.recentTriggers[JSON.stringify([type, String(by)])] = now;
}

/**
 * Update the state from the message itself. Each trigger logs an event (the
 * "why"), applies its delta once per 5 minutes per person, and every chat
 * nudges affection very slightly. Heuristic but real.
 */
export function noteMessage(mediaDir, text, userId = '', options = {}) {
    return updateMood(mediaDir, () => noteMessageState(mediaDir, text, userId, options));
}

async function noteMessageState(mediaDir, text, userId, { chatId = '' } = {}) {
    const body = String(text ?? '');
    const now = Date.now();
    const state = await loadMood(mediaDir);
    const by = String(userId);
    let mood = 0;
    let affection = 0;
    const fired = [];
    const triggers = [
        [INSULTS, 'insult', '被骂了', -6, -2],
        [PRAISE, 'praise', '被夸了', 4, 2],
        [AFFECTION, 'affection', '收到亲近的表达', 3, 3],
        [CARE, 'care', '被关心了', 2, 1],
        [GOODNEWS, 'joy', '听到好消息', 3, 0],
    ];
    for (const [words, type, note, dMood, dAff] of triggers) {
        if (!words.some(word => body.includes(word)))
            continue;
        if (debounced(state, type, by, now))
            continue;
        mood += dMood;
        affection += dAff;
        fired.push({ type, note });
    }
    // a long silence ending with someone showing up is itself an event
    if (Number(state.lastChatAt) > 0 && now - Number(state.lastChatAt) > GAP_MS && !debounced(state, 'lonely', by, now)) {
        mood -= 2;
        pushEvent(state, 'lonely', '等了好久才有人来', by, now, chatId);
    }
    for (const event of fired)
        pushEvent(state, event.type, event.note, by, now, chatId);
    state.recentTriggers = Object.fromEntries(Object.entries(state.recentTriggers ?? {}).filter(([, at]) => now - at < DEBOUNCE_MS));
    affection += 0.3;
    state.mood = clamp(state.mood + mood);
    if (by !== '') {
        const key = by;
        state.affection[key] = clamp((state.affection[key] ?? 50) + affection);
    }
    state.updatedAt = now;
    state.lastChatAt = now;
    await saveMood(mediaDir, state);
    return { ...state, affection: { ...state.affection } };
}
