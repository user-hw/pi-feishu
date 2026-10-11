import os from 'node:os';
import path from 'node:path';

/** 状态目录：会话映射、配对码等 */
export const STATE_DIR =
  process.env.PI_FEISHU_STATE_DIR || path.join(os.homedir(), '.pi-feishu');

const bool = (v, dflt) =>
  v === undefined || v === '' ? dflt : !['0', 'false', 'no'].includes(String(v).toLowerCase());

const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const int = (v, dflt) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** 把 ~ 展开成家目录，再转成绝对路径 */
const resolvePath = (value) => {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
};

export function loadConfig() {
  const errors = [];
  const warnings = [];

  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId) errors.push('缺少 FEISHU_APP_ID');
  if (!appSecret) errors.push('缺少 FEISHU_APP_SECRET');

  const dmMode = process.env.PI_FEISHU_DM_MODE?.trim() || 'allowlist';
  if (!['allowlist', 'pair', 'open', 'disabled'].includes(dmMode)) {
    errors.push(`PI_FEISHU_DM_MODE 取值非法: ${dmMode}`);
  }

  const dmAllowlist = list(process.env.PI_FEISHU_DM_ALLOWLIST);
  const groupAllowlist = list(process.env.PI_FEISHU_GROUP_ALLOWLIST);

  if (dmMode === 'open') {
    warnings.push(
      '⚠️  PI_FEISHU_DM_MODE=open：任何能私聊到这个机器人的人都能在你电脑上执行命令。',
    );
  }
  if (dmMode === 'allowlist' && dmAllowlist.length === 0) {
    warnings.push(
      'ℹ️  DM 白名单为空：现在没人能私聊。这是首次配置的正常状态 —— ' +
        '在飞书里给机器人发任意一条消息，你的 open_id 会打到日志里，填进 ' +
        'PI_FEISHU_DM_ALLOWLIST 后重启即可。',
    );
  }

  const cwd = process.env.PI_FEISHU_CWD?.trim()
    ? resolvePath(process.env.PI_FEISHU_CWD)
    : path.join(os.homedir(), 'pi-feishu', 'workspace');

  // 入站传输方式：poll（轮询，默认）| events（飞书事件推送）
  const transport = process.env.PI_FEISHU_TRANSPORT?.trim() || 'poll';
  if (!['poll', 'events'].includes(transport)) {
    errors.push(`PI_FEISHU_TRANSPORT 取值非法: ${transport}（只能是 poll 或 events）`);
  }

  const extraChatIds = list(process.env.PI_FEISHU_CHAT_IDS);
  if (transport === 'poll' && groupAllowlist.length === 0 && extraChatIds.length === 0) {
    warnings.push(
      'ℹ️  轮询模式 + 群白名单为空：会自动监控机器人所在的所有群。' +
        '如果你想把机器人拉进公开群，请显式设置 PI_FEISHU_GROUP_ALLOWLIST。',
    );
  }

  if (cwd === os.homedir() || cwd === '/') {
    warnings.push(
      `⚠️  工作目录是 ${cwd}：agent 拥有完整 shell 权限，建议指向一个专用目录。`,
    );
  }

  return {
    appId,
    appSecret,
    dmMode,
    dmAllowlist,
    groupAllowlist,
    requireMention: bool(process.env.PI_FEISHU_REQUIRE_MENTION, true),
    respondToMentionAll: bool(process.env.PI_FEISHU_RESPOND_MENTION_ALL, false),
    cwd,
    transport,
    extraChatIds,
    pollMs: int(process.env.PI_FEISHU_POLL_MS, 3000),
    notifyOnStart: bool(process.env.PI_FEISHU_NOTIFY_ON_START, true),
    model: process.env.PI_FEISHU_MODEL?.trim() || null,
    thinking: process.env.PI_FEISHU_THINKING?.trim() || null,
    idleMs: int(process.env.PI_FEISHU_IDLE_MS, 15 * 60 * 1000),
    maxTurnMs: int(process.env.PI_FEISHU_MAX_TURN_MS, 30 * 60 * 1000),
    errors,
    warnings,
  };
}
