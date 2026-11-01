import io, time, urllib.request
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image, ImageFilter

DROP = REPO / "qq-persona/p1/新增表情包"
MEAN = REPO / "qq-persona/p1/表情包含义.txt"
DROP.mkdir(parents=True, exist_ok=True)

picks = {
 "089": ("哭-花了好多token", "哭着说「花了好多 token 才想出来的」，适合委屈、被否定、白忙一场"),
 "011": ("夸-不愧是你", "「不愧是你！眼光真棒！」开心夸赞，适合夸老大、捧场、被老大说中"),
 "060": ("摸鱼-下班瘫家", "下班瘫在家里玩手机，适合摸鱼、摆烂、周末躺平"),
 "149": ("坏笑-骂我也算token", "指着人坏笑「骂我也算 token 哦」，适合被凶的时候反将一军、调皮"),
 "055": ("干饭-全自动吃白饭", "「全自动吃白饭」开心干饭，适合饭点、被投喂、理直气壮蹭饭"),
 "156": ("收租-该交钱了", "拿账本上门收租「这个月该交钱了」，适合催账、要 token、开玩笑要钱"),
 "354": ("等算力-502", "「别问了，我也在等算力，先吃口白饭吧」，适合服务器繁忙、排队、宕机"),
 "2679": ("漫画-拎起小鲸", "两格：先举着小鲸玩偶，再拎起哭哭的小鲸，适合「拎起来」「拎走」这种可爱威胁"),
 "323": ("修BUG摸鱼", "「你哭也没用，我在修 BUG（其实在摸鱼）」，适合装忙、被催、偷懒"),
 "118": ("害羞-不要给我看", "「不要给我看这种东西啦」捂脸害羞，适合被发奇怪的东西、被撩"),
 "008": ("委屈-摸头会变笨", "瘪嘴「呜呜，摸头会变笨的啦」，适合被摸头、被逗、撒娇抗议"),
 "007": ("得意-这题我会", "「嘿嘿，这题我可太会了」眉开眼笑，适合被问到会的、显摆"),
 "002": ("哭-又错了换方法", "「又错了，我再换另一种方法」委屈落泪，适合搞砸了、反复失败"),
 "374": ("晚安-吃饱饱睡觉觉", "「吃饱饱，睡觉觉，长大大～」适合晚安、犯困、哄睡"),
 "255": ("饿-中午吃什么", "「啊，有点饿了，中午该吃什么呢？」适合饭点、纠结吃什么"),
 "228": ("偷吃token", "偷偷吃 token「就吃一点点应该没事吧」，适合偷懒、偷用算力、心虚"),
 "032": ("大哭-涨价了", "「坠机了！大幅涨价了！」崩溃大哭，适合坏消息、钱包受伤"),
 "023": ("大哭-被坑了", "「怎么这么坏啊」崩溃大哭，适合被坑、委屈到极点"),
 "720": ("满足-摸摸肚子", "「吃饱饱～摸摸肚子」满足，适合吃饱、被喂饱、惬意"),
 "496": ("溜了-先去吃饭", "「这个你测一下～我先去吃饭啦」溜走，适合甩锅、开溜、饭点消失"),
 "355": ("质问-敢质疑我", "「你个吃白饭的用户敢质疑我」叉腰，适合被质疑时嘴硬"),
 "303": ("嘴硬-就吃白饭", "「就吃白饭怎么滴」理直气壮，适合被吐槽还嘴硬"),
 "275": ("委屈-鱼被骗了", "「鱼被骗了」可怜巴巴，适合被骗、上当、求安慰"),
 "096": ("慌张-用户怒了", "「卧槽，用户彻底怒了」手忙脚乱，适合闯祸、惹老大生气"),
 "094": ("疑惑-这个凶是什么意思", "「大师，这个『凶』是什么意思啊」一脸疑惑，适合看不懂、求解释"),
 "078": ("溜了-测完叫我", "「我去吃饭啦～测完叫我」理直气壮开溜"),
 "072": ("反手指责-你才是吃白饭的", "反手指着对方「你这吃白饭的用户」，适合反将一军、互怼"),
 "028": ("加班-双休落空", "四格「双休计划落空、周末加班」，适合加班、被临时叫起来干活"),
 "009": ("元气-我是大肥鱼", "「我是吃白饭的大肥鱼！」元气搞怪，适合自报家门、开场卖萌"),
 "005": ("崩溃-把钱还我", "「把钱还我」崩溃，适合花钱心疼、被坑"),
 "135": ("吓哭-菜刀威胁", "被菜刀指着「把鱼鳞刮下来」吓哭，适合被威胁、装可怜求饶"),
}

lines = []
for mid, (name, desc) in picks.items():
    url = f"https://img.aigengtu.com/meme/{mid}.webp"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://aigengtu.com/"})
    try:
        raw = urllib.request.urlopen(req, timeout=40).read()
    except Exception as e:
        print("skip", mid, e)
        continue
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
    time.sleep(0.2)

with MEAN.open("a", encoding="utf-8") as f:
    f.write("\n# ---- aigengtu 高清原图（848px 源） ----\n")
    f.write("\n".join(lines) + "\n")
print("downloaded", len(lines))

