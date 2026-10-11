/**
 * 冒烟测试：不连飞书，只验证 pi 这一侧的链路
 *   PiPool.acquire -> runTurn 流式输出 -> agent_settled
 * 用法: node --env-file-if-exists=.env scripts/smoke-pi.js
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { runTurn } from '../src/bridge.js';
import { PiPool } from '../src/pi-pool.js';
import { ChatStore } from '../src/store.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-feishu-smoke-'));
console.log('临时工作目录:', workspace);

const store = new ChatStore(path.join(workspace, 'chats.json'));
const pool = new PiPool({
  store,
  cwd: workspace,
  model: process.env.SMOKE_MODEL || null,
  thinking: null,
  idleMs: 60_000,
});

const chatId = 'oc_smoke_test';
const prompt = process.env.SMOKE_PROMPT || '用一句话介绍你自己，然后运行 bash 命令 `echo hello-from-pi`。';

try {
  const { client, cwd, sessionFile } = await pool.acquire(chatId);
  console.log('cwd      :', cwd);
  console.log('session  :', sessionFile);

  const state = await client.getState();
  console.log('model    :', state.model?.id ?? state.model?.modelId);
  console.log('prompt   :', prompt);
  console.log('--- 流式输出 ---');

  let chunks = 0;
  const started = Date.now();
  for await (const chunk of runTurn(client, { text: prompt, maxTurnMs: 180_000 })) {
    chunks += 1;
    process.stdout.write(chunk);
  }
  console.log(`\n--- 结束 (${chunks} 个增量, ${((Date.now() - started) / 1000).toFixed(1)}s) ---`);

  const after = await client.getState();
  console.log('消息数   :', after.messageCount);
  console.log('会话文件 :', after.sessionFile);
  console.log('store    :', JSON.stringify(store.get(chatId)));

  console.log('\n✅ 冒烟测试通过');
} catch (err) {
  console.error('\n❌ 冒烟测试失败:', err);
  process.exitCode = 1;
} finally {
  await pool.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
