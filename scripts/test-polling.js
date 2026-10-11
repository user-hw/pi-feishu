/**
 * 既然事件推不过来，测试两条替代路径：
 *   1. 出站：机器人能不能往群里发消息
 *   2. 入站：能不能用 im.v1.message.list 轮询读到群里的消息
 *   node --env-file=.env scripts/test-polling.js [chat_id]
 */
import { Client } from '@larksuiteoapi/node-sdk';

const client = new Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

const fmt = (m) => {
  let text = m.body?.content ?? '';
  try {
    const p = JSON.parse(text);
    text = p.text ?? p.title ?? text;
  } catch {}
  const who = m.sender?.id_type === 'open_id' ? m.sender.id : m.sender?.id;
  const when = m.create_time ? new Date(Number(m.create_time)).toLocaleTimeString() : '?';
  return `[${when}] ${m.msg_type} from=${who}\n        ${String(text).replace(/\s+/g, ' ').slice(0, 160)}`;
};

let chatId = process.argv[2];
if (!chatId) {
  const r = await client.im.v1.chat.list({ params: { page_size: 100 } });
  const groups = (r?.data?.items ?? []).filter((c) => c.chat_mode === 'group');
  if (groups.length === 0) {
    console.error('没找到群。请先把机器人拉进一个群。');
    process.exit(1);
  }
  chatId = groups[0].chat_id;
}
console.log('目标群:', chatId);

// ── 1. 出站测试 ───────────────────────────────────────────────
console.log('\n=== 1. 出站：往群里发一条消息 ===');
try {
  const sent = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: '✅ 出站测试：这条消息是机器人通过 API 主动发的，与事件无关。' }),
    },
  });
  console.log('  发送成功 message_id =', sent?.data?.message_id);
  console.log('  👉 去飞书群里看看有没有收到');
} catch (err) {
  const d = err?.response?.data ?? {};
  console.log(`  发送失败 code=${d.code} msg=${d.msg}`);
}

// ── 2. 入站轮询测试 ───────────────────────────────────────────
console.log('\n=== 2. 入站：轮询读群里最近的消息 ===');
try {
  const res = await client.im.v1.message.list({
    params: { container_id_type: 'chat', container_id: chatId, page_size: 20, sort_type: 'ByCreateTimeDesc' },
  });
  const items = res?.data?.items ?? [];
  console.log(`  读到 ${items.length} 条消息：`);
  for (const m of items) console.log('  ' + fmt(m));
  if (items.length === 0) console.log('  (空)');
} catch (err) {
  const d = err?.response?.data ?? {};
  console.log(`  轮询失败 code=${d.code}`);
  console.log(`  msg=${d.msg}`);
  if (d.code === 99991672) {
    console.log('  → 读群消息权限没开（可能需要 im:message.group_msg 或 im:message.group_at_msg:readonly）');
  }
}
