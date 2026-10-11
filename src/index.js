import { Client, createLarkChannel, LoggerLevel } from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';

// 先加载 pi-pool：它会把 node 所在目录补进 PATH（launchd/systemd 下 PATH 很精简）
import { PiPool } from './pi-pool.js';

import { runTurn } from './bridge.js';
import { createCommandHandler } from './commands.js';
import { loadConfig } from './config.js';
import { PollingInbox } from './polling.js';
import { Scheduler } from './scheduler.js';
import { ChatStore, createSerializer } from './store.js';

/**
 * 守护进程不该因为某个未处理的异常就整个挂掉。
 * 不装这两个处理器的话，哪怕只是子进程启动失败，
 * 也会让 Node 以退出码 1 结束，然后被 launchd 反复重启。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason?.stack ?? reason);
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err?.stack ?? err);
});

const MAX_IMAGES = 4;

/** 把飞书消息里的图片转成 pi 的 ImageContent */
async function collectImages(channel, msg) {
  const images = (msg.resources ?? []).filter((r) => r.type === 'image').slice(0, MAX_IMAGES);
  const out = [];
  for (const res of images) {
    try {
      const buf = await channel.downloadResource(res.fileKey, 'image');
      out.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
    } catch (err) {
      console.warn('[media] 图片下载失败:', err.message);
    }
  }
  return out;
}

/**
 * 启动时发一条上线通知。
 * 注意：机器人不能主动发起私聊（飞书返回 230101），所以通知发到已监控的群里。
 */
async function announceStartup({ channel, inbox, config }) {
  const chats = inbox.listChats();
  if (chats.length === 0) {
    console.log('[boot] 还没有任何可用的会话。把机器人拉进一个群，或先私聊它一条消息。');
    return;
  }
  for (const { chatId } of chats) {
    try {
      await channel.send(chatId, {
        markdown:
          '✅ **pi-feishu 已上线**\n\n' +
          '直接发消息就是和电脑上的 pi 对话，`/help` 看命令。\n\n' +
          `工作目录：\`${config.cwd}\``,
      });
    } catch (err) {
      console.warn(`[boot] 给 ${chatId} 发上线通知失败:`, err?.message ?? err);
    }
  }
}

async function main() {
  const config = loadConfig();

  for (const warning of config.warnings) console.warn(warning);
  if (config.errors.length > 0) {
    for (const error of config.errors) console.error(`✖ ${error}`);
    console.error('\n请参考 .env.example 配好 .env 后重试。');
    process.exit(1);
  }

  const store = new ChatStore();

  // agent 的工作目录必须先存在，否则 spawn pi 子进程会直接 ENOENT
  fs.mkdirSync(config.cwd, { recursive: true });

  const pool = new PiPool({
    store,
    cwd: config.cwd,
    model: config.model,
    thinking: config.thinking,
    idleMs: config.idleMs,
  });
  const serialize = createSerializer();

  // 飞书 SDK 的底层 client：出站发消息、下载图片、轮询读消息都用它
  const client = new Client({ appId: config.appId, appSecret: config.appSecret });

  // 高层 channel：只为了 send / stream（流式打字机卡片）和 downloadResource
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: LoggerLevel.info,
    policy: {
      dmMode: config.dmMode,
      dmAllowlist: config.dmAllowlist,
      groupAllowlist: config.groupAllowlist,
      requireMention: config.requireMention,
      respondToMentionAll: config.respondToMentionAll,
    },
    safety: { chatQueue: { enabled: false } },
    outbound: { streamInitialText: '🤔 思考中…', streamMaxElementChars: 30000 },
  });

  // 定时任务：每分钟检查一次「上次检查到现在」有没有该跑的任务。
  // MacBook 睡了也不怕 —— 醒来自动补跑最近那一次。
  // ⚠️ 必须在 createCommandHandler 之前定义：/tasks 命令要用到它，
  //    而 const 在声明前访问会抛 ReferenceError（TDZ）。
  const scheduler = new Scheduler({
    pool,
    channel,
    store,
    maxTurnMs: config.maxTurnMs,
  });

  const handleCommand = createCommandHandler({ channel, pool, config, store, scheduler });

  async function handleMessage(msg) {
    const preview = (msg.content ?? '').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`[msg] ${msg.chatType} ${msg.senderId}: ${preview}`);

    try {
      if (await handleCommand(msg)) return;

      if (!msg.content?.trim() && (msg.resources ?? []).length === 0) {
        await channel.send(msg.chatId, { text: '（空消息）' }, { replyTo: msg.messageId });
        return;
      }

      await serialize(msg.chatId, async () => {
        const { client: pi } = await pool.acquire(msg.chatId);
        const images = await collectImages(channel, msg);
        await channel.stream(
          msg.chatId,
          {
            markdown: async (s) => {
              const turn = runTurn(pi, {
                text: msg.content || '（我发了一张图片，没有文字）',
                images: images.length > 0 ? images : undefined,
                maxTurnMs: config.maxTurnMs,
              });
              for await (const chunk of turn) await s.append(chunk);
            },
          },
          { replyTo: msg.messageId },
        );
      });
    } catch (err) {
      console.error('[msg] 处理失败:', err);
      await channel
        .send(msg.chatId, { text: `❌ ${err?.message ?? err}` }, { replyTo: msg.messageId })
        .catch(() => {});
      await pool.dispose(msg.chatId).catch(() => {});
    }
  }

  // ── 入站：两种传输方式 ───────────────────────────────────────
  const allowSender = (senderId) =>
    config.dmMode === 'open' || config.dmAllowlist.includes(senderId);
  const allowChat = (chatId) =>
    config.groupAllowlist.length === 0 || config.groupAllowlist.includes(chatId);

  let inbox = null;

  channel.on('error', (err) => console.error('[入站错误]', err?.message ?? err));
  channel.on('reconnecting', () => console.warn('[飞书] 断线，重连中…'));
  channel.on('reconnected', () => console.log('[飞书] 已重连'));

  await channel.connect();
  console.log(`✅ 已连接飞书，机器人：${channel.botIdentity?.name ?? '(未知)'}`);

  if (config.transport === 'poll') {
    // inbox 必须在 connect() 之后建，因为要用 botIdentity 判断 @
    inbox = new PollingInbox({
      client,
      onMessage: handleMessage,
      allowSender,
      allowChat,
      extraChatIds: config.extraChatIds,
      intervalMs: config.pollMs,
      startTimeMs: Date.now(),
      bot: channel.botIdentity,
      requireMention: config.requireMention,
    });
    await inbox.start();
  } else {
    // 事件推送模式：由 SDK 的 policy 层做鉴权
    channel.on('message', handleMessage);
    channel.on('reject', (event) => {
      const { reason, senderId, chatId } = event ?? {};
      console.log(`[拒绝] reason=${reason} sender=${senderId} chat=${chatId}`);
      if (reason === 'sender_not_allowed') {
        console.log(
          `\n┌─ 未授权的发送者 ─────────────────────\n` +
            `│ senderId : ${senderId}\n│ chatId   : ${chatId}\n` +
            `│ 放行请写入 .env: PI_FEISHU_DM_ALLOWLIST=${senderId}\n` +
            `└──────────────────────────────────────\n`,
        );
      }
    });
  }

  if (inbox && config.notifyOnStart) await announceStartup({ channel, inbox, config });

  scheduler.start();

  console.log(`   工作目录：${config.cwd}`);
  console.log(`   入站方式：${config.transport === 'poll' ? `轮询 (${config.pollMs}ms)` : '事件推送'}`);
  console.log(`   群内@触发：${config.requireMention ? '需要' : '不需要'}`);
  console.log(`   私聊策略：${config.dmMode}${config.dmAllowlist.length ? ` (${config.dmAllowlist.length} 个白名单)` : ''}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在退出…`);
    scheduler.stop();
    await Promise.allSettled([inbox?.stop(), channel.disconnect(), pool.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
