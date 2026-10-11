/**
 * 轮询收件箱 —— 不依赖飞书事件推送的入站方案。
 *
 * 背景：这台机器上飞书的长连接能建立、能收发 pong，但一个事件都推不过来
 * （权限已确认全部生效，客户端也不存在"订阅"动作，订阅纯由后台决定）。
 * 好在 im.v1.message.list 可以正常读消息，所以改用轮询。
 *
 * 出站仍然走 createLarkChannel（它只是 API 调用，不受事件影响），
 * 这样流式打字机卡片能继续用。
 */

const POLL_PAGE_SIZE = 20;

const MENTION_PLACEHOLDER = /@_user_\d+/g;

/** 从 message.list 的一条记录里抽出可读文本 + 是否 @ 了机器人 */
function extractContent(msg, bot) {
  const type = msg.msg_type;
  let body = {};
  try {
    body = JSON.parse(msg.body?.content ?? '{}');
  } catch {
    /* 忽略解析失败的 body */
  }

  const isBotMention = (mention) =>
    Boolean(bot?.openId) && mention.id === bot.openId;

  const mentionedBot = (msg.mentions ?? []).some(isBotMention);

  const renderMentions = (text) => {
    let out = text;
    for (const mention of msg.mentions ?? []) {
      if (!mention.key) continue;
      // 机器人自己的 @ 是噪音，抹掉；别人的保留名字
      const replacement = isBotMention(mention) ? '' : mention.name ? `@${mention.name}` : '';
      out = out.split(mention.key).join(replacement);
    }
    return out.replace(MENTION_PLACEHOLDER, '').replace(/@_all/g, '@所有人').trim();
  };

  const text = (() => {
    switch (type) {
      case 'text':
        return renderMentions(body.text ?? '');

      case 'post': {
        // 富文本：把所有 node 的 text 抽出来
        const parts = [];
        const walk = (node) => {
          if (Array.isArray(node)) return node.forEach(walk);
          if (!node || typeof node !== 'object') return;
          if (node.tag === 'text' && typeof node.text === 'string') parts.push(node.text);
          if (node.tag === 'a' && typeof node.text === 'string')
            parts.push(`${node.text}(${node.href ?? ''})`);
          if (node.tag === 'at') parts.push(`@${node.user_name ?? node.user_id ?? ''}`);
          if (node.tag === 'img') parts.push('[图片]');
          for (const key of ['content', 'elements', 'title']) if (node[key]) walk(node[key]);
        };
        walk(body);
        return renderMentions(parts.join(' '));
      }

      case 'image':
        return '';
      case 'file':
        return `[文件] ${body.file_name ?? ''}`.trim();
      case 'audio':
        return '[语音]';
      case 'media':
        return '[视频]';
      case 'sticker':
        return '[表情]';
      default:
        return `[${type}]`;
    }
  })();

  return { text, mentionedBot };
}

/** 把消息里的图片抽成和 NormalizedMessage.resources 一样的形状 */
function extractResources(msg) {
  let body = {};
  try {
    body = JSON.parse(msg.body?.content ?? '{}');
  } catch {
    /* ignore */
  }
  if (msg.msg_type === 'image' && body.image_key) {
    return [{ type: 'image', fileKey: body.image_key }];
  }
  return [];
}

export class PollingInbox {
  #seen = new Set();
  #seenOrder = [];
  #chats = new Map(); // chatId -> 'p2p' | 'group'
  #known = new Set(); // 已经"开张"过的 chat，首次拉取只做基线不派发
  #timer = null;
  #cycle = 0;
  #running = false;
  #tickInFlight = false;

  constructor({
    client,
    onMessage,
    allowSender = () => true,
    allowChat = () => true,
    extraChatIds = [],
    intervalMs = 3000,
    startTimeMs = Date.now(),
    chatRefreshCycles = 5,
    bot = null,
    requireMention = false,
    logger = console,
  }) {
    this.client = client;
    this.onMessage = onMessage;
    this.allowSender = allowSender;
    this.allowChat = allowChat;
    this.extraChatIds = extraChatIds;
    this.intervalMs = intervalMs;
    this.startTimeMs = startTimeMs;
    this.chatRefreshCycles = chatRefreshCycles;
    this.bot = bot;
    this.requireMention = requireMention;
    this.logger = logger;

    for (const chatId of extraChatIds) this.#chats.set(chatId, 'group');
  }

  async start() {
    this.#running = true;
    await this.#refreshChats();
    this.#timer = setInterval(() => {
      this.#tick().catch((err) => this.logger.error('[poll] tick 失败:', err.message));
    }, this.intervalMs);
    this.#timer.unref?.();
    this.logger.log(
      `[poll] 轮询已启动：每 ${this.intervalMs}ms，监控 ${this.#chats.size} 个会话`,
    );
  }

  async stop() {
    this.#running = false;
    clearInterval(this.#timer);
  }

  /** 机器人所在的群 + 显式配置的 chat_id */
  async #refreshChats() {
    try {
      const res = await this.client.im.v1.chat.list({ params: { page_size: 100 } });
      for (const chat of res?.data?.items ?? []) {
        if (!this.allowChat(chat.chat_id)) continue;
        if (!this.#chats.has(chat.chat_id)) {
          this.#chats.set(chat.chat_id, chat.chat_mode === 'p2p' ? 'p2p' : 'group');
          this.logger.log(`[poll] 发现新会话 ${chat.chat_id} (${chat.name || chat.chat_mode})`);
        }
      }
    } catch (err) {
      this.logger.error('[poll] 拉取会话列表失败:', err?.response?.data?.msg ?? err.message);
    }
  }

  /** 主动把一个 chat 加入监控（例如刚给某人发了私聊，拿到了 chat_id） */
  watch(chatId, mode = 'group') {
    if (!this.#chats.has(chatId)) {
      this.#chats.set(chatId, mode);
      this.logger.log(`[poll] 开始监控 ${chatId} (${mode})`);
    }
  }

  /** 当前监控的会话列表 */
  listChats() {
    return [...this.#chats.entries()].map(([chatId, mode]) => ({ chatId, mode }));
  }

  #markSeen(messageId) {
    if (this.#seen.has(messageId)) return;
    this.#seen.add(messageId);
    this.#seenOrder.push(messageId);
    if (this.#seenOrder.length > 800) {
      this.#seen.delete(this.#seenOrder.shift());
    }
  }

  async #tick() {
    if (!this.#running || this.#tickInFlight) return;
    this.#tickInFlight = true;
    try {
      this.#cycle += 1;
      if (this.#cycle % this.chatRefreshCycles === 0) await this.#refreshChats();

      for (const [chatId, mode] of this.#chats) {
        let res;
        try {
          res = await this.client.im.v1.message.list({
            params: {
              container_id_type: 'chat',
              container_id: chatId,
              page_size: POLL_PAGE_SIZE,
              sort_type: 'ByCreateTimeDesc',
            },
          });
        } catch (err) {
          const code = err?.response?.data?.code;
          // 机器人被移出群之类的情况，别刷屏
          if (code !== 230002 && code !== 230013) {
            this.logger.error(
              `[poll] 读 ${chatId} 失败: ${err?.response?.data?.msg ?? err.message}`,
            );
          }
          continue;
        }

        const items = res?.data?.items ?? [];
        const fresh = [];

        for (const msg of items) {
          if (this.#seen.has(msg.message_id)) continue;
          this.#markSeen(msg.message_id);

          // 首次见到这个会话：把历史消息全部标记为已读，不回复
          if (!this.#known.has(chatId)) continue;

          // 只处理启动之后的消息
          const created = Number(msg.create_time ?? 0);
          if (created && created < this.startTimeMs) continue;

          // 跳过机器人自己发的
          if (msg.sender?.sender_type === 'app') continue;

          fresh.push(msg);
        }

        if (!this.#known.has(chatId)) {
          this.#known.add(chatId);
          if (items.length > 0) {
            this.logger.log(`[poll] ${chatId} 建立基线，忽略 ${items.length} 条历史消息`);
          }
          continue;
        }

        // 按时间正序派发
        fresh.sort((a, b) => Number(a.create_time) - Number(b.create_time));

        for (const msg of fresh) {
          const senderId = msg.sender?.id;
          if (!this.allowSender(senderId, chatId, mode)) {
            this.logger.log(`[poll] 拒绝 ${senderId} 在 ${chatId} 的消息（不在白名单）`);
            continue;
          }

          const content = extractContent(msg, this.bot);
          const resources = extractResources(msg);
          if (!content.text && resources.length === 0) continue;

          // 群聊里按需要求 @机器人（单人小群可以关掉）
          if (mode === 'group' && this.requireMention && !content.mentionedBot) continue;

          try {
            await this.onMessage({
              messageId: msg.message_id,
              chatId,
              chatType: mode,
              senderId,
              senderName: undefined,
              content: content.text,
              mentionedBot: content.mentionedBot,
              resources,
              createTime: Number(msg.create_time ?? Date.now()),
              raw: msg,
            });
          } catch (err) {
            this.logger.error('[poll] 处理消息失败:', err);
          }
        }
      }
    } finally {
      this.#tickInFlight = false;
    }
  }
}
