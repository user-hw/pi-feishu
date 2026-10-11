/**
 * 桥自带命令。用 `/` 前缀；没被这里接住的斜杠命令会原样交给 pi
 * （所以 /compact、自定义扩展命令这些仍然可用）。
 */

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const HELP = [
  '**pi-feishu** — 把电脑上的 pi 接到飞书',
  '',
  '直接发消息就是和 pi 对话：回复流式输出，工具调用实时可见。',
  '',
  '| 命令 | 说明 |',
  '| --- | --- |',
  '| `/new` | 开一个新会话 |',
  '| `/status` | 当前模型 / 会话 / 目录 |',
  '| `/model` | 列出可用模型 |',
  '| `/model <provider/id>` | 切换模型 |',
  '| `/thinking` | 查看 / 设置思考等级 |',
  '| `/cwd` | 查看工作目录 |',
  '| `/cwd <绝对路径>` | 切换工作目录（会开新会话） |',
  '| `/abort` | 中止当前任务 |',
  '| `/whoami` | 显示你的 open_id 和 chat_id |',
  '| `/help` | 显示这份帮助 |',
].join('\n');

export function createCommandHandler({ channel, pool, config, store }) {
  const reply = (msg, markdown) =>
    channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId });

  return async function handleCommand(msg) {
    const text = (msg.content ?? '').trim();
    if (!text.startsWith('/')) return false;

    const [rawName, ...rest] = text.slice(1).split(/\s+/);
    const name = (rawName ?? '').toLowerCase();
    const arg = rest.join(' ').trim();

    switch (name) {
      case 'help':
        await reply(msg, HELP);
        return true;

      case 'whoami':
        await reply(
          msg,
          [
            '```',
            `senderId : ${msg.senderId}`,
            `chatId   : ${msg.chatId}`,
            `chatType : ${msg.chatType}`,
            '```',
            '把 `senderId` 填进 `PI_FEISHU_DM_ALLOWLIST`，把 `chatId` 填进 `PI_FEISHU_GROUP_ALLOWLIST`。',
          ].join('\n'),
        );
        return true;

      case 'new': {
        const ok = await pool.reset(msg.chatId);
        await reply(msg, ok ? '🆕 已开新会话' : '⚠️ 新会话被扩展取消了');
        return true;
      }

      case 'abort': {
        const entry = await pool.acquire(msg.chatId);
        await entry.client.abort();
        await reply(msg, '🛑 已中止');
        return true;
      }

      case 'status': {
        const entry = await pool.acquire(msg.chatId);
        const state = await entry.client.getState().catch(() => null);
        if (!state) {
          await reply(msg, '⚠️ 拿不到状态，pi 进程可能已退出');
          return true;
        }
        const model = state.model;
        await reply(
          msg,
          [
            `- 模型：\`${model ? `${model.provider ?? ''}/${model.id ?? model.modelId ?? '?'}` : '未知'}\``,
            `- 思考：\`${state.thinkingLevel}\``,
            `- 运行中：${state.isStreaming ? '是' : '否'}`,
            `- 消息数：${state.messageCount}${state.pendingMessageCount ? `（排队 ${state.pendingMessageCount}）` : ''}`,
            `- 工作目录：\`${entry.cwd}\``,
            `- 会话文件：\`${state.sessionFile ?? '(临时会话)'}\``,
          ].join('\n'),
        );
        return true;
      }

      case 'model': {
        const entry = await pool.acquire(msg.chatId);
        if (arg) {
          const slash = arg.indexOf('/');
          if (slash < 0) {
            await reply(msg, '用法：`/model <provider/id>`，例如 `/model deepseek/deepseek-chat`');
            return true;
          }
          const provider = arg.slice(0, slash);
          const id = arg.slice(slash + 1);
          const applied = await entry.client.setModel(provider, id);
          store.set(msg.chatId, { model: `${applied.provider}/${applied.id}` });
          await reply(msg, `✅ 已切到 \`${applied.provider}/${applied.id}\``);
          return true;
        }
        const models = await entry.client.getAvailableModels();
        const byProvider = new Map();
        for (const m of models) {
          if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
          byProvider.get(m.provider).push(m);
        }
        const lines = [`共 ${models.length} 个模型：`];
        let shown = 0;
        for (const [provider, list] of byProvider) {
          if (shown >= 40) {
            lines.push(`… 还有更多，用 \`/model <provider>/<id>\` 直接指定`);
            break;
          }
          lines.push(`\n**${provider}**`);
          for (const m of list) {
            if (shown >= 40) break;
            lines.push(`- \`${provider}/${m.id}\`${m.reasoning ? ' 🧠' : ''}`);
            shown += 1;
          }
        }
        await reply(msg, lines.join('\n'));
        return true;
      }

      case 'thinking': {
        const entry = await pool.acquire(msg.chatId);
        if (!arg) {
          const state = await entry.client.getState();
          const available = await entry.client.getAvailableThinkingLevels().catch(() => THINKING_LEVELS);
          await reply(
            msg,
            `当前：\`${state.thinkingLevel}\`\n可用：${available.map((l) => `\`${l}\``).join(' ')}\n\n用 \`/thinking <level>\` 切换。`,
          );
          return true;
        }
        if (!THINKING_LEVELS.includes(arg)) {
          await reply(msg, `未知等级 \`${arg}\`。可用：${THINKING_LEVELS.join(' / ')}`);
          return true;
        }
        await entry.client.setThinkingLevel(arg);
        store.set(msg.chatId, { thinking: arg });
        await reply(msg, `✅ 思考等级：\`${arg}\``);
        return true;
      }

      case 'cwd': {
        const record = store.get(msg.chatId);
        if (!arg) {
          await reply(msg, `当前工作目录：\`${record.cwd || config.cwd}\`\n\n用 \`/cwd /绝对/路径\` 切换（会开新会话）。`);
          return true;
        }
        if (!arg.startsWith('/')) {
          await reply(msg, '请给绝对路径，例如 `/cwd /Users/you/projects/demo`');
          return true;
        }
        await pool.setCwd(msg.chatId, arg);
        await reply(msg, `✅ 工作目录已切到 \`${arg}\`，并开了新会话。`);
        return true;
      }

      default:
        // 不是我们的命令：交给 pi 自己处理（/compact、扩展命令等）
        return false;
    }
  };
}
