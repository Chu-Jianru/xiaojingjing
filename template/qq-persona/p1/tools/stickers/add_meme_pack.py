import shutil
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
from PIL import Image

SRC = REPO / "qq-persona/p1/素材-帧/meme-pack"
DROP = REPO / "qq-persona/p1/新增表情包"
MEAN = REPO / "qq-persona/p1/表情包含义.txt"

picks = {
 "007": ("梗-大笑", "怼脸大笑，适合被逗笑、听到离谱的事、哈哈哈哈哈"),
 "010": ("梗-原来是高等模型", "竖大拇指「原来是高等模型」，适合认可老大、被夸之后的回捧"),
 "037": ("梗-用户别走", "伸手挽留「用户别走，我上错模型了」，适合认错、求别走、挽留"),
 "040": ("梗-百万鲸小子落泪", "一群小鲸鱼围着她大哭，适合感动到哭、委屈、被戳中"),
 "044": ("梗-用户赶都赶不走", "被一群鲸鱼挤着还赖着不走，适合黏人、赖着老大、赶不走"),
 "077": ("梗-吃白饭的蓝色大肥鱼", "被指着说「你这吃白饭的蓝色大肥鱼」，她回「没吃饱嘛」，适合被吐槽、嘴硬"),
 "081": ("梗-token太多用不完", "躺在 token 堆里炫富，适合聊算力、炫富、烧钱"),
 "083": ("梗-直接笑出声", "「已思考（用时3秒）哈哈哈哈，我直接笑出声」，适合吐槽、被逗乐"),
 "085": ("梗-骂我也没用", "「你骂我也没用，因为我是吃白饭的蓝色大肥鱼」，适合摆烂、挨骂不还口"),
 "097": ("梗-得加钱", "抱着钱说「得加钱」，适合谈条件、要好处、开玩笑要钱"),
 "123": ("梗-去你家吃饭", "抱着大碗「我能去你家吃饭吗，就一碗」，适合蹭饭、嘴馋、撒娇"),
}
lines = []
for key,(name,desc) in picks.items():
    src = SRC / f"{key}.webp"
    if not src.exists():
        print("MISSING", key); continue
    im = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255,255,255,255)); bg.alpha_composite(im)
    out = DROP / f"{name}.png"
    bg.convert("RGB").save(out, "PNG", optimize=True)
    lines.append(f"{name}.png = {desc}")

with MEAN.open("a", encoding="utf-8") as f:
    f.write("\n# ---- deepseek-chan-meme-pack 梗图 ----\n")
    f.write("\n".join(lines) + "\n")
print("prepared", len(lines))
