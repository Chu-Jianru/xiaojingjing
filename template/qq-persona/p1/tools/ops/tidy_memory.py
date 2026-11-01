"""每日长期记忆检查：只报告，不修改或截断原始记忆。

纯规则，不调模型。跑法：
  python tools/ops/tidy_memory.py                 # 整理
  python tools/ops/tidy_memory.py --dry-run       # 只报告，不写
  python tools/ops/tidy_memory.py --media-dir <临时目录>   # 测试用

历史的跨会话去重/autoKey覆盖/500条截断已退役。重复只在召回展示时处理；
检查不会删除事实、事件或用户原始记录，也不会与在线写入竞争。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

DEFAULT_MEDIA_DIR = REPO / "bot-home/media/onebot"


def load_records(path: Path) -> tuple[list[dict], int]:
    records: list[dict] = []
    bad = 0
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return records, bad
    for line in raw.splitlines():
        line = line.strip()
        if line == "":
            continue
        try:
            entry = json.loads(line)
        except Exception:
            bad += 1
            continue
        if not isinstance(entry, dict):
            bad += 1
            continue
        text = str(entry.get("text") or "").strip()
        if text == "":
            bad += 1
            continue
        entry["text"] = text
        records.append(entry)
    return records, bad


def log_line(memory: Path, message: str) -> None:
    try:
        memory.mkdir(parents=True, exist_ok=True)
        with (memory / "tidy.log").open("a", encoding="utf-8") as fh:
            fh.write(datetime.now().strftime("%Y-%m-%d %H:%M:%S") + " " + message + "\n")
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--media-dir", default=str(DEFAULT_MEDIA_DIR))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    media = Path(args.media_dir)
    memory = media / "memory"
    target = memory / "memories.jsonl"
    records, bad = load_records(target)
    keys = [json.dumps(r, ensure_ascii=False, sort_keys=True) for r in records]
    exact_duplicates = len(keys) - len(set(keys))
    summary = f"memories: {len(records)} preserved (exact duplicate records {exact_duplicates}, bad {bad}); read-only audit"
    print(summary)
    if not args.dry_run:
        log_line(memory, summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
