/**
 * OneBot 11 message parsing: CQ-code unescaping, segment-array → text/media
 * extraction, mention detection, and face-id → emoji mapping. Ported from the
 * Hermes onebot_utils.py (CQ parsing half). Pure functions, no I/O.
 * @module dsh-onebot/cq
 */
/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export function cqUnescape(value) {
    return value
        .replaceAll('&#91;', '[')
        .replaceAll('&#93;', ']')
        .replaceAll('&#44;', ',')
        .replaceAll('&amp;', '&');
}
/** [dsh-p1] QQ face labels: QQ classic face id -> readable label.
 * The upstream table was a generic emoji id list, so QQ [疑问] (32) arrived
 * as 😴 and [微笑] (14) as 🥰; unknown ids became 😀. Emit the Chinese face
 * name instead — the model reads intent far better than a mismapped emoji. */
const FACE_LABEL = {
    '0': '[表情:惊讶]',
    '1': '[表情:撇嘴]',
    '2': '[表情:色]',
    '3': '[表情:发呆]',
    '4': '[表情:得意]',
    '5': '[表情:流泪]',
    '6': '[表情:害羞]',
    '7': '[表情:闭嘴]',
    '8': '[表情:睡]',
    '9': '[表情:大哭]',
    '10': '[表情:尴尬]',
    '11': '[表情:发怒]',
    '12': '[表情:调皮]',
    '13': '[表情:呲牙]',
    '14': '[表情:微笑]',
    '15': '[表情:难过]',
    '16': '[表情:酷]',
    '17': '[表情:非典]',
    '18': '[表情:抓狂]',
    '19': '[表情:吐]',
    '20': '[表情:偷笑]',
    '21': '[表情:可爱]',
    '22': '[表情:白眼]',
    '23': '[表情:傲慢]',
    '24': '[表情:饥饿]',
    '25': '[表情:困]',
    '26': '[表情:惊恐]',
    '27': '[表情:流汗]',
    '28': '[表情:憨笑]',
    '29': '[表情:大兵]',
    '30': '[表情:奋斗]',
    '31': '[表情:咒骂]',
    '32': '[表情:疑问]',
    '33': '[表情:嘘]',
    '34': '[表情:晕]',
    '35': '[表情:折磨]',
    '36': '[表情:衰]',
    '37': '[表情:骷髅]',
    '38': '[表情:敲打]',
    '39': '[表情:再见]',
    '40': '[表情:擦汗]',
    '41': '[表情:抠鼻]',
    '42': '[表情:鼓掌]',
    '43': '[表情:糗大了]',
    '44': '[表情:坏笑]',
    '45': '[表情:左哼哼]',
    '46': '[表情:右哼哼]',
    '47': '[表情:哈欠]',
    '48': '[表情:鄙视]',
    '49': '[表情:委屈]',
    '50': '[表情:快哭了]',
    '51': '[表情:阴险]',
    '52': '[表情:亲亲]',
    '53': '[表情:吓]',
    '54': '[表情:可怜]',
    '55': '[表情:菜刀]',
    '56': '[表情:西瓜]',
    '57': '[表情:啤酒]',
    '58': '[表情:篮球]',
    '59': '[表情:乒乓]',
    '60': '[表情:咖啡]',
    '61': '[表情:饭]',
    '62': '[表情:猪头]',
    '63': '[表情:玫瑰]',
    '64': '[表情:凋谢]',
    '65': '[表情:示爱]',
    '66': '[表情:爱心]',
    '67': '[表情:心碎]',
    '68': '[表情:蛋糕]',
    '69': '[表情:闪电]',
    '70': '[表情:炸弹]',
    '71': '[表情:刀]',
    '72': '[表情:足球]',
    '73': '[表情:瓢虫]',
    '74': '[表情:便便]',
    '75': '[表情:月亮]',
    '76': '[表情:太阳]',
    '77': '[表情:礼物]',
    '78': '[表情:拥抱]',
    '79': '[表情:强]',
    '80': '[表情:弱]',
    '81': '[表情:握手]',
    '82': '[表情:胜利]',
    '83': '[表情:抱拳]',
    '84': '[表情:勾引]',
    '85': '[表情:拳头]',
    '86': '[表情:差劲]',
    '87': '[表情:爱你]',
    '88': '[表情:NO]',
    '89': '[表情:OK]',
    '90': '[表情:爱情]',
    '91': '[表情:飞吻]',
    '92': '[表情:跳跳]',
    '93': '[表情:发抖]',
    '94': '[表情:怄火]',
    '95': '[表情:转圈]',
    '96': '[表情:磕头]',
    '97': '[表情:回头]',
    '98': '[表情:跳绳]',
    '99': '[表情:挥手]',
    '100': '[表情:激动]',
    '101': '[表情:街舞]',
    '102': '[表情:献吻]',
    '103': '[表情:左太极]',
    '104': '[表情:右太极]',
    '105': '[表情:开心]',
    '106': '[表情:爆筋]',
    '107': '[表情:棒棒糖]',
    '108': '[表情:喝奶]',
    '109': '[表情:面条]',
    '110': '[表情:香蕉]',
    '111': '[表情:飞机]',
    '112': '[表情:汽车]',
    '113': '[表情:火车]',
    '114': '[表情:轮船]',
    '115': '[表情:彩虹]',
    '116': '[表情:雨伞]',
    '117': '[表情:气球]',
    '118': '[表情:蜡烛]',
    '119': '[表情:钻戒]',
    '120': '[表情:购物券]',
    '121': '[表情:奖杯]',
    '122': '[表情:喝彩]',
};
/** Map a QQ face id to a readable label (unknown ids stay explicit). */
export function faceToEmoji(id) {
    return FACE_LABEL[id] ?? ('[表情:' + id + ']');
}
const CQ_AT_RE = /\[CQ:at,qq=([^,\]]+)\]/g;
const CQ_REPLY_RE = /\[CQ:reply,id=([^,\]]+)\]/g;
/**
 * Detect whether the message mentions the bot. Prefers the segment array;
 * falls back to CQ-string scanning. @-detection stays fail-closed: with an
 * unknown bot id and no configured botQQ, group messages are never treated
 * as mentioning us. Reply segments count only when the replied-to user is
 * determinably the bot itself (M1-A8); an undeterminable target (segment
 * carries no qq) falls back to the previous always-mention behavior — a
 * deliberate fail-open so tightening the gate never breaks existing setups.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 */
export function detectMention(segments, raw, selfId, botQQ) {
    const bot = selfId !== '' ? selfId : botQQ;
    if (segments !== undefined) {
        for (const seg of segments) {
            if (seg.type === 'reply') {
                const qq = seg.data.qq ?? '';
                if (qq === '' || qq === bot)
                    return true;
                continue;
            }
            if (bot !== '' && seg.type === 'at' && (seg.data.qq === bot || seg.data.qq === 'all'))
                return true;
        }
        return false;
    }
    if (bot === '')
        return false;
    CQ_AT_RE.lastIndex = 0;
    for (const m of raw.matchAll(CQ_AT_RE)) {
        if (m[1] === bot || m[1] === 'all')
            return true;
    }
    CQ_REPLY_RE.lastIndex = 0;
    return CQ_REPLY_RE.test(raw);
}
/** Split a raw CQ string into segments; used only when no segment array exists. */
export function parseCqString(raw) {
    const segments = [];
    const re = /\[CQ:([a-z]+),([^\]]*)\]/g;
    let last = 0;
    for (const m of raw.matchAll(re)) {
        if (m.index !== undefined && m.index > last) {
            segments.push({ type: 'text', data: { text: raw.slice(last, m.index) } });
        }
        const data = {};
        for (const pair of m[2].split(',')) {
            const eq = pair.indexOf('=');
            if (eq > 0)
                data[pair.slice(0, eq)] = cqUnescape(pair.slice(eq + 1));
        }
        segments.push({ type: m[1], data });
        last = (m.index ?? 0) + m[0].length;
    }
    if (last < raw.length) {
        segments.push({ type: 'text', data: { text: raw.slice(last) } });
    }
    return segments;
}
/**
 * Parse a OneBot message (segment array preferred, CQ string fallback) into
 * text + media references. Media appear as placeholders in the text; media.ts
 * resolves each ref to a local path afterwards.
 * @param segments - message segment array (preferred).
 * @param raw - raw CQ string (fallback / complement).
 * @returns parsed text, media refs, and the quoted message id.
 */
export function parseMessage(segments, raw) {
    const textParts = [];
    const media = [];
    let replyId;
    let forwardId;
    const appendImage = (data) => {
        const subType = data.sub_type ?? data['sub-type'];
        if (subType === '1') {
            textParts.push('[表情包]');
            return;
        }
        media.push({ kind: 'image', url: data.url || undefined, file: data.file || undefined, subType });
        textParts.push('[图片]');
    };
    const list = segments !== undefined && segments.length > 0 ? segments : parseCqString(raw);
    for (const seg of list) {
        switch (seg.type) {
            case 'text':
                if (seg.data.text !== '')
                    textParts.push(seg.data.text);
                break;
            case 'image':
                appendImage(seg.data);
                break;
            case 'face':
                textParts.push(faceToEmoji(seg.data.id ?? ''));
                break;
            case 'mface': {
                const data = seg.data ?? {};
                const summary = typeof data.summary === 'string' && data.summary !== ''
                    ? data.summary
                    : (data.emoji_id !== undefined ? '超级表情' + String(data.emoji_id) : '超级表情');
                textParts.push('[超级表情:' + summary + ']');
                break;
            }
            case 'record':
                media.push({ kind: 'voice', url: seg.data.url || undefined, file: seg.data.file || undefined });
                textParts.push('[语音]');
                break;
            case 'video':
                media.push({ kind: 'video', url: seg.data.url || undefined, file: seg.data.file || undefined });
                textParts.push('[视频]');
                break;
            case 'file':
                // NapCat's file segment: `file` holds the file NAME (not a path),
                // `file_id` the real id, `name` is usually absent. Keep the raw
                // fields for media.ts; the display name falls back to `file`.
                media.push({
                    kind: 'file',
                    url: seg.data.url || undefined,
                    file: seg.data.file || undefined,
                    fileId: seg.data.file_id || undefined,
                    name: seg.data.name || seg.data.file || undefined,
                });
                textParts.push(seg.data.name || seg.data.file ? `[文件:${seg.data.name || seg.data.file}]` : '[文件]');
                break;
            case 'at': {
                const qq = seg.data.qq ?? '';
                textParts.push(qq === 'all' ? '@全体成员' : `@${qq}`);
                break;
            }
            case 'reply':
                if (seg.data.id !== undefined) {
                    replyId = seg.data.id;
                    textParts.push('[引用]');
                }
                break;
            case 'forward':
                // NapCat uses `id`; go-cqhttp-style implementations may use `resId`.
                if (seg.data.id !== undefined || seg.data.resId !== undefined) {
                    forwardId = seg.data.id ?? seg.data.resId;
                    textParts.push('[合并转发]');
                }
                break;
                        // [dsh-p1] v2.10: some forward cards arrive as xml/json with
            // m_resid instead of a forward segment — fish the id out so
            // expandForward can still fetch the content.
            case 'xml':
            case 'json': {
                const xmlData = String(s.data?.data ?? s.data ?? '');
                const resid = /m_resid=["']?([A-Za-z0-9=/+_-]{16,})/.exec(xmlData);
                if (resid !== null && forwardId === undefined)
                    forwardId = resid[1];
                break;
            }
case 'json':
                textParts.push('[卡片]');
                break;
            case 'poke':
                textParts.push('[戳一戳]');
                break;
            case 'contact':
                textParts.push(seg.data.name ? `[联系人:${seg.data.name}]` : '[联系人]');
                break;
            case 'location':
                textParts.push('[位置]');
                break;
            case 'share':
                textParts.push(seg.data.title ? `[分享:${seg.data.title}]` : '[分享]');
                break;
            default:
                // Unknown segment types keep their placeholder role; no crash.
                textParts.push(`[${seg.type}]`);
                break;
        }
    }
    const text = textParts.join('').trim();
    return { text, media, replyId, forwardId };
}
/** Extract the plain text of a quoted (get_msg) message for [引用] expansion. */
export function segmentText(segments, raw) {
    return parseMessage(segments, raw).text;
}
/** Marker regex shared with split.ts (outbound [[qq_forward]]). */
export const FORWARD_BLOCK_RE = /\[\[qq_forward\]\]([\s\S]*?)\[\[\/qq_forward\]\]/g;
