import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTurn } from './bridge.js';
import { describe as describeCron, isValid, mostRecentMatch, nextMatch, parseCron } from './cron.js';

const DEFAULT_TASKS_FILE = path.join(os.homedir(), 'pi-feishu', 'tasks.json');
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.pi-feishu', 'task-state.json');

/** 展开 ~ 前缀 */
const expand = (p) =>
  !p ? p : p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;

/**
 * 定时任务调度器。
 *
 * 设计要点：
 * 1. **每分钟检查，而不是挂一个「到点触发」的定时器。**
 *    笔记本会睡眠，定时器会丢。改成「上次检查到哪了 → 现在」逐分钟回溯，
 *    睡醒/重启后能自动补跑（只补最近一次，不会把错过的全补一遍）。
 * 2. **每一轮都重新读 tasks.json。** 这样 agent 自己用 shell 改这个文件
 *    就能加/改任务，一分钟内生效，不用重启服务。
 * 3. **状态持久化**到 task-state.json，重启不会重复触发。
 */
export class Scheduler {
  #running = new Set();
  #inflight = new Set();
  #timer = null;
  #nextTickLog = 0;

  constructor({
    pool,
    channel,
    store,
    tasksFile = DEFAULT_TASKS_FILE,
    stateFile = DEFAULT_STATE_FILE,
    tickMs = 20_000,
    maxTurnMs = 30 * 60 * 1000,
    logger = console,
  }) {
    this.pool = pool;
    this.channel = channel;
    this.store = store;
    this.tasksFile = tasksFile;
    this.stateFile = stateFile;
    this.tickMs = tickMs;
    this.maxTurnMs = maxTurnMs;
    this.log = logger;

    this.state = this.#loadState();
    this.tasks = [];
    this.problems = [];
  }

  #loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  #saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.error('[tasks] 保存状态失败:', err.message);
    }
  }

  /** 读 tasks.json。文件不存在不算错误（就是没任务） */
  loadTasks() {
    let raw;
    try {
      raw = fs.readFileSync(this.tasksFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.tasks = [];
        this.problems = [];
        return this.tasks;
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.problems = [`tasks.json 不是合法 JSON：${err.message}`];
      this.tasks = [];
      return this.tasks;
    }

    const list = Array.isArray(parsed) ? parsed : (parsed.tasks ?? []);
    const tasks = [];
    const problems = [];

    for (const [index, task] of list.entries()) {
      const id = task.id || `task-${index + 1}`;
      const where = `任务「${task.name || id}」`;

      if (task.enabled === false) continue;

      if (!isValid(task.schedule)) {
        problems.push(`${where}: schedule 无效 → "${task.schedule}"`);
        continue;
      }
      if (!task.chat) {
        problems.push(`${where}: 缺少 chat（目标群的 chat_id）`);
        continue;
      }
      if (!task.prompt && !task.send) {
        problems.push(`${where}: 至少要有一个 prompt 或 send`);
        continue;
      }

      tasks.push({
        id,
        name: task.name || id,
        schedule: task.schedule,
        chat: task.chat,
        prompt: task.prompt ?? null,
        send: task.send ?? null,
        cwd: expand(task.cwd) || null,
        model: task.model ?? null,
        session: task.session === 'chat' ? 'chat' : 'task',
        parsedCron: parseCron(task.schedule),
      });
    }

    this.tasks = tasks;
    this.problems = problems;
    return tasks;
  }

  start() {
    this.loadTasks();
    const fileState = fs.existsSync(this.tasksFile) ? '' : `（文件不存在，这是正常的：${this.tasksFile}）`;
    this.log.log(`[tasks] 已加载 ${this.tasks.length} 个定时任务 ${fileState}`);
    for (const problem of this.problems) this.log.warn(`[tasks] ⚠️ ${problem}`);
    for (const task of this.tasks) {
      this.log.log(`[tasks]   · ${task.name}  ${describeCron(task.schedule)}  → ${task.chat}`);
    }

    this.#timer = setInterval(() => {
      this.tick().catch((err) => this.log.error('[tasks] tick 失败:', err));
    }, this.tickMs);
    this.#timer.unref?.();
  }

  stop() {
    clearInterval(this.#timer);
  }

  /** 立刻检查一次（启动时和定时都会调） */
  async tick(now = new Date()) {
    this.loadTasks();

    for (const task of this.tasks) {
      if (this.#running.has(task.id)) continue;

      const lastIso = this.state[task.id];
      const last = lastIso ? new Date(lastIso) : null;

      if (!last) {
        // 第一次见到这个任务：只记录「检查到此刻」，不补跑历史
        this.state[task.id] = now.toISOString();
        this.#saveState();
        const next = this.nextRunOf(task);
        this.log.log(`[tasks] ${task.name}：首次登记，下次 ${next ? next.toLocaleString() : '未知'}`);
        continue;
      }

      const due = mostRecentDue(task, last, now);
      if (!due) {
        this.state[task.id] = now.toISOString();
        continue;
      }

      const lateMinutes = Math.round((now - due) / 60_000);
      if (lateMinutes > 5) {
        this.log.warn(`[tasks] ${task.name}：错过 ${lateMinutes} 分钟（可能机器睡了），现在补跑一次`);
      }

      this.state[task.id] = now.toISOString();
      this.#saveState();
      const promise = this.#run(task, due).catch((err) =>
        this.log.error(`[tasks] ${task.name} 执行失败:`, err),
      );
      this.#inflight.add(promise);
      promise.finally(() => this.#inflight.delete(promise));
    }
  }

  /** 等到所有在跑的定时任务结束（测试和优雅退出用） */
  async whenIdle() {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
  }

  nextRunOf(task) {
    return nextMatch(task.parsedCron, new Date());
  }

  async #run(task, dueAt) {
    this.#running.add(task.id);
    const started = Date.now();
    this.log.log(`[tasks] ▶ ${task.name}（计划 ${dueAt.toLocaleString()}）`);

    try {
      if (task.send) {
        // 纯文本通知，不过 agent
        await this.channel.send(task.chat, { markdown: task.send });
      } else {
        const entry = await this.#acquireFor(task);
        await this.channel.stream(
          task.chat,
          {
            markdown: async (s) => {
              const turn = runTurn(entry.client, {
                text: task.prompt,
                maxTurnMs: this.maxTurnMs,
              });
              for await (const chunk of turn) await s.append(chunk);
            },
          },
          task.replyTo ? { replyTo: task.replyTo } : undefined,
        );
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.log.log(`[tasks] ✔ ${task.name} 完成 (${secs}s)`);
    } catch (err) {
      this.log.error(`[tasks] ✖ ${task.name} 失败:`, err?.message ?? err);
      await this.channel
        .send(task.chat, { text: `⚠️ 定时任务「${task.name}」执行失败：${err?.message ?? err}` })
        .catch(() => {});
      // 进程可能坏了，丢掉让下次重建
      await this.pool.dispose(this.#poolKey(task)).catch(() => {});
    } finally {
      this.#running.delete(task.id);
    }
  }

  #poolKey(task) {
    return task.session === 'chat' ? task.chat : `task:${task.id}`;
  }

  async #acquireFor(task) {
    const key = this.#poolKey(task);
    if (task.session === 'task' && task.cwd) {
      // 让 pi 子进程用任务指定的工作目录（会顺带加载那个目录的 AGENTS.md 人设）
      const current = this.store.get(key);
      if (current.cwd !== task.cwd) this.store.set(key, { cwd: task.cwd });
    }
    return this.pool.acquire(key);
  }

  /** 给 /tasks 命令用 */
  summary() {
    return this.tasks.map((task) => {
      const next = this.nextRunOf(task);
      const last = this.state[task.id] ? new Date(this.state[task.id]) : null;
      return {
        id: task.id,
        name: task.name,
        schedule: task.schedule,
        human: describeCron(task.schedule),
        chat: task.chat,
        kind: task.send ? 'send' : 'prompt',
        lastChecked: last,
        nextRun: next,
      };
    });
  }
}

/** 找出 (last, now] 里最近一次该跑的时间 */
function mostRecentDue(task, last, now) {
  return mostRecentMatch(task.parsedCron, last, now);
}
