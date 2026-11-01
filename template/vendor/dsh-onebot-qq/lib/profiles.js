/**
 * [dsh-p1] Per-person profiles ("画像") for 小鲸鲸.
 *
 * A small, evolving record for every person she talks to — nickname, relation,
 * style, and a few durable facts — so she can speak to each person naturally
 * instead of treating everyone the same. Storage:
 *
 *   <mediaDir>/profiles.json
 *   { "__ADMIN_QQ__": { nickname, relation, style, facts: [], msgCount,
 *                     firstSeen, updatedAt } }
 *
 * Written by the `qq_profile` tool (the model updates it when it learns
 * something worth keeping) and by `touch()` on every inbound message (nickname,
 * count, last seen). Read on every inbound: `renderProfileBlock(userId)` turns
 * the current profile into a trusted `[画像]` block (facts capped, so the prompt
 * stays small).
 *
 * Failures are logged and swallowed — a broken profile file must never stop a
 * reply.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CACHE_MS = 15_000;
const MAX_FACTS = 20;
const RENDER_FACTS = 8;

/**
 * 关系阶段（纯函数，按真实聊过的次数推进）：
 *   < 10 次 = 陌生人，10–99 次 = 熟人，>= 100 次 = 自己人。
 * 只用于提示词里的语气参考，不写库、不跳级。
 */
export function relationshipStage(msgCount) {
    const n = Number(msgCount) || 0;
    if (n >= 100) return '自己人';
    if (n >= 10) return '熟人';
    return '陌生人';
}

let cache = { at: 0, mediaDir: '', data: {} };

function errText(error) {
    return error instanceof Error ? error.message : String(error);
}

function dataPath(mediaDir) {
    return join(mediaDir, 'profiles.json');
}

async function load(mediaDir) {
    const now = Date.now();
    if (cache.mediaDir === mediaDir && now - cache.at < CACHE_MS)
        return cache.data;
    let data = {};
    try {
        const raw = await readFile(dataPath(mediaDir), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
            data = parsed;
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            console.warn('[profiles] read failed: ' + errText(error));
    }
    cache = { at: now, mediaDir, data };
    return data;
}

async function save(mediaDir, data) {
    try {
        const file = dataPath(mediaDir);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(data, null, 1), 'utf8');
        cache = { at: Date.now(), mediaDir, data };
    }
    catch (error) {
        console.warn('[profiles] write failed: ' + errText(error));
    }
}

let saveTimer;

/** Touch happens on every message; batch those writes instead of one per line. */
function scheduleSave(mediaDir, data) {
    cache = { at: Date.now(), mediaDir, data };
    if (saveTimer !== undefined)
        clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void save(mediaDir, data);
    }, 2000);
    saveTimer.unref?.();
}

function normalize(entry) {
    const age = Number(entry?.age);
    return {
        nickname: typeof entry?.nickname === 'string' ? entry.nickname : '',
        name: typeof entry?.name === 'string' ? entry.name : '',
        age: Number.isFinite(age) && age >= 1 && age <= 120 ? Math.round(age) : 0,
        gender: typeof entry?.gender === 'string' ? entry.gender : '',
        relation: typeof entry?.relation === 'string' ? entry.relation : '',
        style: typeof entry?.style === 'string' ? entry.style : '',
        catchphrases: Array.isArray(entry?.catchphrases) ? entry.catchphrases.filter(p => typeof p === 'string' && p.trim() !== '').slice(-10) : [],
        facts: Array.isArray(entry?.facts) ? entry.facts.filter(f => typeof f === 'string' && f.trim() !== '').slice(-MAX_FACTS) : [],
        msgCount: Number(entry?.msgCount) || 0,
        firstSeen: Number(entry?.firstSeen) || Date.now(),
        updatedAt: Number(entry?.updatedAt) || Date.now(),
    };
}

/** Read one profile (read-only). */
export async function profileGet(mediaDir, userId) {
    const data = await load(mediaDir);
    const entry = data[String(userId)];
    return entry === undefined ? null : normalize(entry);
}

/**
 * Merge a patch into one profile. Facts are appended (deduplicated), the other
 * fields replaced when non-empty.
 */
export async function profileUpdate(mediaDir, userId, patch = {}) {
    const key = String(userId);
    if (key === '')
        throw new Error('profile: userId required');
    const data = await load(mediaDir);
    const current = normalize(data[key]);
    const next = { ...current };
    if (typeof patch.nickname === 'string' && patch.nickname.trim() !== '')
        next.nickname = patch.nickname.trim().slice(0, 40);
    if (typeof patch.name === 'string' && patch.name.trim() !== '')
        next.name = patch.name.trim().slice(0, 20);
    if (patch.age !== undefined && patch.age !== null && patch.age !== '') {
        const age = Number(patch.age);
        if (Number.isFinite(age) && age >= 1 && age <= 120)
            next.age = Math.round(age);
    }
    if (typeof patch.gender === 'string' && ['男', '女', '其他'].includes(patch.gender.trim()))
        next.gender = patch.gender.trim();
    if (typeof patch.relation === 'string' && patch.relation.trim() !== '')
        next.relation = patch.relation.trim().slice(0, 80);
    if (typeof patch.style === 'string' && patch.style.trim() !== '')
        next.style = patch.style.trim().slice(0, 120);
    if (typeof patch.catchphrase === 'string' && patch.catchphrase.trim() !== '') {
        const phrase = patch.catchphrase.trim().slice(0, 20);
        if (!next.catchphrases.includes(phrase))
            next.catchphrases.push(phrase);
    }
    if (typeof patch.fact === 'string') {
        const fact = patch.fact.trim().slice(0, 120);
        if (fact !== '' && !next.facts.includes(fact))
            next.facts.push(fact);
    }
    if (Array.isArray(patch.facts)) {
        for (const raw of patch.facts) {
            const fact = String(raw ?? '').trim().slice(0, 120);
            if (fact !== '' && !next.facts.includes(fact))
                next.facts.push(fact);
        }
    }
    next.facts = next.facts.slice(-MAX_FACTS);
    next.updatedAt = Date.now();
    data[key] = next;
    await save(mediaDir, data);
    return next;
}

/** Bump counters / refresh the nickname when a message arrives. */
export async function profileTouch(mediaDir, userId, nickname = '') {
    const key = String(userId);
    if (key === '')
        return null;
    const data = await load(mediaDir);
    const current = normalize(data[key]);
    current.msgCount += 1;
    current.updatedAt = Date.now();
    if (nickname !== '' && current.nickname === '')
        current.nickname = nickname.slice(0, 40);
    data[key] = current;
    scheduleSave(mediaDir, data);
    return current;
}

/**
 * The `[画像]` block for one speaker, or '' when there is nothing useful yet.
 * Also touches the profile so counts/nicknames stay current.
 */
export async function renderProfileBlock(mediaDir, userId, nickname = '') {
    if (String(userId) === '')
        return '';
    const profile = await profileTouch(mediaDir, userId, nickname);
    if (profile === null)
        return '';
    const lines = [];
    const who = (profile.nickname !== '' ? profile.nickname : nickname) || String(userId);
    lines.push('- 这是 ' + who + '（QQ ' + userId + '），你们聊过 ' + profile.msgCount + ' 次');
    lines.push('- 关系阶段：' + relationshipStage(profile.msgCount));
    const basics = [];
    if (profile.name !== '')
        basics.push('名字：' + profile.name);
    if (profile.age > 0)
        basics.push('年龄：' + profile.age);
    if (profile.gender !== '')
        basics.push('性别：' + profile.gender);
    if (basics.length > 0)
        lines.push('- ' + basics.join(' · '));
    if (profile.relation !== '')
        lines.push('- 关系：' + profile.relation);
    if (profile.catchphrases.length > 0)
        lines.push('- 口头禅：' + profile.catchphrases.join('、') + '（多半只是习惯，不是每句都有意思，不用句句接）');
    if (profile.facts.length > 0)
        lines.push('- 你记得：' + profile.facts.slice(-RENDER_FACTS).join('；'));
    if (profile.style !== '')
        lines.push('- 说话风格：' + profile.style);
    if (profile.msgCount <= 1 && profile.relation === '' && profile.facts.length === 0)
        lines.push('- 第一次说话，先正常聊，别装熟');
    return '[画像]\n' + lines.join('\n') + '\n[/画像]';
}

/** Test seam. */
export function resetProfileCache() {
    cache = { at: 0, mediaDir: '', data: {} };
}
