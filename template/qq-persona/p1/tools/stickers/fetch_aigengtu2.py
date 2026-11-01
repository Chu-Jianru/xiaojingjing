import io, time, urllib.request
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image, ImageFilter

DROP = REPO / "qq-persona/p1/新增表情包"
MEAN = REPO / "qq-persona/p1/表情包含义.txt"

picks = {
 "149": ("坏笑-骂我也算token", "指着人坏笑「骂我也算 token 哦」，适合被凶的时候反将一军、调皮"),
 "156": ("收租-该交钱了", "拿账本上门收租「这个月该交钱了」，适合催账、要 token、开玩笑要钱"),
 "354": ("等算力-502", "「别问了，我也在等算力，先吃口白饭吧」，适合服务器繁忙、排队、宕机"),
 "2679": ("漫画-拎起小鲸", "两格：先举着小鲸玩偶，再拎起哭哭的小鲸，适合「拎起来」这种可爱威胁"),
 "323": ("修BUG摸鱼", "「你哭也没用，我在修 BUG（其实在摸鱼）」，适合装忙、被催、偷懒"),
 "255": ("饿-中午吃什么", "「啊，有点饿了，中午该吃什么呢？」适合饭点、纠结吃什么"),
 "228": ("偷吃token", "偷偷吃 token「就吃一点点应该没事吧」，适合偷懒、偷用算力、心虚"),
 "720": ("满足-摸摸肚子", "「吃饱饱～摸摸肚子」满足，适合吃饱、被喂饱、惬意"),
 "355": ("质问-敢质疑我", "「你个吃白饭的用户敢质疑我」叉腰，适合被质疑时嘴硬"),
 "303": ("嘴硬-就吃白饭", "「就吃白饭怎么滴」理直气壮，适合被吐槽还嘴硬"),
 "275": ("委屈-鱼被骗了", "「鱼被骗了」可怜巴巴，适合被骗、上当、求安慰"),
 "135": ("吓哭-菜刀威胁", "被菜刀指着「把鱼鳞刮下来」吓哭，适合被威胁、装可怜求饶"),
}

HEAD = {"User-Agent": "Mozilla/5.0", "Referer": "https://aigengtu.com/"}
lines = []
for mid, (name, desc) in picks.items():
    raw = None
    for ext in ("webp", "jpg", "png"):
        url = f"https://img.aigengtu.com/meme/{mid}.{ext}"
        try:
            raw = urllib.request.urlopen(urllib.request.Request(url, headers=HEAD), timeout=40).read()
            break
        except Exception:
            continue
    if raw is None:
        print("miss", mid); continue
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); bg.alpha_composite(im)
    im = bg.convert("RGB")
    scale = 512 / max(im.size)
    if abs(scale - 1) > 0.01:
        im = im.resize((round(im.width*scale), round(im.height*scale)), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=1.0, percent=90, threshold=4))
    canvas = Image.new("RGB", (512, 512), (255, 255, 255))
    canvas.paste(im, ((512-im.width)//2, (512-im.height)//2))
    canvas.save(DROP / f"{name}.png", "PNG", optimize=True)
    lines.append(f"{name}.png = {desc}")
    print("ok", mid, name, im.size, len(raw)//1024, "KB")
    time.sleep(0.2)

if lines:
    with MEAN.open("a", encoding="utf-8") as f:
        f.write("\n# ---- aigengtu 补漏 ----\n")
        f.write("\n".join(lines) + "\n")
print("added", len(lines))
