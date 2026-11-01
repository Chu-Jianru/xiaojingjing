import json
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
P = REPO / "qq-persona/p1"
idx = json.loads((P/"stickers"/"memes-index.json").read_text(encoding="utf-8"))
out = {
  "version": 2,
  "source": "dsh-pet/assets/memes（鲸鱼娘官方风格表情包）",
  "dir": str(REPO / "qq-persona/p1/stickers/memes"),
  "count": idx["count"],
  "stickers": [{"file": m["file"], "meaning": m["desc"]} for m in idx["memes"]],
  "rules": {"private_per_2min": 1, "group_per_5min": 1, "only_when_matching": True, "fallback": "send_text_only"},
}
(P/"stickers"/"tags.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print("tags.json ok", out["count"])
