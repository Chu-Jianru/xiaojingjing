import json, re, shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

SRC = Path(r"C:/Users/USER\.dsh\profiles\desktop\node_modules\dsh-pet\assets")
DST = REPO / "qq-persona/p1"
MEME_DST = DST / "stickers" / "memes"
MEME_DST.mkdir(parents=True, exist_ok=True)

raw = (SRC / "config.jsonc").read_text(encoding="utf-8")
# 去掉行注释（简单处理：不在字符串里的 // 后内容）
out_lines = []
for line in raw.splitlines():
    s = line
    in_str = False
    esc = False
    cut = None
    for i, ch in enumerate(s):
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if not in_str and ch == "/" and i + 1 < len(s) and s[i + 1] == "/":
            cut = i
            break
    out_lines.append(s if cut is None else s[:cut])
cfg = json.loads("\n".join(out_lines))

memes = cfg.get("memes", {})
copied = []
for name, desc in memes.items():
    src = SRC / "memes" / f"{name}.png"
    if not src.exists():
        print("MISSING", name)
        continue
    shutil.copy2(src, MEME_DST / f"{name}.png")
    copied.append({"file": f"{name}.png", "desc": desc})

(DST / "stickers" / "memes-index.json").write_text(
    json.dumps({"source": "dsh-pet/assets/memes", "count": len(copied), "memes": copied},
               ensure_ascii=False, indent=2),
    encoding="utf-8")
print("copied", len(copied), "memes ->", MEME_DST)
print("pic files:", [p.name for p in (SRC / "pic").iterdir()] if (SRC / "pic").exists() else None)
