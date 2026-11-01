/**
 * [dsh-p1] 轻量自动学习：纯规则/模板，不额外调模型。
 *
 * 只做两件事：
 *   1. 按人攒最近的消息（内存环形缓冲），每 8 条归纳一次「说话风格」，写进
 *      profiles.json 的 `style`（前缀「（自动）」，不覆盖手工/模型写的风格）；
 *   2. 从明确的第一人称自述里抽 0–2 条事实（年龄/生日/宠物/口味/名字），
 *      写进 memory/memories.jsonl（带 autoKey 去重，文本标「自动记，未确认」）。
 *
 * 隐私边界：群里非老大的自述多半是表演/玩笑，不抽事实；私聊（1:1）和老大的话才抽。
 * 风格对所有会话生效（公开行为），但只写摘要，不存原话。
 *
 * 失败一律静默（只回调 log），绝不影响正常聊天。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { profileGet, profileUpdate } from './profiles.js';

const FLUSH_EVERY = 8;
const MIN_SAMPLES = 5;
const MAX_SAMPLES = 20;
const STYLE_PREFIX = '（自动）';
const STYLE_MAX = 120;

const buffers = new Map();
const memoryKeys = new Map();
let writeChain = Promise.resolve();

function enqueue(task) {
    const run = writeChain.then(task);
    writeChain = run.catch(() => undefined);
    return run;
}

function errText(error) {
    return error instanceof Error ? error.message : String(error);
}

function bufferFor(userId) {
    let state = buffers.get(userId);
    if (state === undefined) {
        state = { samples: [], count: 0 };
        buffers.set(userId, state);
    }
    return state;
}

function factBody(text, nickname) {
    const who = String(nickname ?? '').trim() === '' ? '这个人' : String(nickname).trim();
    return who;
}

const NAME_BLOCK = /[你他她它爸妈爷奶哥姐弟妹宝亲谁啥名了的地得]/;
const NAME_STOP = new Set(['外卖', '车', '饭', '醒', '大家', '你们', '我们', '自己']);

function plausibleName(name) {
    if (!/^[\u4e00-\u9fa5A-Za-z]{2,4}$/.test(name)) return false;
    if (NAME_BLOCK.test(name)) return false;
    if (NAME_STOP.has(name)) return false;
    return true;
}

/**
 * 从一条消息里抽最多 2 条高置信度自述事实（纯正则，宁缺毋滥）。
 * @returns {{key:string,value:string,kind:string,text:string}[]}
 */
export function extractFacts(text, nickname = '') {
    const body = String(text ?? '').trim();
    if (body === '') return [];
    // 明显在开玩笑/反悔的消息整条跳过，避免把「骗你的」记成事实。
    if (/(开玩笑|逗你的|骗你的|不是真的|假的|口误)/.test(body)) return [];

    const who = factBody(body, nickname);
    const facts = [];
    const add = (key, value, kind, label) => {
        if (facts.length >= 2) return;
        if (facts.some(item => item.key === key)) return;
        facts.push({ key, value, kind, text: who + label + '（自动记，未确认）' });
    };

    const nameMatch = /(?:我(?:的名字)?叫|叫我)\s*([\u4e00-\u9fa5A-Za-z]{1,8})/.exec(body);
    if (nameMatch !== null) {
        const name = nameMatch[1];
        if (plausibleName(name)) add('name:' + name, name, 'fact', '说自己叫' + name);
    }

    const ageMatch = /我(?:今年)?\s*(\d{1,2})\s*岁/.exec(body);
    if (ageMatch !== null) {
        const age = Number(ageMatch[1]);
        if (age >= 5 && age <= 99) add('age:' + age, String(age), 'fact', '说自己' + age + '岁');
    }

    const birthdayMatch = /我(?:的)?生日(?:是|在)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(body);
    if (birthdayMatch !== null) {
        const month = Number(birthdayMatch[1]);
        const day = Number(birthdayMatch[2]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            add('birthday:' + month + '-' + day, month + '月' + day + '日', 'fact',
                '说生日是' + month + '月' + day + '日');
        }
    }

    const petMatch = /我(?:养了|养着|家有)\s*(?:一只|两只|三只|一|两|三|只)?\s*(猫|狗|仓鼠|兔子|兔|鸟|鱼|龟|蛇|蜥蜴|蜘蛛)/.exec(body);
    if (petMatch !== null) {
        add('pet:' + petMatch[1], petMatch[1], 'fact', '说养了' + petMatch[1]);
    }

    const foodMatch = /我(不吃|不爱吃|讨厌吃|爱吃|喜欢吃|爱喝|不喝)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,10})/.exec(body);
    if (foodMatch !== null) {
        const verb = foodMatch[1];
        const obj = foodMatch[2];
        if (!/^(?:你|我|他|她|这|那|什么|啥|了吗|过)/.test(obj)) {
            add('food:' + verb + ':' + obj, obj, 'pref', '说自己' + verb + obj);
        }
    }

    return facts;
}

function countParticles(texts) {
    const counts = new Map();
    for (const text of texts) {
        for (const ch of text) {
            if ('呀吧呢嘛啊哦嗯咯啦'.includes(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .filter(([, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([ch]) => ch);
}

/**
 * 纯函数：把最近几条消息归纳成一句 ≤110 字的风格摘要；信号不足返回 ''。
 * @param {{text:string, face?:boolean, media?:boolean}[]} samples
 */
export function summarizeStyle(samples) {
    const list = Array.isArray(samples)
        ? samples.filter(s => s !== null && typeof s === 'object'
            && typeof s.text === 'string' && s.text.trim() !== '')
        : [];
    if (list.length < MIN_SAMPLES) return '';

    const texts = list.map(s => s.text.replace(/\[[^\]]*\]/g, '').trim()).filter(t => t !== '');
    if (texts.length < MIN_SAMPLES) return '';
    const total = texts.length;

    const lengths = texts.map(t => [...t].filter(ch => !/\s/.test(ch)).length);
    const shortRatio = lengths.filter(n => n <= 6).length / total;
    const longRatio = lengths.filter(n => n >= 18).length / total;
    const questionRatio = texts.filter(t => /[？?]$/.test(t) || /[吗呢么]$/.test(t)).length / total;
    const excitedRatio = texts.filter(t => /[！!]|233|哈哈|笑死/.test(t)).length / total;
    const laughCount = texts.filter(t => /哈{2,}|233+|hhh|笑死|xswl/i.test(t)).length;
    const periodRatio = texts.filter(t => /[。.]$/.test(t)).length / total;
    const mediaRatio = list.filter(s => s.face === true || s.media === true).length / list.length;
    const particles = countParticles(texts);
    const slangWords = ['离谱', '逆天', '难绷', '绷不住', '绝了', '卧槽', '我靠', '抽象'];
    const slang = slangWords.filter(word => texts.filter(t => t.includes(word)).length >= 2);

    const bits = [];
    if (shortRatio >= 0.6) bits.push('句子很短');
    else if (longRatio >= 0.5) bits.push('爱说长句');
    if (laughCount >= 2) bits.push('爱笑（哈哈/233）');
    if (questionRatio >= 0.35) bits.push('爱反问');
    if (excitedRatio >= 0.3) bits.push('情绪外放（感叹号/哈哈）');
    if (mediaRatio >= 0.3) bits.push('爱发表情/图');
    if (periodRatio >= 0.5) bits.push('爱用句号收尾');
    if (particles.length > 0) bits.push('常带「' + particles.join('、') + '」');
    if (slang.length > 0) bits.push('常冒「' + slang.slice(0, 2).join('、') + '」');

    if (bits.length < 2) return '';
    return bits.slice(0, 4).join('、').slice(0, STYLE_MAX - STYLE_PREFIX.length);
}

async function flushStyle(mediaDir, userId, state, log) {
    const summary = summarizeStyle(state.samples.slice(-12));
    if (summary === '') return false;
    const profile = await profileGet(mediaDir, userId);
    if (profile === null) return false;
    // 手工/模型写过的风格不覆盖，只接管空值和上一版自动摘要。
    if (profile.style !== '' && !profile.style.startsWith(STYLE_PREFIX)) return false;
    const next = (STYLE_PREFIX + summary).slice(0, STYLE_MAX);
    if (profile.style === next) return false;
    await profileUpdate(mediaDir, userId, { style: next });
    log('auto-learn: style updated (' + userId + ')');
    return true;
}

async function loadMemoryKeys(mediaDir) {
    const now = Date.now();
    const cached = memoryKeys.get(mediaDir);
    if (cached !== undefined && now - cached.at < 30_000) return cached.keys;
    const keys = new Set();
    try {
        const raw = await readFile(join(mediaDir, 'memory', 'memories.jsonl'), 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            if (line.trim() === '') continue;
            try {
                const entry = JSON.parse(line);
                if (typeof entry?.autoKey === 'string' && entry.autoKey !== '') keys.add(entry.autoKey);
            }
            catch { /* skip broken line */ }
        }
    }
    catch { /* first write */ }
    memoryKeys.set(mediaDir, { at: now, keys });
    return keys;
}

async function appendFacts(mediaDir, chatId, userId, facts, log) {
    const keys = await loadMemoryKeys(mediaDir);
    const profile = await profileGet(mediaDir, userId);
    const file = join(mediaDir, 'memory', 'memories.jsonl');
    await mkdir(dirname(file), { recursive: true });
    let added = 0;
    for (const fact of facts) {
        if (added >= 2) break;
        if (keys.has(fact.key)) continue;
        // 画像里已经有同一条（模型记过）就不重复写记忆。
        if (profile !== null && profile.facts.some(item => item.includes(fact.value))) continue;
        const record = {
            ts: Date.now(),
            chat: String(chatId ?? ''),
            kind: fact.kind,
            text: fact.text,
            auto: true,
            autoKey: fact.key,
        };
        await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
        keys.add(fact.key);
        added += 1;
        log('auto-learn: fact stored (' + fact.key + ')');
    }
    return added;
}

/**
 * 处理一条入站消息（只调用，不阻塞对话）。
 * @param {string} mediaDir
 * @param {{chatId?:string,userId?:string,nickname?:string,text?:string,isGroup?:boolean,isAdmin?:boolean,hasFace?:boolean,hasMedia?:boolean}} input
 * @param {(message:string)=>void} [log]
 * @returns {Promise<{styleUpdated:boolean,factsAdded:number}>}
 */
export async function noteForAutoLearn(mediaDir, input, log = () => undefined) {
    try {
        const dir = String(mediaDir ?? '');
        const userId = String(input?.userId ?? '');
        const text = String(input?.text ?? '').trim();
        if (dir === '' || userId === '' || text === '') {
            return { styleUpdated: false, factsAdded: 0 };
        }

        const state = bufferFor(userId);
        state.samples.push({
            text,
            face: input?.hasFace === true,
            media: input?.hasMedia === true,
        });
        if (state.samples.length > MAX_SAMPLES) state.samples.shift();
        state.count += 1;

        let styleUpdated = false;
        if (state.count >= FLUSH_EVERY) {
            state.count = 0;
            styleUpdated = await enqueue(() => flushStyle(dir, userId, state, log));
        }

        let factsAdded = 0;
        // 群里只对老大抽事实；私聊（1:1）都抽。
        const allowFacts = input?.isGroup !== true || input?.isAdmin === true;
        if (allowFacts) {
            const facts = extractFacts(text, String(input?.nickname ?? ''));
            if (facts.length > 0) {
                factsAdded = await enqueue(() => appendFacts(dir, String(input?.chatId ?? ''), userId, facts, log));
            }
        }
        return { styleUpdated, factsAdded };
    }
    catch (error) {
        try { log('auto-learn skipped: ' + errText(error)); }
        catch { /* never break the caller */ }
        return { styleUpdated: false, factsAdded: 0 };
    }
}

/** Test seam: clear per-user buffers and caches. */
export function resetAutoLearnForTest() {
    buffers.clear();
    memoryKeys.clear();
    writeChain = Promise.resolve();
}
