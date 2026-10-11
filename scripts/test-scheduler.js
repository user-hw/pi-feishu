/**
 * 调度器测试。不连飞书、不起 pi，全部用假的 channel / pool。
 * 重点验证：不重复触发、睡醒补跑只补一次、能热加载、坏配置不会拖垮服务。
 *   node scripts/test-scheduler.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Scheduler } from '../src/scheduler.js';

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✖ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
const tasksFile = path.join(dir, 'tasks.json');
const stateFile = path.join(dir, 'state.json');

// ── 假的出站 / 假的 pi ────────────────────────────────────────
const sent = [];
const acquired = [];
const quiet = { log() {}, warn() {}, error() {} };

const channel = {
  async send(chat, input) {
    sent.push({ chat, text: input.markdown ?? input.text });
  },
  async stream(chat, input) {
    const chunks = [];
    await input.markdown({ append: async (c) => chunks.push(c) });
    sent.push({ chat, text: `[stream] ${chunks.join('')}` });
  },
};

/** 一个立刻结束的假 pi 客户端 */
const fakeClient = {
  onEvent(listener) {
    queueMicrotask(() => listener({ type: 'agent_settled' }));
    return () => {};
  },
  async getState() {
    return { isStreaming: false };
  },
  async prompt() {},
  async steer() {},
  async abort() {},
};

const pool = {
  async acquire(key) {
    acquired.push(key);
    return { client: fakeClient, cwd: '/tmp' };
  },
  async dispose() {},
};

const store = {
  data: {},
  get(k) {
    return this.data[k] ?? {};
  },
  set(k, v) {
    this.data[k] = { ...this.get(k), ...v };
  },
};

const writeTasks = (list) => fs.writeFileSync(tasksFile, JSON.stringify({ tasks: list }, null, 2));
const at = (s) => new Date(s.replace(' ', 'T'));

const make = () =>
  new Scheduler({
    pool,
    channel,
    store,
    tasksFile,
    stateFile,
    tickMs: 999_999, // 测试里手动 tick，不用定时器
    logger: quiet,
  });

console.log('\n════ 首次登记：不补跑历史 ════');
writeTasks([
  { id: 'a', name: '早报', schedule: '0 8 * * *', chat: 'oc_1', send: '早上好' },
]);
let s = make();
await s.tick(at('2026-10-12 07:00:00'));
await s.whenIdle();
check('首次 tick 不发送', sent.length, 0);
check('已登记该任务', typeof s.state.a, 'string');

console.log('\n════ 非命中分钟不触发 ════');
await s.tick(at('2026-10-12 07:59:00'));
await s.whenIdle();
check('07:59 不发送', sent.length, 0);

console.log('\n════ 命中就触发一次 ════');
await s.tick(at('2026-10-12 08:00:30'));
await s.whenIdle();
check('08:00 发送一次', sent.length, 1);
check('内容正确', sent[0].text, '早上好');
check('发到正确的群', sent[0].chat, 'oc_1');

console.log('\n════ 紧接着再 tick 不重复触发（曾经的闭区间 bug）════');
await s.tick(at('2026-10-12 08:01:00'));
await s.whenIdle();
check('仍然只有 1 条', sent.length, 1);
await s.tick(at('2026-10-12 08:30:00'));
await s.whenIdle();
check('半小时后仍只有 1 条', sent.length, 1);

console.log('\n════ 跨天正常触发 ════');
await s.tick(at('2026-10-13 08:00:10'));
await s.whenIdle();
check('第二天发送', sent.length, 2);

console.log('\n════ 睡醒补跑：关机 4 天只补最近一次 ════');
sent.length = 0;
await s.tick(at('2026-10-17 09:30:00'));
await s.whenIdle();
check('只补 1 次（不是 4 次）', sent.length, 1);

console.log('\n════ 重启后读状态，不重复触发 ════');
sent.length = 0;
s = make(); // 新实例，读同一个 state.json
await s.tick(at('2026-10-17 09:31:00'));
await s.whenIdle();
check('重启后同一分钟内不重复', sent.length, 0);

console.log('\n════ 热加载：直接改文件就生效 ════');
writeTasks([
  { id: 'a', name: '早报', schedule: '0 8 * * *', chat: 'oc_1', send: '早上好' },
  { id: 'b', name: '午间', schedule: '30 12 * * *', chat: 'oc_2', send: '午安' },
]);
await s.tick(at('2026-10-17 12:00:00')); // 登记 b
await s.whenIdle();
sent.length = 0;
await s.tick(at('2026-10-17 12:30:20'));
await s.whenIdle();
check('新任务无需重启即生效', sent.length, 1);
check('发到新任务的群', sent[0].chat, 'oc_2');

console.log('\n════ prompt 任务会去拿 pi 客户端，并用 task: 前缀的独立会话 ════');
acquired.length = 0;
writeTasks([{ id: 'p', name: '简报', schedule: '0 7 * * *', chat: 'oc_1', prompt: '写简报', cwd: '/tmp' }]);
await s.tick(at('2026-10-18 06:00:00'));
await s.whenIdle();
await s.tick(at('2026-10-18 07:00:10'));
await s.whenIdle();
check('用了独立会话键', acquired, ['task:p']);
check('写入了任务的 cwd', store.data['task:p']?.cwd, '/tmp');

console.log('\n════ 坏配置：只报告，不影响其它任务 ════');
sent.length = 0;
writeTasks([
  { id: 'bad1', name: '坏cron', schedule: '0 8 * *', chat: 'oc_1', send: 'x' },
  { id: 'bad2', name: '缺chat', schedule: '0 8 * * *', send: 'x' },
  { id: 'bad3', name: '没有内容', schedule: '0 8 * * *', chat: 'oc_1' },
  { id: 'off', name: '已禁用', schedule: '0 8 * * *', chat: 'oc_1', send: 'x', enabled: false },
  { id: 'good', name: '正常', schedule: '0 9 * * *', chat: 'oc_9', send: 'ok' },
]);
await s.tick(at('2026-10-19 08:30:00'));
await s.whenIdle();
check('报告了 3 个问题', s.problems.length, 3);
check('只保留了 1 个有效任务', s.tasks.length, 1);
await s.tick(at('2026-10-19 09:00:10'));
await s.whenIdle();
check('有效任务照常跑', sent.length, 1);

console.log('\n════ tasks.json 不存在也不报错 ════');
fs.unlinkSync(tasksFile);
const s2 = make();
s2.start();
s2.stop();
check('空任务列表', s2.tasks.length, 0);
check('无问题上报', s2.problems.length, 0);

console.log(`\n════ 结果：${pass} 通过 / ${fail} 失败 ════`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
