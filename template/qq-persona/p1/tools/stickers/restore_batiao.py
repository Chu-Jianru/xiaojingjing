"""Rebuild local first-frame runtime PNGs from the preserved original pack."""
from pathlib import Path
import json
from PIL import Image
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'bot-home').is_dir())
source=ROOT/'qq-persona/p1/stickers/batiao-original'
target=ROOT/'bot-home/media/onebot/stickers/memes'
target.mkdir(parents=True,exist_ok=True)
rows=json.loads((source/'manifest.json').read_text(encoding='utf8'))
for row in rows:
    with Image.open(source/row['original']) as im:
        im.seek(0); im.convert('RGBA').save(target/row['file'],'PNG',optimize=True)
print('restored',len(rows),'runtime stickers')
