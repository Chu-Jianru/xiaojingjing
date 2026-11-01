#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[dsh-p1] v2.28 agent tier — qq_send_text + qq_agent_api（管理级 QQ 操作，仅老大的回合可用）。

往 lib/tools.js 插入两个工具块（锚点：qq_napcat_api 注册块之前）+ 一行 import；
源模块 tools/plugin/modules/onebot_agent_api.js 字节拷贝为 lib/agent-api.js。
幂等；`dsh plugin` 升级后重放本补丁，然后真重启 DSH（stop-companion + schtasks /run）。
门禁实现在 lib/tools.js 的 activeTurnRole（bridge 冻结的本回合发起者角色），fail-closed。
用法：python patch_onebot_agent_api.py [--check | --revert]
"""
import shutil
import sys
import re
from pathlib import Path

REPO = next(p for p in Path(__file__).resolve().parents
            if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())
LIB = REPO / "bot-home" / "profiles" / "companion" / "node_modules" / "dsh-onebot-qq" / "lib"
SRC = REPO / "qq-persona" / "p1" / "tools" / "plugin" / "modules" / "onebot_agent_api.js"
DEST = LIB / "agent-api.js"
TARGET = LIB / "tools.js"
BACKUP = TARGET.with_suffix(".js.bak-agentapi")

MARKER = "[dsh-p1] v2.28 agent tier"
IMPORT_ANCHOR = "import { lookImage } from './vision.js';"
IMPORT_NEW = (IMPORT_ANCHOR
              + "\nimport { classifyAgentAction, isAdminTurn, summarizeAgentParams, writeAgentAudit, executeFriendApproval,"
              + "\n    NAPCAT_AGENT_ACTIONS, MAX_AGENT_TEXT, MSG_AGENT_NOT_ADMIN, MSG_AGENT_DENIED, MSG_AGENT_NOT_WHITELIST"
              + "\n} from './agent-api.js';")
INSERT_ANCHOR = "    register(defineTool({\n        name: 'qq_napcat_api',"

TOOL_BLOCK = r'''    // [dsh-p1] v2.28 agent tier: 管理级 QQ 操作（qq_send_text / qq_agent_api）。
    // 仅老大的回合可用：门禁查 bridge 冻结的 activeTurnRole（本回合发起者角色），fail-closed；
    // 每次调用（含被拒的尝试）写 mediaDir/qq-actions.log 审计（action 记 agent:<名字>）。
    // 白名单/拒绝表/话术在 agent-api.js（源：tools/plugin/modules/onebot_agent_api.js）。
    const mediaDirOf = (b) => b?.deps?.config?.mediaDir ?? MEDIA_DIR_FALLBACK;
    register(defineTool({
        name: 'qq_send_text',
        description: '帮人传一条文字。老大可指定任意QQ会话；聊熟的朋友也可请你往双方共同的群传话，先看内容、目的和自己愿不愿意，不能代解禁或冒充别人。朋友传话会注明来源。必须真实调用且sent=true才算送达；拒绝时自然表达，不念权限、工具或亲密度分数。',
        parameters: {
            chat_id: { type: 'string', required: true, description: '目标会话：private:<QQ> 或 group:<群号>' },
            text: { type: 'string', required: true, description: '要发的文字（≤' + MAX_AGENT_TEXT + ' 字）' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const sessionId = exec.agent?.session.id;
            let chatId;
            try { chatId = resolveChat(bridge, exec, a.chat_id); }
            catch { chatId = 'unknown'; }
            const text = String(a.text ?? '');
            if (!text.trim()) throw new Error('qq_send_text: text 不能为空');
            if (text.length > MAX_AGENT_TEXT) throw new Error('qq_send_text: 文字超过 ' + MAX_AGENT_TEXT + ' 字，缩短或拆两条');
            try {
                const value = await relayText(bridge, sessionId, chatId, text);
                await writeAgentAudit(mediaDirOf(bridge), chatId, 'send_text', value.sent === true, summarizeAgentParams({ text, result: value.status }));
                return value;
            }
            catch (error) {
                await writeAgentAudit(mediaDirOf(bridge), chatId, 'send_text', false, String(error?.message ?? error).slice(0, 160));
                throw error;
            }
        },
    }));
    register(defineTool({
        name: 'qq_agent_api',
        description: 'Agent 级 QQ 操作（只有老大的回合可用）：代发消息、群管理（禁言/全体禁言/踢人/名片/头衔/设管理/精华/群公告/加群审批）、好友申请同意或拒绝、删好友、点赞、群打卡、输入状态、在线状态、改头像等。白名单外一律拒绝；凭据类（cookies/credentials）永不开放；不可逆动作（踢人/退群/删好友/改头像）只在老大明确说了才做。',
        parameters: {
            action: { type: 'string', required: true, description: 'agent 白名单 action：' + NAPCAT_AGENT_ACTIONS.join(' / ') },
            params: { type: 'object', additionalProperties: true, description: 'action参数。好友审批set_friend_add_request优先给user_id=对方QQ、approve=布尔值；flag仅为申请标识，不能自己猜QQ充当flag；submitted未confirmed不说已经加上' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => {
                let text = JSON.stringify(value ?? null, null, 2);
                if (text.length > 3000) text = text.slice(0, 3000) + '…（截断）';
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args ?? {};
            const action = String(a.action ?? '');
            const sessionId = exec.agent?.session.id;
            let chatId;
            try { chatId = resolveChat(bridge, exec, undefined); }
            catch { chatId = 'unknown'; }
            const mediaDir = mediaDirOf(bridge);
            const tier = classifyAgentAction(action);
            if (tier === 'deny') {
                await writeAgentAudit(mediaDir, chatId, action, false, MSG_AGENT_DENIED);
                throw new Error('qq_agent_api: ' + MSG_AGENT_DENIED);
            }
            if (tier === 'unknown') {
                await writeAgentAudit(mediaDir, chatId, action, false, '不在 agent 白名单');
                throw new Error('qq_agent_api: ' + MSG_AGENT_NOT_WHITELIST);
            }
            if (!isAdminTurn(bridge, sessionId)) {
                await writeAgentAudit(mediaDir, chatId, action, false, '非老大回合尝试管理级操作');
                throw new Error('qq_agent_api: ' + MSG_AGENT_NOT_ADMIN);
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            try {
                const value = action === 'set_friend_add_request'
                    ? await executeFriendApproval(bridge, params)
                    : await bridge.guardedConnectionCall(action, params);
                await writeAgentAudit(mediaDir, chatId, action, true, summarizeAgentParams(params));
                return value;
            }
            catch (error) {
                await writeAgentAudit(mediaDir, chatId, action, false, String(error?.message ?? error).slice(0, 160));
                throw error;
            }
        },
    }));
'''


def install_module() -> None:
    source = SRC.read_text(encoding="utf-8")
    if DEST.exists() and DEST.read_text(encoding="utf-8") == source:
        print("agent-api.js up to date")
        return
    DEST.write_bytes(SRC.read_bytes())
    print(f"installed {DEST}")


def apply() -> None:
    text = TARGET.read_text(encoding="utf-8")
    changed = False
    if MARKER not in text or "from './agent-api.js'" not in text:
        if INSERT_ANCHOR not in text:
            raise SystemExit("tools.js qq_napcat_api anchor changed (plugin version mismatch)")
        if IMPORT_ANCHOR not in text:
            raise SystemExit("tools.js vision import anchor changed (plugin version mismatch)")
        if not BACKUP.exists():
            shutil.copy2(TARGET, BACKUP)
        text = text.replace(IMPORT_ANCHOR, IMPORT_NEW, 1)
        text = text.replace(INSERT_ANCHOR, TOOL_BLOCK + INSERT_ANCHOR, 1)
        changed = True
    # Refresh only the approval branch, preserving unrelated tool edits.
    if "executeFriendApproval" not in text:
        text = text.replace('classifyAgentAction, isAdminTurn, summarizeAgentParams, writeAgentAudit,',
                            'classifyAgentAction, isAdminTurn, summarizeAgentParams, writeAgentAudit, executeFriendApproval,', 1)
        old = '                const value = await bridge.guardedConnectionCall(action, params);'
        new = "                const value = action === 'set_friend_add_request'\n                    ? await executeFriendApproval(bridge, params)\n                    : await bridge.guardedConnectionCall(action, params);"
        if text.count(old) != 1: raise SystemExit('agent approval branch mismatch')
        text = text.replace(old, new, 1)
        text = text.replace('action 参数（JSON 对象）', 'action参数。好友审批用user_id=对方QQ、approve=布尔值；flag只能是申请标识，不能猜；submitted未confirmed不说已加上')
        changed = True
    # Refresh only these two owned tools; retain all later journal/social/media tools.
    text, count = re.subn(r"    // \[dsh-p1\] v2.28 agent tier:.*?name: 'qq_agent_api',.*?\n    \}\)\);\n", lambda _: TOOL_BLOCK, text, flags=re.S)
    if count != 1: raise SystemExit('agent tool refresh mismatch')
    relay_import = "import { companionshipTools, relayText, requireOpportunity } from './companionship.js';"
    if relay_import not in text: text = text.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + '\n' + relay_import, 1)
    changed = text != TARGET.read_text(encoding='utf-8')
    if changed:
        TARGET.write_text(text, encoding="utf-8", newline="\r\n" if b"\r\n" in TARGET.read_bytes() else "\n")
        print(f"patched {TARGET} (backup: {BACKUP.name})")
    else:
        print("tools.js already patched")
    install_module()


def check() -> int:
    text = TARGET.read_text(encoding="utf-8")
    ok = MARKER in text and "from './agent-api.js'" in text and "await executeFriendApproval(bridge, params)" in text
    if ok:
        ok = DEST.exists() and DEST.read_text(encoding="utf-8") == SRC.read_text(encoding="utf-8")
    print("patched" if ok else "NOT patched")
    return 0 if ok else 1


def revert() -> None:
    if BACKUP.exists():
        TARGET.write_text(BACKUP.read_text(encoding="utf-8"), encoding="utf-8")
        BACKUP.unlink()
        print("tools.js restored from backup")
    else:
        print("no tools.js backup; nothing reverted")
    if DEST.exists():
        DEST.unlink()
        print("agent-api.js removed")


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check())
    elif "--revert" in sys.argv:
        revert()
    else:
        apply()
