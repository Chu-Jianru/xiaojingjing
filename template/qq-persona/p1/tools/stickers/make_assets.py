"""生成小鲸鲸的头像与表情包（纯 Pillow 手绘，原创素材）。v2。"""
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image, ImageDraw, ImageFont

OUT = REPO / "qq-persona/p1"
STK = OUT / "stickers"
STK.mkdir(parents=True, exist_ok=True)

SKIN = (255, 226, 208, 255)
HAIR = (86, 186, 216, 255)
HAIR_DARK = (52, 146, 178, 255)
HAIR_LIGHT = (150, 219, 238, 255)
EYE = (34, 62, 90, 255)
BLUSH = (255, 150, 162, 120)
WHITE = (255, 255, 255, 255)
MOUTH = (200, 96, 96, 255)
NAVY = (43, 76, 126, 255)
TAIL = (94, 200, 226, 255)

FONT = r"C:\Windows\Fonts\msyh.ttc"
def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except Exception:
        return ImageFont.load_default()


def fluke(d, x, y, s, color=TAIL):
    """小鲸鱼尾鳍：两个有厚度的三角。"""
    d.polygon([(x, y), (x - s * 0.95, y - s * 0.55), (x - s * 0.22, y + s * 0.18)], fill=color)
    d.polygon([(x, y), (x + s * 0.95, y - s * 0.55), (x + s * 0.22, y + s * 0.18)], fill=color)
    d.ellipse([x - s * 0.10, y - s * 0.10, x + s * 0.10, y + s * 0.10], fill=color)


def spout(d, cx, cy, s):
    d.arc([cx - s * 0.9, cy - s * 1.5, cx + s * 0.05, cy + s * 0.1], 200, 340, fill=HAIR_LIGHT, width=max(2, int(s * 0.22)))
    d.arc([cx - s * 0.05, cy - s * 1.5, cx + s * 0.9, cy + s * 0.1], 200, 340, fill=HAIR_LIGHT, width=max(2, int(s * 0.22)))
    for dx, dy, r in ((-0.5, -1.8, 0.16), (0.4, -2.0, 0.13)):
        d.ellipse([cx + dx * s - r * s, cy + dy * s - r * s, cx + dx * s + r * s, cy + dy * s + r * s], fill=HAIR_LIGHT)


def head(d, cx, cy, r, kind="front", body=False):
    # 后发（略大于脸）
    d.ellipse([cx - r * 1.14, cy - r * 1.16, cx + r * 1.14, cy + r * 1.10], fill=HAIR)
    # 侧发
    for sx in (-1, 1):
        x = cx + sx * r * 0.95
        d.ellipse([x - r * 0.24, cy - r * 0.55, x + r * 0.24, cy + r * 0.95], fill=HAIR)
    # 脸
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SKIN)
    # 刘海：一整片半圆，盖住上半张脸，露出额头
    d.pieslice([cx - r * 1.04, cy - r * 1.12, cx + r * 1.04, cy + r * 0.22], 180, 360, fill=HAIR)
    # 发丝高光
    d.arc([cx - r * 0.80, cy - r * 0.92, cx + r * 0.15, cy + r * 0.10], 205, 300, fill=HAIR_LIGHT, width=max(2, int(r * 0.07)))
    # 呆毛
    d.arc([cx - r * 0.05, cy - r * 1.42, cx + r * 0.42, cy - r * 0.98], 250, 60, fill=HAIR_DARK, width=max(2, int(r * 0.05)))
    # 尾鳍发饰（左上，压在头发上）
    fluke(d, cx - r * 0.66, cy - r * 0.76, r * 0.34)
    # 水柱
    spout(d, cx + r * 0.72, cy - r * 1.02, r * 0.16)
    if body:
        d.rounded_rectangle([cx - r * 0.22, cy + r * 0.80, cx + r * 0.22, cy + r * 1.15], radius=int(r * 0.12), fill=SKIN)


def eyes(d, cx, cy, r, kind):
    ex, ey = r * 0.40, cy + r * 0.12
    if kind == "happy":
        for sx in (-1, 1):
            x = cx + sx * ex
            d.arc([x - r * 0.18, ey - r * 0.10, x + r * 0.18, ey + r * 0.16], 200, 340, fill=EYE, width=max(3, int(r * 0.07)))
        return
    if kind == "shy":
        for sx in (-1, 1):
            x = cx + sx * ex
            d.arc([x - r * 0.18, ey - r * 0.06, x + r * 0.18, ey + r * 0.14], 190, 350, fill=EYE, width=max(3, int(r * 0.06)))
        return
    if kind == "sleepy":
        for sx in (-1, 1):
            x = cx + sx * ex
            d.arc([x - r * 0.18, ey - r * 0.02, x + r * 0.18, ey + r * 0.16], 20, 160, fill=EYE, width=max(3, int(r * 0.06)))
        return
    for sx in (-1, 1):
        x = cx + sx * ex
        d.ellipse([x - r * 0.19, ey - r * 0.22, x + r * 0.19, ey + r * 0.22], fill=WHITE)
        d.ellipse([x - r * 0.15, ey - r * 0.17, x + r * 0.15, ey + r * 0.18], fill=EYE)
        d.ellipse([x - r * 0.14, ey + r * 0.02, x + r * 0.10, ey + r * 0.16], fill=(70, 110, 150, 255))
        d.ellipse([x - r * 0.10, ey - r * 0.13, x - r * 0.02, ey - r * 0.03], fill=WHITE)
        if kind == "wow":
            d.ellipse([x + r * 0.01, ey + r * 0.03, x + r * 0.07, ey + r * 0.10], fill=WHITE)
        if kind == "cry":
            d.ellipse([x - r * 0.06, ey + r * 0.22, x + r * 0.06, ey + r * 0.40], fill=(130, 205, 246, 255))
    if kind == "angry":
        for sx in (-1, 1):
            x = cx + sx * ex
            d.line([x - r * 0.16, ey - r * 0.34, x + r * 0.14, ey - r * 0.22], fill=EYE, width=max(3, int(r * 0.06)))


def mouth(d, cx, cy, r, kind):
    my = cy + r * 0.56
    if kind == "happy":
        d.pieslice([cx - r * 0.17, my - r * 0.18, cx + r * 0.17, my + r * 0.20], 0, 180, fill=MOUTH)
    elif kind == "cry":
        d.arc([cx - r * 0.15, my - r * 0.12, cx + r * 0.15, my + r * 0.12], 200, 340, fill=MOUTH, width=max(2, int(r * 0.05)))
        d.arc([cx - r * 0.15, my - r * 0.02, cx + r * 0.15, my + r * 0.22], 20, 160, fill=MOUTH, width=max(2, int(r * 0.05)))
    elif kind == "angry":
        d.arc([cx - r * 0.13, my - r * 0.06, cx + r * 0.13, my + r * 0.12], 200, 340, fill=MOUTH, width=max(2, int(r * 0.05)))
    elif kind == "shy":
        d.arc([cx - r * 0.10, my - r * 0.06, cx + r * 0.10, my + r * 0.07], 0, 180, fill=MOUTH, width=max(2, int(r * 0.04)))
    elif kind == "sleepy":
        d.ellipse([cx - r * 0.05, my - r * 0.03, cx + r * 0.05, my + r * 0.06], fill=MOUTH)
    else:
        d.arc([cx - r * 0.13, my - r * 0.08, cx + r * 0.13, my + r * 0.12], 20, 160, fill=MOUTH, width=max(2, int(r * 0.045)))


def blush(d, cx, cy, r):
    for sx in (-1, 1):
        x = cx + sx * r * 0.64
        d.ellipse([x - r * 0.15, cy + r * 0.34, x + r * 0.15, cy + r * 0.52], fill=BLUSH)


def sticker(name, kind, text=None):
    S = 240
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy, r = S / 2, S * 0.44, S * 0.25
    head(d, cx, cy, r, kind)
    eyes(d, cx, cy, r, kind)
    mouth(d, cx, cy, r, kind)
    if kind in ("shy", "happy"):
        blush(d, cx, cy, r)
    if kind == "angry":
        d.line([S * 0.76, S * 0.18, S * 0.81, S * 0.25], fill=(232, 88, 88, 255), width=5)
        d.line([S * 0.81, S * 0.18, S * 0.76, S * 0.25], fill=(232, 88, 88, 255), width=5)
    if kind == "sleepy":
        d.text((S * 0.74, S * 0.16), "z", font=font(28), fill=HAIR_DARK)
        d.text((S * 0.82, S * 0.09), "z", font=font(20), fill=HAIR_DARK)
    if text:
        f = font(26)
        box = d.textbbox((0, 0), text, font=f)
        tw, th = box[2] - box[0], box[3] - box[1]
        x, y = (S - tw) / 2, S * 0.84
        d.rounded_rectangle([x - 14, y - 8, x + tw + 14, y + th + 12], radius=13, fill=(255, 255, 255, 240))
        d.text((x, y), text, font=f, fill=NAVY)
    img.save(STK / f"{name}.png")
    return name


def avatar():
    S = 512
    img = Image.new("RGBA", (S, S), (236, 248, 252, 255))
    d = ImageDraw.Draw(img)
    for i, c in enumerate([(214, 240, 247, 255), (194, 231, 240, 255)]):
        d.ellipse([-S * 0.25, S * (0.80 + i * 0.07), S * 1.25, S * (1.08 + i * 0.09)], fill=c)
    cx, cy, r = S / 2, S * 0.42, S * 0.235
    # 肩膀 / 水手服
    d.rounded_rectangle([cx - r * 1.55, cy + r * 1.02, cx + r * 1.55, S * 1.05], radius=int(r * 0.30), fill=WHITE)
    # 领口 V 线
    d.line([(cx - r * 0.55, cy + r * 1.02), (cx, cy + r * 1.42)], fill=NAVY, width=max(4, int(r * 0.10)))
    d.line([(cx + r * 0.55, cy + r * 1.02), (cx, cy + r * 1.42)], fill=NAVY, width=max(4, int(r * 0.10)))
    head(d, cx, cy, r, "front", body=True)
    eyes(d, cx, cy, r, "front")
    mouth(d, cx, cy, r, "front")
    blush(d, cx, cy, r)
    img.convert("RGB").save(OUT / "avatar.png", quality=95)
    return "avatar.png"


made = [
    sticker("01-happy", "happy", "好耶"),
    sticker("02-shy", "shy", "呜…"),
    sticker("03-cry", "cry", "委屈"),
    sticker("04-angry", "angry", "哼"),
    sticker("05-sleepy", "sleepy", "困了"),
    sticker("06-wow", "wow", "真的假的"),
    avatar(),
]
print("generated:", made)

