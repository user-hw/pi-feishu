/**
 * 诊断：机器人到底有没有收到消息？
 *   node --env-file=.env scripts/diagnose.js
 */
import { Client } from '@larksuiteoapi/node-sdk';

const client = new Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

const show = (title, value) => console.log(`\n=== ${title} ===\n${value}`);

try {
  const chats = await client.im.v1.chat.list({ params: { page_size: 50 } });
  const items = chats?.data?.items ?? [];
  show('机器人所在的会话', items.length === 0 ? '(空)' : '');
  for (const c of items) {
    console.log(`  chat_id   : ${c.chat_id}`);
    console.log(`  name      : ${c.name || '(私聊无名字)'}`);
    console.log(`  chat_mode : ${c.chat_mode}`);
    console.log(`  type      : ${c.chat_type}`);
    console.log('');
  }

  const p2p = items.filter((c) => c.chat_mode === 'p2p');
  if (p2p.length > 0) {
    console.log('👉 找到了私聊会话 —— 说明你的消息【确实到达了】机器人。');
    console.log('   那么收不到事件的原因只有一个：控制台的事件订阅没配对。');
    for (const c of p2p) {
      const res = await client.im.v1.message
        .list({
          params: { container_id_type: 'chat', container_id: c.chat_id, page_size: 5, sort_type: 'ByCreateTimeDesc' },
        })
        .catch((e) => ({ error: e.message }));
      if (res?.error) {
        console.log(`   读 ${c.chat_id} 的历史消息失败: ${res.error}`);
        continue;
      }
      for (const m of res?.data?.items ?? []) {
        let body = m.body?.content ?? '';
        try {
          body = JSON.parse(body).text ?? body;
        } catch {}
        console.log(`   [${m.msg_type}] ${m.sender?.id} → ${body}`);
      }
    }
  } else {
    console.log('👉 没有任何私聊会话 —— 说明消息【根本没到达】机器人。');
    console.log('   可能原因：应用版本没发布 / 你没找到机器人 / 找错了对象。');
  }
} catch (err) {
  console.error('诊断失败:', err?.response?.data ?? err.message ?? err);
}
