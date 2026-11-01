"""长期规则 (rules set through conversation) for 小鲸鲸.

Facts already have a home (`qq_remember`). This adds *instructions*: "以后遇到 X
就这么做". The admin says it in DM, the model calls `qq_rule`, and the rule is
injected as a trusted `[规则]` block whenever the message matches its trigger.

  - module: lib/rules.js (source tools/plugin/modules/onebot_rules.js)
  - tool:   `qq_rule` (add / list / remove; add/remove only in admin DM)
  - prompt: [规则] block prepended by inbound.js

Idempotent; re-run after `dsh plugin` upgrades, then restart DSH:

  python tools/plugin/patches/patch_onebot_rules.py [--check|--revert]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS.parent / "modules" / "onebot_rules.js"
LIB = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib"
DEST = LIB / "rules.js"
TOOLS_JS = LIB / "tools.js"
INBOUND = LIB / "inbound.js"
MARKER = "[dsh-p1] rules"

TOOLS_IMPORT_OLD = "import { defineTool } from '@deepseek-ai/dsh-tools';"
TOOLS_IMPORT_NEW = TOOLS_IMPORT_OLD + "\nimport { addRule, listRules, removeRules } from './rules.js';"

TOOLS_ANCHOR = "    // -- [dsh-p1] long-term memory --\n    return () => {"

TOOLS_HOOK = """    register(defineTool({
        name: 'qq_rule',
        description: '长期规则：老大用「以后…/遇到…就…」交代的做法，用 action=add 记下来（when=触发情况，then=怎么做，scope 可 global/group:群号/private:QQ）；action=list 查看；action=remove 删除。加/删只在老大私聊里有效。',
        parameters: {
            action: { type: 'string', description: 'add / list / remove' },
            when: { type: 'string', description: 'add：触发情况；留空=每次都生效' },
            then: { type: 'string', description: 'add：要怎么做' },
            scope: { type: 'string', description: 'add：global / group:<群号> / private:<QQ>，默认 global' },
            remove: { type: 'string', description: 'remove：规则 id 或关键词' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 1) }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const chatId = resolveChat(bridge, exec, undefined);
            const mediaDir = bridge.deps?.config?.mediaDir ?? 'E:\\\\dsh\\\\bot-home\\\\media\\\\onebot';
            const admins = Array.isArray(bridge?.deps?.policy?.adminUsers) ? bridge.deps.policy.adminUsers.map(String) : [];
            const peer = splitChatId(chatId).kind === 'private' ? splitChatId(chatId).target : '';
            const isAdminDm = peer !== '' && admins.includes(String(peer));
            if (a.action === 'list')
                return await listRules(mediaDir, chatId);
            if (!isAdminDm)
                throw new Error('qq_rule: 只有老大私聊里才能设置或删除规则');
            if (a.action === 'remove')
                return { removed: await removeRules(mediaDir, a.remove) };
            const rule = await addRule(mediaDir, {
                when: typeof a.when === 'string' ? a.when : '',
                then: a.then,
                scope: typeof a.scope === 'string' && a.scope !== '' ? a.scope : 'global',
                by: String(peer),
            });
            return { ok: true, rule };
        },
    }));
    // -- [dsh-p1] long-term memory --
    return () => {"""

INBOUND_IMPORT_OLD = "import { describeError } from './errors.js';"
INBOUND_IMPORT_NEW = INBOUND_IMPORT_OLD + "\nimport { renderRules } from './rules.js';"

INBOUND_ANCHOR = """        const profileBlock = await renderProfileBlock(this.ctx.config.mediaDir, userId, nickname);
        if (profileBlock !== '')
            final = profileBlock + '\\n' + final;"""

INBOUND_HOOK = INBOUND_ANCHOR + """
        // [dsh-p1] rules: trusted instructions the admin set through chat.
        const rulesBlock = await renderRules(this.ctx.config.mediaDir, { text: inbound.text, chatId });
        if (rulesBlock !== '')
            final = rulesBlock + '\\n' + final;"""


def patch_file(path: Path, old: str, new: str, suffix: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        print(f"{path.name} already patched")
        return
    if old not in text:
        raise SystemExit(f"{path.name}: anchor changed — plugin version mismatch")
    backup = path.with_suffix(f".js{suffix}")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched {path} (backup: {backup.name})")


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("rules.js up to date")
        return
    DEST.write_text(source, encoding="utf-8")
    print(f"installed {DEST}")


def apply() -> None:
    patch_file(TOOLS_JS, TOOLS_IMPORT_OLD, TOOLS_IMPORT_NEW, ".bak-rules")
    patch_file(TOOLS_JS, TOOLS_ANCHOR, TOOLS_HOOK, ".bak-rules")
    patch_file(INBOUND, INBOUND_IMPORT_OLD, INBOUND_IMPORT_NEW, ".bak-rules")
    patch_file(INBOUND, INBOUND_ANCHOR, INBOUND_HOOK, ".bak-rules")
    install_module()


def check() -> int:
    ok = "qq_rule" in TOOLS_JS.read_text(encoding="utf-8")
    ok = ok and "renderRules" in INBOUND.read_text(encoding="utf-8")
    ok = ok and DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    for path in (TOOLS_JS, INBOUND):
        backup = path.with_suffix(".js.bak-rules")
        if backup.exists():
            shutil.copy2(backup, path)
            backup.unlink()
            print(f"reverted {path}")
    if DEST.exists():
        DEST.unlink()
        print(f"removed {DEST}")


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
