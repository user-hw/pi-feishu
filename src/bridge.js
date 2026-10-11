/**
 * pi RPC 事件流 -> 飞书卡片 markdown 增量。
 *
 * 飞书 SDK 的 channel.stream() 需要一个「生产者」：一个 async 函数，
 * 往 controller 里 append 增量文本。这里把 pi 的事件回调桥接成一个
 * async generator，正好对得上。
 */

/** 简单的异步队列：push 端是事件回调，消费端是 async iterator */
export class AsyncQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  push(value) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#items.push(value);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next() {
    if (this.#items.length > 0) {
      return Promise.resolve({ value: this.#items.shift(), done: false });
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

const quote = (line) => `\n\n> ${line}\n\n`;

const oneLine = (value, max = 140) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const formatDuration = (ms) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
};

/** 把工具调用渲染成一行有意义的话，特别是 bash 要能看到真实命令 */
function describeTool(toolName, args = {}) {
  switch (toolName) {
    case 'bash':
    case 'powershell':
      return `bash: \`${oneLine(args.command)}\``;
    case 'read':
    case 'write':
    case 'edit':
      return `${toolName}: \`${oneLine(args.path ?? args.file_path)}\``;
    case 'grep':
      return `grep: \`${oneLine(args.pattern)}\`${args.path ? ` in \`${oneLine(args.path, 60)}\`` : ''}`;
    case 'find':
    case 'ls':
      return `${toolName}: \`${oneLine(args.path ?? args.pattern ?? '.', 80)}\``;
    default:
      return toolName;
  }
}

/** 工具跑得够久就定期喊一声，避免手机上干等 */
const TOOL_PING_MS = 60_000;

/**
 * 跑一轮 agent，把输出流出来。
 * @returns async generator<string>
 */
export async function* runTurn(client, { text, images, maxTurnMs, withFooter = true }) {
  const queue = new AsyncQueue();
  let thinkingAnnounced = false;
  let latestUsage = null;
  let sawAnything = false;
  let firstChunk = true;
  let timedOut = false;
  let currentTool = null;

  const stopToolWatch = () => {
    if (currentTool?.timer) clearInterval(currentTool.timer);
    currentTool = null;
  };

  // 卡片首个字符是换行会留一个难看的空行，首块单独去掉前导空白
  const emit = (chunk) => {
    const text = firstChunk ? chunk.replace(/^\s+/, '') : chunk;
    if (!text) return;
    firstChunk = false;
    queue.push(text);
  };

  const unsubscribe = client.onEvent((event) => {
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent;
        // usage 是累计值，取最大值而非最后一个，避免拿到中间态
        if (event.usage && (event.usage.output ?? 0) >= (latestUsage?.output ?? 0)) {
          latestUsage = event.usage;
        }
        if (!delta) break;

        if (delta.type === 'text_delta' && delta.delta) {
          sawAnything = true;
          emit(delta.delta);
        } else if (delta.type === 'thinking_delta' && !thinkingAnnounced) {
          // 只报一次状态，不把思考全文刷到卡片上
          thinkingAnnounced = true;
          emit(quote('🤔 思考中…'));
        }
        break;
      }

      // 工具开始执行：这一条才是有效信息，能看到真实命令
      case 'tool_execution_start': {
        sawAnything = true;
        stopToolWatch();
        currentTool = { name: event.toolName, startedAt: Date.now() };
        emit(quote(`⚙️ ${describeTool(event.toolName, event.args)}`));
        currentTool.timer = setInterval(() => {
          if (!currentTool) return;
          emit(quote(`⏳ ${currentTool.name} 仍在运行… ${formatDuration(Date.now() - currentTool.startedAt)}`));
        }, TOOL_PING_MS);
        currentTool.timer.unref?.();
        break;
      }

      // 工具结束：耗时超过 3 秒才报，避免刷屏
      case 'tool_execution_end': {
        if (!currentTool) break;
        const elapsed = Date.now() - currentTool.startedAt;
        const name = currentTool.name;
        stopToolWatch();
        if (elapsed > 3000) {
          emit(quote(`${event.isError ? '❌' : '✅'} ${name} 完成 (${formatDuration(elapsed)})`));
        }
        break;
      }

      case 'compaction_start':
        emit(quote('🗜️ 正在压缩上下文…'));
        break;

      case 'auto_retry_start':
        emit(quote('🔄 请求失败，自动重试中…'));
        break;

      case 'extension_error':
        emit(quote(`⚠️ 扩展出错：${event.error?.message ?? 'unknown'}`));
        break;

      case 'agent_settled':
        // 彻底跑完（含重试、压缩、排队消息），可以收尾了
        queue.close();
        break;

      default:
        break;
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    emit(quote('⏱️ 超过单轮时间上限，已中止'));
    client.abort?.().catch(() => {});
    queue.close();
  }, maxTurnMs);

  try {
    const state = await client.getState();
    if (state.isStreaming) {
      // 上一轮还在跑：注入指令而不是报错
      await client.steer(text, images);
    } else {
      await client.prompt(text, images);
    }

    for await (const chunk of queue) yield chunk;

    if (withFooter && sawAnything && !timedOut && latestUsage) {
      const model = (await client.getState().catch(() => null))?.model;
      const label = model?.id ?? model?.modelId ?? 'pi';
      const output = latestUsage.output ?? 0;
      yield `\n\n---\n<font color='grey'>${label} · ${output} tokens</font>`;    }
  } finally {
    clearTimeout(timer);
    stopToolWatch();
    unsubscribe();
    queue.close();
  }
}
