// Reply timing is transport metadata, never part of a QQ bubble.
export const MAX_REPLY_WAIT_MS = 120_000;

export function parseReplyTiming(value) {
    const raw = String(value ?? '');
    // A quote may precede the timing marker; later markers are stripped but
    // cannot reschedule a message after its content has already started.
    const leading = /^\s*(?:\[\[reply:\d{5,}\]\]\s*)?\[\[wait:([^\]\r\n]*)\]\]/i.exec(raw);
    let waitMs = null;
    if (leading && /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(leading[1])) {
        const seconds = Number(leading[1]);
        if (Number.isFinite(seconds))
            waitMs = Math.round(Math.max(0, Math.min(120, seconds)) * 1000);
    }
    const text = raw.replace(/\[\[wait:[^\]\r\n]*\]\]/gi, '').trim();
    return { text, waitMs };
}

function unit(random) {
    return Math.min(1, Math.max(0, Number(random()) || 0));
}

export function defaultReplyDelayMs(text, context = {}, random = Math.random) {
    if (context.urgent) return 0;
    const length = [...String(text)].length;
    const active = context.active === true;
    let ms = (active ? 650 : 1600) + Math.min(length, 160) * (active ? 18 : 26);
    ms += unit(random) * (active ? 1800 : 4400);
    if (Number.isFinite(context.energy) && context.energy < 35)
        ms += 1500 + unit(random) * 2500;
    return Math.round(Math.min(active ? 6000 : 12_000, ms));
}

export function bubbleDelayMs(text, random = Math.random) {
    const plain = String(text).replace(/\[\[reply:\d+\]\]/g, '');
    return Math.round(Math.min(6000, 450 + [...plain].length * 35 + unit(random) * 1400));
}

export function replyIsCurrent(guard = {}) {
    return !guard.signal?.aborted && !guard.isStopping?.() && guard.isCurrent?.() !== false;
}

// Aborts immediately through the bridge's per-turn signal. The short check
// also covers shutdown or a revision guard supplied without an AbortSignal.
export function waitForReply(ms, guard = {}) {
    if (!replyIsCurrent(guard)) return Promise.resolve(false);
    if (!(ms > 0)) return Promise.resolve(true);
    return new Promise(resolve => {
        let timer;
        let poll;
        const done = result => {
            clearTimeout(timer);
            clearInterval(poll);
            guard.signal?.removeEventListener('abort', abort);
            resolve(result);
        };
        const abort = () => done(false);
        guard.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => done(replyIsCurrent(guard)), Math.min(ms, MAX_REPLY_WAIT_MS));
        poll = setInterval(() => { if (!replyIsCurrent(guard)) done(false); }, 100);
        // Close the abort-before-listener race, including custom signals.
        if (!replyIsCurrent(guard)) done(false);
    });
}
