from PIL import Image
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
src = Image.open(str(REPO / "qq-persona/p1/stickers/memes/可爱.png")).convert("RGBA")
w, h = src.size
# 头部特写：裁上半身
box = (int(w*0.12), int(h*0.02), int(w*0.88), int(h*0.62))
crop = src.crop(box)
side = max(crop.size)
canvas = Image.new("RGBA", (side, side), (255, 255, 255, 255))
canvas.paste(crop, ((side-crop.width)//2, (side-crop.height)//2), crop)
canvas = canvas.resize((512, 512), Image.LANCZOS).convert("RGB")
canvas.save(str(REPO / "qq-persona/p1/avatar.png"), quality=95)
print("avatar ok", canvas.size)
