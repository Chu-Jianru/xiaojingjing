r"""一键导入新表情包：转换 -> 更新含义清单 -> 重建人格 -> 重启 companion。

用法：把图片丢进 新增表情包\ 目录，双击 添加表情包.cmd。
"""
import json
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = REPO / "qq-persona/p1"
DROP = BASE / "新增表情包"
DONE = DROP / "已导入"
MEMES = REPO / "bot-home/media/onebot/stickers/memes"
MEANINGS = BASE / "表情包含义.txt"
INDEX = BASE / "stickers" / "memes-index.json"
BUILD = BASE / "tools" / "persona" / "build_persona.py"
PY = sys.executable
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
PLACEHOLDER = "（待补充含义）"


def load_index():
    if INDEX.exists():
        return json.loads(INDEX.read_text(encoding="utf-8")).get("memes", [])
    return []


def load_meanings():
    """解析 `文件名 = 含义` 的文本清单。"""
    data = {}
    if MEANINGS.exists():
        for line in MEANINGS.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, desc = line.split("=", 1)
            name, desc = name.strip(), desc.strip()
            if name and desc:
                data[name if name.lower().endswith(".png") else name + ".png"] = desc
    return data


def save_meanings(index, meanings):
    """把索引 + 用户填写的含义回写成可编辑文本。"""
    lines = [
        "# 表情包含义清单（一行一张，格式：文件名 = 含义（适合什么场景））",
        "# 改完保存，再双击一次 添加表情包.cmd 就会生效。",
        "# 以「（待补充含义）」结尾的图不会发出去，补上含义后才会用。",
        "",
    ]
    for m in sorted(index, key=lambda x: x["file"]):
        name = m["file"]
        desc = meanings.get(name) or m.get("desc") or PLACEHOLDER
        lines.append(f"{name} = {desc}")
    MEANINGS.write_text("\n".join(lines) + "\n", encoding="utf-8")


def convert(src: Path, dst: Path):
    img = Image.open(src)
    try:
        img.seek(0)
    except Exception:
        pass
    img = img.convert("RGBA")
    canvas = Image.new("RGBA", img.size, (255, 255, 255, 255))
    canvas.alpha_composite(img)
    canvas = canvas.convert("RGB")
    if max(canvas.size) > 512:
        canvas.thumbnail((512, 512), Image.LANCZOS)
    canvas.save(dst, "PNG", optimize=True)


def main():
    DROP.mkdir(parents=True, exist_ok=True)
    DONE.mkdir(parents=True, exist_ok=True)
    MEMES.mkdir(parents=True, exist_ok=True)

    index = load_index()
    meanings = load_meanings()
    # 自动清理：媒体目录里已经不存在的条目（手动删图后跑一次即可同步）
    before = len(index)
    index = [m for m in index if (MEMES / m["file"]).exists()]
    dropped = before - len(index)
    if dropped:
        print(f"清理已删除的表情：{dropped} 张")
    known = {m["file"] for m in index}

    added, renamed = [], []
    for src in sorted(DROP.iterdir()):
        if not src.is_file() or src.suffix.lower() not in EXTS:
            continue
        stem = src.stem.strip() or f"sticker-{int(time.time())}"
        name = f"{stem}.png"
        n = 2
        while name in known or (MEMES / name).exists():
            name = f"{stem}-{n}.png"
            n += 1
        convert(src, MEMES / name)
        desc = meanings.get(name) or meanings.get(src.name) or PLACEHOLDER
        index.append({"file": name, "desc": desc,
                      "added": datetime.now().strftime("%Y-%m-%d %H:%M")})
        known.add(name)
        added.append(name)
        if name != src.name:
            renamed.append(f"{src.name} -> {name}")
        shutil.move(str(src), str(DONE / src.name))

    # 用 含义.txt 里最新写的内容覆盖索引描述
    for m in index:
        if m["file"] in meanings:
            m["desc"] = meanings[m["file"]]
        m["ready"] = bool(m["desc"]) and not m["desc"].startswith(PLACEHOLDER)

    INDEX.write_text(json.dumps(
        {"source": "dsh-pet + 手动导入", "count": len(index), "memes": index},
        ensure_ascii=False, indent=2), encoding="utf-8")
    save_meanings(index, meanings)

    ready = [m for m in index if m["ready"]]
    pending = [m["file"] for m in index if not m["ready"]]

    print("=" * 52)
    print(f"本机表情包总数：{len(index)}  可用：{len(ready)}  待补含义：{len(pending)}")
    if added:
        print("本次新导入：" + "、".join(added))
    if renamed:
        print("重名自动改名：" + "；".join(renamed))
    if pending:
        print("\n这些图还没有含义，暂时不会发出去：")
        for p in pending:
            print("  - " + p)
        print(f"\n请打开 {MEANINGS.name} 写上含义，再运行一次本脚本。")

    print("\n重建人格提示词 ...")
    r = subprocess.run([PY, str(BUILD)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    print((r.stdout or "").strip() or "(no output)")
    if r.returncode != 0:
        print((r.stderr or "").strip())
        print("人格重建失败，未重启。")
        return 1

    if "--no-restart" in sys.argv:
        print("已跳过重启（--no-restart）。")
        return 0

    print("重启 companion ...")
    subprocess.run(["cmd", "/c", str(REPO / "scripts" / "stop-companion.cmd")], check=True)
    subprocess.run(["schtasks", "/run", "/tn", "DSH-companion-p1"], check=True)

    ok = False
    for _ in range(40):
        time.sleep(1)
        try:
            with socket.create_connection(("127.0.0.1", 18081), timeout=1):
                ok = True
                break
        except OSError:
            continue
    print("companion 已重新上线 OK" if ok else "companion 40 秒内没起来，看看日志")
    return 0


if __name__ == "__main__":
    sys.exit(main())



