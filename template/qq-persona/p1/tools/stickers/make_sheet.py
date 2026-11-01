from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image, ImageDraw, ImageFont
src = REPO / "qq-persona/p1/素材-帧/raw"
files = sorted(src.glob("*.png"))
font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 13)
cols, rows, cell = 6, 5, 200
per = cols*rows
out = REPO / "qq-persona/p1/素材-帧"
for page in range((len(files)+per-1)//per):
    chunk = files[page*per:(page+1)*per]
    sheet = Image.new("RGB", (cols*cell, rows*cell), (250,250,250))
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(chunk):
        im = Image.open(f).convert("RGBA")
        im.thumbnail((cell-12, cell-40))
        bg = Image.new("RGBA", im.size, (255,255,255,255)); bg.alpha_composite(im)
        x = (i%cols)*cell; y = (i//cols)*cell
        sheet.paste(bg.convert("RGB"), (x+6, y+22))
        label = f"{page*per+i+1}. {f.stem[:12]}"
        d.text((x+4, y+4), label, font=font, fill=(20,20,20))
    p = out / f"sheet-{page+1}.png"
    sheet.save(p)
    print(p, len(chunk))
