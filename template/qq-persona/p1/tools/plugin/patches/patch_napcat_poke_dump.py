"""Dump NapCat gray-tip pokes (busiId 1061) with resolved QQ numbers.

QQ delivers 戳一戳 as a gray tip. Group pokes go through `parseGrayTipElement`,
private ones through `parsePrivateMsgEvent`. NapCat 4.18.41 did not emit the
OneBot notice on this setup, so capture the tips ourselves, resolve the two
uids to QQ numbers, and let DSH poll the file.

Line shape:
  {at, peerUid, chatType, msgType, busiId, uins:[poker,target], userUin, targetUin}

Idempotent; validates with node --check and restores the backup on failure:

  python tools/plugin/patches/patch_napcat_poke_dump.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
# NapCat 运行目录在仓库外（机器绑定）；换机器用环境变量 NAPCAT_MJS 指到新 napcat.mjs
NAPCAT = Path(
    os.environ.get("NAPCAT_MJS")
    or r"C:/Users/USER\NapCat-p1\shell\versions\9.9.33-52230\resources\app\napcat\napcat.mjs"
)
BACKUP = NAPCAT.with_suffix(".mjs.bak-pokedump")
MARKER = "[dsh-poke-dump]"

ANCHORS = (
    "  async parseGrayTipElement(e, n) {",
    "  async parsePrivateMsgEvent(e, n) {",
)

DUMP = r"""
        // [dsh-poke-dump] capture gray tips (poke = busiId 1061) for DSH.
        try {
            const __gt = n ?? {};
            const __json = __gt.jsonGrayTipElement ?? {};
            if (String(__json.busiId ?? '') === '1061' && __json.jsonStr) {
                const __parsed = JSON.parse(__json.jsonStr);
                const __uids = (Array.isArray(__parsed?.items) ? __parsed.items : [])
                    .filter(item => item && item.uid).map(item => item.uid);
                const __uins = [];
                for (const __uid of __uids) {
                    try { __uins.push(String(await this.core.apis.UserApi.getUinByUidV2(__uid))); }
                    catch { __uins.push(''); }
                }
                fe.appendFileSync('__MEDIA_JSONL__', JSON.stringify({
                    at: Date.now(),
                    peerUid: e?.peerUid ?? '',
                    chatType: e?.chatType ?? null,
                    msgType: e?.msgType ?? null,
                    busiId: '1061',
                    uins: __uins,
                    userUin: __uins[0] ?? '',
                    targetUin: __uins[1] ?? '',
                }) + '\n');
            }
        } catch {}
""".replace(
    "__MEDIA_JSONL__",
    str(REPO / "bot-home" / "media" / "onebot" / "poke-raw.jsonl").replace("\\", "\\\\"),
)


def parses(path: Path) -> bool:
    result = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr.strip()[:500])
    return result.returncode == 0


def apply() -> None:
    text = NAPCAT.read_text(encoding="utf-8")
    missing = [anchor for anchor in ANCHORS if anchor + DUMP not in text]
    if not missing:
        print("napcat poke dump already patched")
        return
    for anchor in missing:
        if anchor not in text:
            raise SystemExit(f"napcat anchor changed ({anchor[:40]}…) — version mismatch")
    if not BACKUP.exists():
        shutil.copy2(NAPCAT, BACKUP)
    for anchor in missing:
        text = text.replace(anchor, anchor + DUMP, 1)
    NAPCAT.write_text(text, encoding="utf-8")
    if not parses(NAPCAT):
        shutil.copy2(BACKUP, NAPCAT)
        raise SystemExit("patched bundle failed node --check; restored backup")
    print(f"patched {NAPCAT} ({text.count(MARKER)} hook(s), backup: {BACKUP.name})")


def check() -> int:
    ok = NAPCAT.read_text(encoding="utf-8").count(MARKER) >= len(ANCHORS)
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BACKUP.exists():
        shutil.copy2(BACKUP, NAPCAT)
        BACKUP.unlink()
        print(f"reverted {NAPCAT}")
    else:
        print("no backup; nothing reverted")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.check:
        sys.exit(check())
    if args.revert:
        revert()
        return
    apply()


if __name__ == "__main__":
    main()
