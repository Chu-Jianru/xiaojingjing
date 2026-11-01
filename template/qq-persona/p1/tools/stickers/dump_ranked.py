import json
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
d = json.loads(REPO / "qq-persona/p1/素材-帧/aigengtu/catalog.json".read_text(encoding="utf-8"))
kw = {"笑":6,"开心":6,"乐":4,"嘿嘿":5,"嘻嘻":5,"哈":4,"哭":6,"泪":5,"委屈":6,"难过":6,"崩":4,
 "生气":6,"怒":5,"哼":5,"气鼓鼓":6,"凶":4,"骂":4,"害羞":6,"脸红":6,"羞":5,"紧张":4,"心动":5,"喜欢":5,
 "亲":5,"贴":5,"抱":5,"困":5,"睡":5,"累":5,"瘫":4,"摆烂":5,"摸鱼":5,"惊":5,"吓":4,"震撼":4,
 "无语":5,"疑惑":5,"问号":4,"吃":5,"饭":4,"饿":5,"摸肚子":4,"好吃":5,"token":5,"算力":4,"钱":4,
 "穷":4,"加班":4,"下班":4,"早":3,"晚安":5,"想":4,"等你":4,"陪":4,"摸头":5,"夸":4,"棒":4,"赞":4}
rows=[(sum(w for k,w in kw.items() if k in t), mid, t) for mid,t in d.items()]
rows=[r for r in rows if r[0]>=8]
rows.sort(reverse=True)
lines=[f"{s}\t{mid}\t{t}" for s,mid,t in rows[:80]]
REPO / "qq-persona/p1/素材-帧/aigengtu/ranked.txt".write_text("\n".join(lines), encoding="utf-8")
print("written", len(lines))
