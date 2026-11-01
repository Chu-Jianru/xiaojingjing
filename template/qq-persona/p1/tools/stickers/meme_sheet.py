from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image, ImageDraw, ImageFont
src = REPO / "qq-persona/p1/素材-帧/meme-pack"
files = sorted(src.glob("*.webp"))
font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)
cols, cell = 5, 240
rows = (len(files)+cols-1)//cols
sheet = Image.new("RGB", (cols*cell, rows*cell), (250,250,250))
d = ImageDraw.Draw(sheet)
for i,f in enumerate(files):
    im = Image.open(f).convert("RGBA")
    im.thumbnail((cell-10, cell-30))
    bg = Image.new("RGBA", im.size, (255,255,255,255)); bg.alpha_composite(im)
    x=(i%cols)*cell; y=(i//cols)*cell
    sheet.paste(bg.convert("RGB"), (x+5, y+24))
    d.text((x+4,y+4), f.stem, font=font, fill=(20,20,20))
p = src/"sheet.png"; sheet.save(p); print(p, len(files))
