import subprocess, json
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image

SRC = Path.home()/".dsh/profiles/desktop/node_modules/dsh-pet/assets/webm"
OUT = REPO / "qq-persona/p1/素材-帧/raw"
OUT.mkdir(parents=True, exist_ok=True)
FF = r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"
FP = r"C:\Program Files\ffmpeg\bin\ffprobe.exe"

def duration(f):
    try:
        r = subprocess.run([FP,"-v","error","-show_entries","format=duration","-of","csv=p=0",str(f)],
                           capture_output=True, text=True)
        return float(r.stdout.strip())
    except Exception:
        return 0.0

def extract(f, t, dst):
    subprocess.run([FF,"-y","-v","error","-c:v","libvpx-vp9","-ss",f"{t:.2f}","-i",str(f),
                    "-frames:v","1","-pix_fmt","rgba",str(dst)], capture_output=True)

ok = 0
for f in sorted(SRC.glob("*.webm")):
    dst = OUT/f"{f.stem}.png"
    d = duration(f)
    for ratio in (0.45, 0.35, 0.55, 0.0):
        extract(f, d*ratio, dst)
        if dst.exists():
            im = Image.open(dst).convert("RGBA")
            if im.getchannel("A").getextrema()[1] > 10 and len(set(im.getchannel("A").getdata())) > 8:
                break
    if dst.exists():
        ok += 1
print("frames:", ok)

# 自动裁边 + 方形白底
for p in sorted(OUT.glob("*.png")):
    im = Image.open(p).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox:
        im = im.crop(bbox)
    side = max(im.size) + 24
    canvas = Image.new("RGBA", (side, side), (255,255,255,0))
    canvas.alpha_composite(im, ((side-im.width)//2, (side-im.height)//2))
    if max(canvas.size) > 420:
        canvas.thumbnail((420,420), Image.LANCZOS)
    canvas.save(p)
print("cropped")
