/**
 * 会话查看器：把所有 pi 会话列出来，方便找到手机上聊的那些。
 *
 *   node scripts/sessions.js            # 全部会话（最近优先）
 *   node scripts/sessions.js --phone    # 只看桥产生的会话
 *   node scripts/sessions.js 关键词      # 按标题/路径/内容过滤
 *   node scripts/sessions.js --open 3   # 打印第 3 条的恢复命令
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SessionManager } from '@earendil-works/pi-coding-agent';

const args = process.argv.slice(2);
const onlyPhone = args.includes('--phone');
const shouldOpen = args.includes('--open');
const openIndex = shouldOpen ? Number(args[args.indexOf('--open') + 1]) : null;
const keyword = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))?.toLowerCase();

const phoneCwd = process.env.PI_FEISHU_CWD?.trim()
  ? path.resolve(process.env.PI_FEISHU_CWD.trim())
  : path.join(os.homedir(), 'pi-feishu', 'workspace');

const ago = (date) => {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  return `${Math.floor(seconds / 86400)}天前`;
};

const short = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const shorten = (dir) => (dir.startsWith(os.homedir()) ? `~${dir.slice(os.homedir().length)}` : dir);

console.log('正在扫描会话…\n');

let sessions = await SessionManager.listAll();

if (onlyPhone) sessions = sessions.filter((s) => s.cwd === phoneCwd || s.cwd.includes('pi-feishu'));

if (keyword) {
  sessions = sessions.filter((s) =>
    [s.name, s.cwd, s.firstMessage, s.allMessagesText]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(keyword)),
  );
}

sessions.sort((a, b) => b.modified - a.modified);

if (sessions.length === 0) {
  console.log('没有匹配的会话。');
  process.exit(0);
}

// 按 cwd 分组显示
const byCwd = new Map();
for (const s of sessions) {
  const key = s.cwd || '(未知目录)';
  if (!byCwd.has(key)) byCwd.set(key, []);
  byCwd.get(key).push(s);
}

let index = 0;
const flat = [];

for (const [cwd, list] of byCwd) {
  const isPhone = cwd === phoneCwd || cwd.includes('pi-feishu');
  console.log(`\n${isPhone ? '📱' : '💻'} ${shorten(cwd)}  (${list.length} 个会话)`);
  console.log('─'.repeat(70));
  for (const s of list) {
    index += 1;
    flat.push(s);
    const title = s.name ? `「${s.name}」` : short(s.firstMessage, 46) || '(空会话)';
    console.log(
      `  ${String(index).padStart(3)}. ${ago(s.modified).padStart(8)}  ` +
        `${String(s.messageCount).padStart(3)}条  ${title}`,
    );
  }
}

console.log(`\n共 ${flat.length} 个会话。`);

console.log('\n怎么看 / 怎么接着聊：');
console.log('  ── 方式 A：进到那个目录，用 pi 的会话选择器 ──');
console.log(`     cd <上面显示的目录> && pi -r`);
console.log('  ── 方式 B：直接指定会话文件（最精确）──');
console.log(`     pi --session "<会话文件的完整路径>"`);
console.log('  ── 方式 C：导出成 HTML 用浏览器看 ──');
console.log(`     pi --export "<会话文件>" ~/Desktop/session.html`);

if (shouldOpen) {
  const picked = flat[Number(openIndex) - 1];
  if (!picked) {
    console.log(`\n⚠️ 没有第 ${openIndex} 个会话。`);
  } else {
    console.log(`\n👉 第 ${openIndex} 个（${shorten(picked.cwd)}）：`);
    console.log(`   pi --session "${picked.path}"`);
    console.log(`\n   导出 HTML：`);
    console.log(`   pi --export "${picked.path}" ~/Desktop/session.html`);
  }
}

// 附一份清单文件，方便复制
const outFile = path.join(os.homedir(), '.pi-feishu', 'sessions.txt');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
  outFile,
  flat
    .map(
      (s, i) =>
        `${String(i + 1).padStart(3)}. ${s.modified.toISOString()}  ${s.messageCount}条  ${s.cwd}\n     ${s.path}`,
    )
    .join('\n'),
);
console.log(`\n（清单已写到 ${outFile}）`);
