import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from './config.js';

/**
 * 每个飞书会话(chatId) -> { sessionFile, cwd, name }
 * 写成 JSON，重启后能接回同一个 pi 会话。
 */
export class ChatStore {
  constructor(file = path.join(STATE_DIR, 'chats.json')) {
    this.file = file;
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[store] 读取 ${this.file} 失败，从空状态开始:`, err.message);
      }
      return {};
    }
  }

  get(chatId) {
    return this.data[chatId] ?? {};
  }

  set(chatId, patch) {
    this.data[chatId] = { ...this.get(chatId), ...patch };
    this.#save();
    return this.data[chatId];
  }

  remove(chatId) {
    delete this.data[chatId];
    this.#save();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 写入失败:', err.message);
    }
  }
}

/** 防抖落盘用不上的简单互斥：保证同一 chatId 的 agent 轮次串行 */
export function createSerializer() {
  const chains = new Map();
  return function serialize(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 让链条不因为某次失败而断掉
    chains.set(
      key,
      next.catch(() => {}),
    );
    // 链空闲后清理，避免 Map 无限增长
    next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };
}
