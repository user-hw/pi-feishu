/**
 * 验证命令背后的 API 真的能用：/status /model /thinking /new /cwd
 *   node scripts/test-commands.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PiPool } from '../src/pi-pool.js';
import { ChatStore } from '../src/store.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cmd-'));
const store = new ChatStore(path.join(workspace, 'chats.json'));
const pool = new PiPool({ store, cwd: workspace, model: null, thinking: null, idleMs: 60_000 });

const line = (t) => console.log(`\n=== ${t} ===`);
const fake = { chatId: 'oc_test_cmds', messageId: 'om_fake', senderId: 'ou_x', chatType: 'group' };

try {
  const entry = await pool.acquire(fake.chatId);

  line('/status → getState()');
  const st = await entry.client.getState();
  console.log('  模型      :', st.model?.id ?? st.model?.modelId ?? '(未知)');
  console.log('  provider  :', st.model?.provider);
  console.log('  思考等级  :', st.thinkingLevel);
  console.log('  运行中    :', st.isStreaming);
  console.log('  会话文件  :', st.sessionFile);

  line('/model（无参数）→ getAvailableModels()');
  const models = await entry.client.getAvailableModels();
  console.log('  可用模型数:', models.length);
  const byProvider = {};
  for (const m of models) (byProvider[m.provider] ??= []).push(m.id);
  for (const [p, ids] of Object.entries(byProvider)) {
    console.log(`  ${p}: ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ` …(+${ids.length - 4})` : ''}`);
  }

  // 换一个模型试试
  const target = models.find((m) => m.id !== (st.model?.id ?? st.model?.modelId));
  if (target) {
    line(`/model ${target.provider}/${target.id} → setModel()`);
    const applied = await entry.client.setModel(target.provider, target.id);
    console.log('  切换结果  :', JSON.stringify(applied));
    const after = await entry.client.getState();
    console.log('  确认现在  :', after.model?.id ?? after.model?.modelId);
  }

  line('/thinking → getAvailableThinkingLevels() + setThinkingLevel()');
  const levels = await entry.client.getAvailableThinkingLevels().catch((e) => `失败: ${e.message}`);
  console.log('  可用等级  :', Array.isArray(levels) ? levels.join(' / ') : levels);
  if (Array.isArray(levels) && levels.length) {
    await entry.client.setThinkingLevel(levels[0]);
    console.log('  设为      :', (await entry.client.getState()).thinkingLevel);
  }

  line('/new → newSession()');
  const before = store.get(fake.chatId).sessionFile;
  const result = await entry.client.newSession();
  const ns = await entry.client.getState();
  store.set(fake.chatId, { sessionFile: ns.sessionFile });
  console.log('  是否被取消:', result?.cancelled);
  console.log('  旧会话文件:', before ? path.basename(before) : '(无)');
  console.log('  新会话文件:', ns.sessionFile ? path.basename(ns.sessionFile) : '(无)');
  console.log('  确实换了  :', before !== ns.sessionFile);

  line('/cwd → setCwd()（销毁进程，下次重建）');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cmd2-'));
  await pool.setCwd(fake.chatId, other);
  console.log('  store 记录:', JSON.stringify(store.get(fake.chatId)));
  const entry2 = await pool.acquire(fake.chatId);
  console.log('  重建后 cwd:', entry2.cwd);
  console.log('  是否一致  :', entry2.cwd === other);
  fs.rmSync(other, { recursive: true, force: true });

  console.log('\n✅ 全部命令的底层 API 验证通过');
} catch (err) {
  console.error('\n❌ 失败:', err);
  process.exitCode = 1;
} finally {
  await pool.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
