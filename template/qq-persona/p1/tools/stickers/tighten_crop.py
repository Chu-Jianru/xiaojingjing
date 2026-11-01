from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image

RAW = REPO / "qq-persona/p1/素材-帧/raw"
MEDIA = REPO / "bot-home/media/onebot/stickers/memes"
names = [p.stem for p in RAW.glob("*.png") if (MEDIA / p.name).exists()]
done = 0
for n in names:
    src = RAW / f"{n}.png"
    im = Image.open(src).convert("RGBA")
    alpha = im.getchannel("A").point(lambda a: 255 if a > 24 else 0)
    bbox = alpha.getbbox()
    if not bbox:
        continue
    im = im.crop(bbox)
    pad = 10
    side = max(im.size) + pad * 2
    canvas = Image.new("RGBA", (side, side), (255, 255, 255, 0))
    canvas.alpha_composite(im, ((side - im.width) // 2, (side - im.height) // 2))
    if max(canvas.size) > 400:
        canvas.thumbnail((400, 400), Image.LANCZOS)
    canvas.save(src)
    canvas.save(MEDIA / f"{n}.png")
    done += 1
print("re-cropped", done)
