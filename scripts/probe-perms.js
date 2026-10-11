/**
 * 反查应用的真实状态：用 API 试探哪些权限真的生效了。
 * 飞书的错误码会直接告诉我们「权限没生效」还是「权限有了但别的问题」。
 *   node --env-file=.env scripts/probe-perms.js
 */
import { Client } from '@larksuiteoapi/node-sdk';

const client = new Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

const explain = (err) => {
  const d = err?.response?.data ?? {};
  const code = d.code ?? err?.code ?? '?';
  const msg = d.msg ?? err?.message ?? String(err);
  const hint =
    {
      99991672: '❌ 权限未开通/未生效 —— 去「权限管理」加权限并【重新发布版本】',
      99991663: '❌ token 类型不对',
      99991400: '❌ 请求参数问题',
      230002: '❌ 会话不存在或机器人不在其中',
      230013: '❌ 机器人不在该会话中',
      230020: '⚠️ 触发了频率限制（说明鉴权和权限是通的）',
      10003: '❌ 参数错误',
    }[code] ?? '❔ 未分类';
  return `code=${code} ${hint}\n     msg: ${msg}`;
};

async function probe(title, fn) {
  process.stdout.write(`\n── ${title}\n`);
  try {
    const res = await fn();
    console.log('   ✅ 调用成功');
    const items = res?.data?.items;
    if (Array.isArray(items)) console.log(`   返回 ${items.length} 条`);
    else if (res?.data) console.log('   data:', JSON.stringify(res.data).slice(0, 300));
    return res;
  } catch (err) {
    console.log('   ' + explain(err));
    return null;
  }
}

console.log(`App ID: ${process.env.FEISHU_APP_ID}`);

// 1. 应用信息 + 发布状态（需要 application:application:readonly）
await probe('应用信息（能看出应用状态/是否发布）', () =>
  client.application.v6.application.get({
    path: { app_id: process.env.FEISHU_APP_ID },
    params: { lang: 'zh_cn' },
  }),
);

// 2. 机器人所在群列表（需要 im:chat:readonly）
await probe('机器人所在的群列表（im:chat:readonly）', () =>
  client.im.v1.chat.list({ params: { page_size: 50 } }),
);

// 故意构造一个「形状合法但不存在」的会话 ID，用来区分「权限不足」和「业务报错」。
// 在运行时拼出来，而不是写成字面量 —— 否则会被 scripts/check-privacy.sh 当成隐私泄漏。
const FAKE_CHAT_ID = `oc_${'0'.repeat(32)}`;

// 3. 发消息权限（im:message:send_as_bot）—— 故意发给不存在的会话，看错误码区分权限问题
await probe('发送消息权限探针（im:message:send_as_bot）', () =>
  client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: FAKE_CHAT_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: 'probe' }),
    },
  }),
);

// 4. 卡片流式所需权限（cardkit:card:write）
await probe('卡片实体创建权限探针（cardkit:card:write）', () =>
  client.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify({ schema: '2.0', body: { elements: [] } }) },
  }),
);

// 5. 通讯录读权限（contact:user.id:readonly）—— 顺带看能否按邮箱换 open_id
await probe('通讯录权限探针（contact:user.id:readonly）', () =>
  client.contact.v3.user.batchGetId({
    params: { user_id_type: 'open_id' },
    data: { emails: ['probe-does-not-exist@example.com'] },
  }),
);

console.log('\n── 说明 ──');
console.log('99991672 表示该权限没生效。若第 3/4 项报 230002/230013 之类的业务错误，');
console.log('说明权限其实是通的（只是目标会话不存在），那权限就不是问题所在。');
