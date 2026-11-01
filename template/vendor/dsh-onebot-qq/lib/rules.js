/**
 * [dsh-p1] 长期规则 (behavior rules set through conversation).
 *
 * Memory (`qq_remember`) stores facts; this stores *instructions*: "以后遇到 X
 * 就这么做". Rules are written by the `qq_rule` tool (admin DM only), kept in
 * <mediaDir>/rules.jsonl, and injected as a trusted `[规则]` block when the
 * current message matches their trigger keywords (or they are always-on).
 *
 * Shape per line:
 *   {id, when, then, scope: "global" | "group:<id>" | "private:<qq>", by, createdAt}
 *
 * Matching: `when` is a trigger phrase; its pieces (split on punctuation and
 * whitespace) are keywords — any hit in the message includes the rule. An empty
 * `when` means always-on. At most MAX_RULES are injected per turn, newest first.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const RULES_FILE = 'rules.jsonl';
const CACHE_MS = 15_000;
const MAX_RULES = 5;

let cache = { at: 0, mediaDir: '', rules: [] };

function errText(error) {
    return error instanceof Error ? error.message : String(error);
}

function rulesPath(mediaDir) {
    return join(mediaDir, RULES_FILE);
}

function normalize(entry, index) {
    return {
        id: typeof entry?.id === 'string' && entry.id !== '' ? entry.id : 'r-' + index,
        when: typeof entry?.when === 'string' ? entry.when.trim() : '',
        then: typeof entry?.then === 'string' ? entry.then.trim() : '',
        scope: typeof entry?.scope === 'string' && entry.scope !== '' ? entry.scope : 'global',
        by: typeof entry?.by === 'string' ? entry.by : '',
        createdAt: Number(entry?.createdAt) || 0,
    };
}

async function load(mediaDir) {
    const now = Date.now();
    if (cache.mediaDir === mediaDir && now - cache.at < CACHE_MS)
        return cache.rules;
    const rules = [];
    try {
        const raw = await readFile(rulesPath(mediaDir), 'utf8');
        raw.split(/\r?\n/).forEach((line, index) => {
            if (line.trim() === '')
                return;
            try {
                const entry = normalize(JSON.parse(line), index);
                if (entry.then !== '')
                    rules.push(entry);
            }
            catch { /* skip broken line */ }
        });
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            console.warn('[rules] read failed: ' + errText(error));
    }
    cache = { at: now, mediaDir, rules };
    return rules;
}

/** All rules for one chat (used by the list action). */
export async function listRules(mediaDir, chatId = '') {
    const rules = await load(mediaDir);
    if (chatId === '')
        return rules;
    return rules.filter(rule => rule.scope === 'global' || rule.scope === chatId);
}

/** Append one rule. Returns the stored record. */
export async function addRule(mediaDir, { when = '', then, scope = 'global', by = '' }) {
    const text = String(then ?? '').trim();
    if (text === '')
        throw new Error('rule: then 不能为空');
    const rule = {
        id: 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        when: String(when ?? '').trim(),
        then: text.slice(0, 200),
        scope: String(scope ?? 'global'),
        by: String(by ?? ''),
        createdAt: Date.now(),
    };
    const file = rulesPath(mediaDir);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(rule) + '\n', 'utf8');
    // Force a reload next time so external edits stay visible.
    cache = { at: 0, mediaDir, rules: [] };
    return rule;
}

/** Remove rules whose id matches, or whose `when`/`then` contains `text`. */
export async function removeRules(mediaDir, text) {
    const needle = String(text ?? '').trim();
    if (needle === '')
        throw new Error('rule: 要删除的 id 或关键词不能为空');
    const rules = await load(mediaDir);
    const kept = rules.filter(rule => rule.id !== needle
        && !rule.when.includes(needle)
        && !rule.then.includes(needle));
    const removed = rules.length - kept.length;
    if (removed > 0) {
        await writeFile(rulesPath(mediaDir), kept.map(rule => JSON.stringify(rule)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
        cache = { at: 0, mediaDir, rules: [] };
    }
    return removed;
}

/** Rules that should be in this turn's prompt, rendered as a `[规则]` block. */
export async function renderRules(mediaDir, { text = '', chatId = '' } = {}) {
    const rules = await listRules(mediaDir, chatId);
    if (rules.length === 0)
        return '';
    const body = String(text ?? '');
    const selected = [];
    for (let i = rules.length - 1; i >= 0 && selected.length < MAX_RULES; i--) {
        const rule = rules[i];
        if (rule.when === '') {
            selected.push(rule);
            continue;
        }
        // Trigger matching: the full phrase, a prefix-stripped version ("提到考试"
        // → "考试"), quoted fragments («某位朋友叫叫叫»), and punctuation-split pieces.
        const cleaned = rule.when
            .replace(/^(?:当|如果|遇到|有人|提到|说起|看到|听到|问到|问|说)\s*/, '')
            .replace(/(?:的时候|时|的话|了就)$/, '');
        const quoted = [...rule.when.matchAll(/[「『"“']([^」』"”']+)[」』"”']/g)].map(match => match[1]);
        const parts = [rule.when, cleaned, ...quoted, ...cleaned.split(/[\s,，、;；:：/|]+/)]
            .map(word => word.trim())
            .filter(word => word.length >= 2);
        if (parts.some(word => body.includes(word)))
            selected.push(rule);
    }
    if (selected.length === 0)
        return '';
    return '[规则]\n' + selected.map(rule => '- 当「' + rule.when + '」时：' + rule.then).join('\n') + '\n[/规则]';
}

/** Test seam. */
export function resetRulesCache() {
    cache = { at: 0, mediaDir: '', rules: [] };
}
