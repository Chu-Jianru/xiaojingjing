"""Fix the QQ face-id mapping in dsh-onebot-qq.

The shipped `FACE_EMOJI` table is a generic emoji-id list, not QQ's classic face
numbering. Consequences seen in the real chat:

  - QQ [疑问] (id 32) arrived as 😴 → 小鲸鲸 answered "困啦？" while 老大 meant 疑惑
  - QQ [微笑] (id 14) arrived as 🥰
  - any unknown id became 😀 (a smile, even for 愤怒/白眼)

This patch replaces the table with QQ's own face names and emits `[表情:名字]`,
so the model reads the intended emotion instead of a wrong emoji. Idempotent:

  python tools/plugin/patches/patch_onebot_faces.py           # apply (backs up .bak-faces)
  python tools/plugin/patches/patch_onebot_faces.py --check   # exit 0 when applied
  python tools/plugin/patches/patch_onebot_faces.py --revert
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

DEFAULT = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib/cq.js"
MARKER = "[dsh-p1] QQ face labels"

FACES = [
    (0, "惊讶"), (1, "撇嘴"), (2, "色"), (3, "发呆"), (4, "得意"), (5, "流泪"),
    (6, "害羞"), (7, "闭嘴"), (8, "睡"), (9, "大哭"), (10, "尴尬"), (11, "发怒"),
    (12, "调皮"), (13, "呲牙"), (14, "微笑"), (15, "难过"), (16, "酷"), (17, "非典"),
    (18, "抓狂"), (19, "吐"), (20, "偷笑"), (21, "可爱"), (22, "白眼"), (23, "傲慢"),
    (24, "饥饿"), (25, "困"), (26, "惊恐"), (27, "流汗"), (28, "憨笑"), (29, "大兵"),
    (30, "奋斗"), (31, "咒骂"), (32, "疑问"), (33, "嘘"), (34, "晕"), (35, "折磨"),
    (36, "衰"), (37, "骷髅"), (38, "敲打"), (39, "再见"), (40, "擦汗"), (41, "抠鼻"),
    (42, "鼓掌"), (43, "糗大了"), (44, "坏笑"), (45, "左哼哼"), (46, "右哼哼"),
    (47, "哈欠"), (48, "鄙视"), (49, "委屈"), (50, "快哭了"), (51, "阴险"),
    (52, "亲亲"), (53, "吓"), (54, "可怜"), (55, "菜刀"), (56, "西瓜"), (57, "啤酒"),
    (58, "篮球"), (59, "乒乓"), (60, "咖啡"), (61, "饭"), (62, "猪头"), (63, "玫瑰"),
    (64, "凋谢"), (65, "示爱"), (66, "爱心"), (67, "心碎"), (68, "蛋糕"), (69, "闪电"),
    (70, "炸弹"), (71, "刀"), (72, "足球"), (73, "瓢虫"), (74, "便便"), (75, "月亮"),
    (76, "太阳"), (77, "礼物"), (78, "拥抱"), (79, "强"), (80, "弱"), (81, "握手"),
    (82, "胜利"), (83, "抱拳"), (84, "勾引"), (85, "拳头"), (86, "差劲"), (87, "爱你"),
    (88, "NO"), (89, "OK"), (90, "爱情"), (91, "飞吻"), (92, "跳跳"), (93, "发抖"),
    (94, "怄火"), (95, "转圈"), (96, "磕头"), (97, "回头"), (98, "跳绳"), (99, "挥手"),
    (100, "激动"), (101, "街舞"), (102, "献吻"), (103, "左太极"), (104, "右太极"),
    (105, "开心"), (106, "爆筋"), (107, "棒棒糖"), (108, "喝奶"), (109, "面条"),
    (110, "香蕉"), (111, "飞机"), (112, "汽车"), (113, "火车"), (114, "轮船"),
    (115, "彩虹"), (116, "雨伞"), (117, "气球"), (118, "蜡烛"), (119, "钻戒"),
    (120, "购物券"), (121, "奖杯"), (122, "喝彩"),
]

NEW_BLOCK = (
    "/** " + MARKER + ": QQ classic face id -> readable label.\n"
    " * The upstream table was a generic emoji id list, so QQ [疑问] (32) arrived\n"
    " * as 😴 and [微笑] (14) as 🥰; unknown ids became 😀. Emit the Chinese face\n"
    " * name instead — the model reads intent far better than a mismapped emoji. */\n"
    "const FACE_LABEL = {\n"
    + "".join(f"    '{i}': '[表情:{name}]',\n" for i, name in FACES)
    + "};\n"
    "/** Map a QQ face id to a readable label (unknown ids stay explicit). */\n"
    "export function faceToEmoji(id) {\n"
    "    return FACE_LABEL[id] ?? ('[表情:' + id + ']');\n"
    "}\n"
)


def apply(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("already patched")
        return
    start = text.index("/** QQ face id → emoji")
    end = text.index("const CQ_AT_RE")
    backup = path.with_suffix(".js.bak-faces")
    shutil.copy2(path, backup)
    path.write_text(text[:start] + NEW_BLOCK + text[end:], encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def revert(path: Path) -> None:
    backup = path.with_suffix(".js.bak-faces")
    if not backup.exists():
        raise SystemExit("no backup to restore")
    shutil.copy2(backup, path)
    backup.unlink()
    print("reverted")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", type=Path, default=DEFAULT)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.check:
        ok = MARKER in args.file.read_text(encoding="utf-8")
        print("patched" if ok else "NOT patched")
        raise SystemExit(0 if ok else 1)
    if args.revert:
        revert(args.file)
        return
    apply(args.file)


if __name__ == "__main__":
    main()
