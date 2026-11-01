/**
 * [dsh-p1] 出站拼接泄漏护栏（v2.03）。
 *
 * What happened (2026-10-25 15:19:46, README 4.35)：回合进行中来了一条群消息，
 * DSH 的 followup 拼接机制把入站行（`user[15:20 昵称(QQ)] [旁听] [本条ID:…]`）
 * 黏进了正在生成的助手文本块。这段"回复"实测 383 字，超过 t2i 阈值 150，
 * 整块被渲染成一张图片卡片发到群里——她真正想说的 16 个字被包在一张
 * 莫名其妙的图里，还带着泄漏的元数据。
 *
 * Guard: outbound 发送前剥离**长得 exactly 像拼接行**的行——
 *   user[HH:MM 昵称(QQ)] … 可选 [旁听]/[@我]/[本条ID:n] …
 * 人格绝不会合法地输出这种格式（全是框架元数据），误伤率为零。
 * t2i 已另行关闭（textImageThreshold: 0），本护栏负责不让泄漏行发出去。
 */

// a splice line: starts at line head, "user[HH:MM " + anything + "(QQ号)]" + rest
const SPLICE_LINE = /^user\[\d{1,2}:\d{2} [^\n]*?\(\d{5,12}\)\].*$/;

/** Remove leaked splice lines; returns { text, removed } for logging. */
export function stripSpliceLeaks(text) {
    const raw = String(text ?? '');
    const lines = raw.split(/\r?\n/);
    const kept = [];
    let removed = 0;
    for (const line of lines) {
        if (SPLICE_LINE.test(line.trim()))
            removed += 1;
        else
            kept.push(line);
    }
    if (removed === 0)
        return { text: raw, removed: 0 };
    // collapse the whitespace the removed lines left behind
    const text2 = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text2, removed };
}
