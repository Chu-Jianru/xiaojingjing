"""表情包轮换：她自己留几张常用的，每周再换一批，避免每轮把 70 张清单全塞给模型。

用法：
  python rotate_stickers.py            # 按当前 ISO 周次轮换
  python rotate_stickers.py --no-restart
"""
import json
import random
import sys as _sys
import subprocess
import sys
import time
from datetime import date
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

try:
    _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

P = REPO / "qq-persona/p1"
INDEX = P / "stickers" / "memes-index.json"
ACTIVE = P / "stickers" / "active.json"
BUILD = P / "tools" / "persona" / "build_persona.py"
PY = sys.executable

# 她「本来就顺手」的十来张，固定不动（像真人总用那几张）
FAVORITES = [
    "梗-原来是高等模型.png",
    "夸-不愧是你.png",
    "害羞-不要给我看.png",
    "委屈-摸头会变笨.png",
    "哭-花了好多token.png",
    "得意-这题我会.png",
    "干饭-全自动吃白饭.png",
    "摸鱼-下班瘫家.png",
    "饿-中午吃什么.png",
    "晚安-吃饱饱睡觉觉.png",
]
ROTATE_COUNT = 12


def main():
    data = json.loads(INDEX.read_text(encoding="utf-8"))["memes"]
    ready = [m["file"] for m in data if m.get("ready", True)]
    favs = [f for f in FAVORITES if f in ready]
    pool = [f for f in ready if f not in favs]

    year, week, _ = date.today().isocalendar()
    rng = random.Random(year * 100 + week)          # 同一周内结果稳定
    rotated = rng.sample(pool, min(ROTATE_COUNT, len(pool)))

    ACTIVE.write_text(json.dumps({
        "week": f"{year}-W{week:02d}",
        "favorites": favs,
        "rotating": rotated,
        "all": favs + rotated,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"本周 {year}-W{week:02d}：常用 {len(favs)} 张 + 轮换 {len(rotated)} 张（总共 {len(ready)} 张里选）")

    r = subprocess.run([PY, str(BUILD)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    print((r.stdout or "").strip())
    if r.returncode != 0:
        print((r.stderr or "").strip())
        return 1

    if "--no-restart" in sys.argv:
        print("已跳过重启")
        return 0

    subprocess.run(["cmd", "/c", str(REPO / "scripts" / "stop-companion.cmd")], check=True)
    subprocess.run(["schtasks", "/run", "/tn", "DSH-companion-p1"], check=True)

    ok = False
    for _ in range(40):
        time.sleep(1)
        import socket
        try:
            with socket.create_connection(("127.0.0.1", 18081), timeout=1):
                ok = True
                break
        except OSError:
            continue
    print("DSH 已重新上线 OK" if ok else "DSH 40 秒内没起来，看看日志")
    return 0


if __name__ == "__main__":
    sys.exit(main())

