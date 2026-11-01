from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image, ImageFilter

BAK = REPO / "qq-persona/p1/素材-帧/stickers-backup"
D = REPO / "bot-home/media/onebot/stickers/memes"

small = []
for b in sorted(BAK.glob("*.png")):
    im = Image.open(b)
    if max(im.size) >= 300:
        continue
    small.append(b)

for b in small:
    im = Image.open(b).convert("RGBA")
    alpha = im.getchannel("A")
    transparent = alpha.getextrema()[0] < 250
    scale = 512 / max(im.size)
    im = im.resize((max(1, round(im.width*scale)), max(1, round(im.height*scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (512, 512), (255,255,255,0) if transparent else (255,255,255,255))
    canvas.alpha_composite(im, ((512-im.width)//2, (512-im.height)//2))
    r,g,b2,a = canvas.split()
    rgb = Image.merge("RGB",(r,g,b2)).filter(ImageFilter.UnsharpMask(radius=1.4, percent=170, threshold=2))
    r2,g2,b3 = rgb.split()
    Image.merge("RGBA",(r2,g2,b3,a)).save(D / b.name, "PNG", optimize=True)

print("re-sharpened", len(small))
