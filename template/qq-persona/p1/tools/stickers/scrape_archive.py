import re, json, urllib.request, time
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

OUT = REPO / "qq-persona/p1/素材-帧/aigengtu"
OUT.mkdir(parents=True, exist_ok=True)

items = {}
for page in range(1, 9):
    url = f"https://aigengtu.com/archive?p={page}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    found = re.findall(r'/zh/meme/(\d+)[^>]*>\s*<img[^>]+src="https://img\.aigengtu\.com/0_preview/meme/\d+\.webp"[^>]*alt="([^"]*)"', html)
    if not found:
        found = re.findall(r'img\.aigengtu\.com/0_preview/meme/(\d+)\.webp"[^>]*alt="([^"]*)"', html)
    for mid, title in found:
        items.setdefault(mid, title)
    print("page", page, "->", len(found), "total", len(items))
    time.sleep(0.4)

(OUT/"catalog.json").write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
print("saved", len(items))
