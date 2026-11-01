from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
import json
RAW = REPO / "qq-persona/p1/素材-帧/raw"
D = REPO / "bot-home/media/onebot/stickers/memes"
names = [p.stem for p in RAW.glob("*.png") if (D / p.name).exists()]
for n in names:
    (D / f"{n}.png").unlink(missing_ok=True)
print("removed", len(names))
