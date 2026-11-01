from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image, ImageFilter

D = REPO / "bot-home/media/onebot/stickers/memes"
BAK = REPO / "qq-persona/p1/素材-帧/stickers-backup"
BAK.mkdir(parents=True, exist_ok=True)

def process(p: Path):
    im = Image.open(p).convert("RGBA")
    alpha = im.getchannel("A")
    transparent = alpha.getextrema()[0] < 250
    # 缩放到 512 见方
    scale = 512 / max(im.size)
    if abs(scale - 1) > 0.01:
        im = im.resize((max(1, round(im.width*scale)), max(1, round(im.height*scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (512, 512), (255, 255, 255, 0) if transparent else (255, 255, 255, 255))
    canvas.alpha_composite(im, ((512-im.width)//2, (512-im.height)//2))
    # 只锐化颜色，不动 alpha
    r, g, b, a = canvas.split()
    rgb = Image.merge("RGB", (r, g, b)).filter(ImageFilter.UnsharpMask(radius=1.1, percent=115, threshold=3))
    r2, g2, b2 = rgb.split()
    out = Image.merge("RGBA", (r2, g2, b2, a))
    out.save(p, "PNG", optimize=True)

files = sorted(D.glob("*.png"))
for p in files:
    b = BAK / p.name
    if not b.exists():
        b.write_bytes(p.read_bytes())
    process(p)
print("processed", len(files))
