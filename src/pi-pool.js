import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getPackageDir, RpcClient } from '@earendil-works/pi-coding-agent';

/**
 * RpcClient 的 cliPath 默认是相对路径 "dist/cli.js"，而它 spawn 子进程时
 * 把 cwd 设成 agent 的工作目录 —— 相对路径必然解析失败。所以必须给绝对路径。
 */
const CLI_PATH = path.join(getPackageDir(), 'dist', 'cli.js');

/**
 * launchd / systemd 启动服务时，PATH 通常只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * 里面没有 Homebrew 装的 node。而 pi 的 RpcClient 内部是用【裸命令】
 * spawn("node", ...) 起子进程的 —— 所以会报 `spawn node ENOENT`。
 *
 * 这里把当前 node 所在目录补进 PATH，保证子进程能被找到。
 */
function ensureNodeOnPath() {
  const nodeDir = path.dirname(process.execPath);
  const parts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!parts.includes(nodeDir)) {
    process.env.PATH = [nodeDir, ...parts].join(path.delimiter);
  }
}
ensureNodeOnPath();

/**
 * 桥专属的系统提示词。用 --append-system-prompt 注入，
 * 所以只影响桥启动的 pi，不影响用户在终端里跑的 pi。
 */
const BRIDGE_PROMPT = path.join(os.homedir(), 'pi-feishu', 'BRIDGE_PROMPT.md');

/**
 * pi 会把「当前会话元数据」注入给它自己启动的 shell 工具。
 * 如果本进程是从另一个 pi 里启动的，这些值会串味，所以显式清掉。
 * 注意只清会话元数据，不清 PI_CODING_AGENT_DIR 这类配置项。
 */
const STRIP_ENV = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
];

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIP_ENV.includes(key)) env[key] = value;
  }
  return env;
}

const log = (...args) => console.log('[pi]', ...args);
const warn = (...args) => console.warn('[pi]', ...args);

/**
 * 每个飞书会话持有一个常驻的 pi RPC 子进程。
 * 空闲超过 idleMs 就回收，下次用时再拉起来（会话内容不会丢，因为存在 jsonl 里）。
 */
export class PiPool {
  #entries = new Map();

  constructor({ store, cwd, model = null, thinking = null, idleMs = 15 * 60 * 1000 }) {
    this.store = store;
    this.cwd = cwd;
    this.model = model;
    this.thinking = thinking;
    this.idleMs = idleMs;
  }

  /** 拿到（必要时创建）该会话的 pi 进程 */
  async acquire(chatId) {
    const record = this.store.get(chatId);
    const cwd = record.cwd || this.cwd;

    let entry = this.#entries.get(chatId);
    if (entry && entry.cwd !== cwd) {
      await this.dispose(chatId);
      entry = null;
    }

    if (!entry) {
      const args = [];
      if (record.sessionFile) args.push('--session', record.sessionFile);
      if (fs.existsSync(BRIDGE_PROMPT)) args.push('--append-system-prompt', BRIDGE_PROMPT);

      const client = new RpcClient({
        cliPath: CLI_PATH,
        cwd,
        env: cleanEnv(),
        model: record.model || this.model || undefined,
        args,
      });

      await client.start();
      log(`已为 ${chatId} 启动 pi (cwd=${cwd})`);

      entry = { client, cwd, sessionFile: record.sessionFile ?? null };
      this.#entries.set(chatId, entry);

      // 首次启动时 pi 会新建会话文件，记下来以便重启后接回同一会话
      const state = await client.getState().catch(() => null);
      if (state?.sessionFile && state.sessionFile !== entry.sessionFile) {
        entry.sessionFile = state.sessionFile;
        this.store.set(chatId, { sessionFile: state.sessionFile, cwd });
      }

      const level = record.thinking || this.thinking;
      if (level) {
        await client
          .setThinkingLevel(level)
          .catch((err) => warn('设置思考等级失败:', err.message));
      }
    }

    this.#touch(chatId, entry);
    return entry;
  }

  /** 开新会话（/new） */
  async reset(chatId) {
    const entry = await this.acquire(chatId);
    const result = await entry.client.newSession();
    if (result?.cancelled) return false;
    const state = await entry.client.getState().catch(() => null);
    entry.sessionFile = state?.sessionFile ?? null;
    this.store.set(chatId, { sessionFile: entry.sessionFile, cwd: entry.cwd });
    return true;
  }

  /** 切换工作目录：下次 acquire 时会重建进程 */
  async setCwd(chatId, cwd) {
    await this.dispose(chatId);
    this.store.set(chatId, { cwd, sessionFile: null });
  }

  async dispose(chatId) {
    const entry = this.#entries.get(chatId);
    if (!entry) return;
    this.#entries.delete(chatId);
    clearTimeout(entry.timer);
    await entry.client.stop().catch((err) => warn('停止进程失败:', err.message));
  }

  async close() {
    await Promise.all([...this.#entries.keys()].map((chatId) => this.dispose(chatId)));
  }

  #touch(chatId, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.dispose(chatId).catch(() => {}),
      this.idleMs,
    );
    // 不要让待回收的定时器吊住进程
    entry.timer.unref?.();
  }
}
