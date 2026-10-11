/**
 * 原始事件探针：抓 WebSocket 上收到的每一个事件，绕开所有策略层。
 *   node --env-file=.env scripts/probe-events.js [秒数]
 *
 * 用来回答一个问题：飞书到底有没有把事件推过来？
 */
import fs from 'node:fs';

import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

const seconds = Number(process.argv[2] ?? 90);

const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.info });

// 猴补丁：在分发之前把每一个原始事件打印出来
const originalInvoke = dispatcher.invoke.bind(dispatcher);
let received = 0;

dispatcher.invoke = async (data, params) => {
  received += 1;
  const type = data?.header?.event_type ?? data?.type ?? '(未知)';
  console.log(`\n📨 [原始事件 #${received}] event_type = ${type}`);
  console.log(JSON.stringify(data?.event ?? data, null, 2).slice(0, 1500));
  return originalInvoke(data, params);
};

const ws = new WSClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  // trace 级：能看到 SDK 打印的 'receive pong'，用来证明连接是双向活的
  loggerLevel: LoggerLevel.trace,
});

ws.start({ eventDispatcher: dispatcher }).catch((e) => {
  console.error('WS 启动失败:', e?.message ?? e);
});

console.log(`探针已启动，监听 ${seconds} 秒。`);
console.log('👉 现在在飞书里给机器人发一条消息（比如「测试」）\n');

// 每 20 秒报一次心跳，并统计 pong 数
let pongs = 0;
const heartbeat = setInterval(() => {
  const raw = fs.readFileSync('/tmp/probe.log', 'utf8');
  pongs = (raw.match(/receive pong/g) ?? []).length;
  console.log(`[心跳] 事件=${received} pong=${pongs} (${new Date().toLocaleTimeString()})`);
}, 20_000);
heartbeat.unref?.();

setTimeout(async () => {
  clearInterval(heartbeat);
  console.log(`\n──────── 汇总 ────────`);
  console.log(`收到事件总数: ${received}`);
  if (received === 0) {
    console.log('\n❌ 一个事件都没收到。说明飞书没往这条长连接推东西，问题在开发者后台配置：');
    console.log('   1. 事件订阅方式是否选了「使用长连接接收事件」');
    console.log('   2. 是否添加了事件 im.message.receive_v1');
    console.log('   3. 应用版本是否已发布并通过审批');
    console.log('   4. 是否添加了「机器人」应用能力');
  } else {
    console.log('✅ 事件链路是通的，问题在别处。');
  }
  await ws.close({ force: true }).catch(() => {});
  process.exit(0);
}, seconds * 1000);
