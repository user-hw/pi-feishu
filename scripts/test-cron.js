/**
 * cron 解析器的测试。排错时间是定时任务里最不能出错的部分。
 *   node scripts/test-cron.js
 */
import { describe, isValid, matches, mostRecentMatch, parseCron } from '../src/cron.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✖ ${label}`);
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
  }
}

const at = (s) => new Date(s.replace(' ', 'T'));
const hit = (expr, s) => matches(parseCron(expr), at(s));

console.log('\n════ 基本匹配 ════');
check('每天 08:00 → 08:00 命中', hit('0 8 * * *', '2026-10-12 08:00:00'), true);
check('每天 08:00 → 08:01 不命中', hit('0 8 * * *', '2026-10-12 08:01:00'), false);
check('每天 08:00 → 09:00 不命中', hit('0 8 * * *', '2026-10-12 09:00:00'), false);

console.log('\n════ 星期（2026-10-12 是周一）════');
check('周一到周五 → 周一命中', hit('0 9 * * 1-5', '2026-10-12 09:00:00'), true);
check('周一到周五 → 周六不命中', hit('0 9 * * 1-5', '2026-10-17 09:00:00'), false);
check('周一到周五 → 周日不命中', hit('0 9 * * 1-5', '2026-10-18 09:00:00'), false);
check('周日写 0 → 命中', hit('0 9 * * 0', '2026-10-18 09:00:00'), true);
check('周日写 7 → 也命中（同一天）', hit('0 9 * * 7', '2026-10-18 09:00:00'), true);
check('周一名 sun → 不命中', hit('0 9 * * mon', '2026-10-18 09:00:00'), false);

console.log('\n════ 步长 / 列表 / 范围 ════');
check('*/15 → :00 命中', hit('*/15 * * * *', '2026-10-12 10:00:00'), true);
check('*/15 → :15 命中', hit('*/15 * * * *', '2026-10-12 10:15:00'), true);
check('*/15 → :07 不命中', hit('*/15 * * * *', '2026-10-12 10:07:00'), false);
check('1,2,3 → :2 命中', hit('1,2,3 * * * *', '2026-10-12 10:02:00'), true);
check('1,2,3 → :4 不命中', hit('1,2,3 * * * *', '2026-10-12 10:04:00'), false);
check('1-5/2 → :3 命中（1,3,5）', hit('1-5/2 * * * *', '2026-10-12 10:03:00'), true);
check('1-5/2 → :4 不命中', hit('1-5/2 * * * *', '2026-10-12 10:04:00'), false);

console.log('\n════ 日 / 月 ════');
check('每月 1 号 → 1 号命中', hit('0 8 1 * *', '2026-11-01 08:00:00'), true);
check('每月 1 号 → 2 号不命中', hit('0 8 1 * *', '2026-11-02 08:00:00'), false);
check('指定月份 → 命中', hit('0 8 * 12 *', '2026-12-15 08:00:00'), true);
check('指定月份 → 其它月不命中', hit('0 8 * 12 *', '2026-11-15 08:00:00'), false);

console.log('\n════ 日 和 周 同时限定 → 标准 cron 语义是「或」════');
check('1 号 或 周一 → 1 号命中', hit('0 8 1 * 1', '2026-11-01 08:00:00'), true);
check('1 号 或 周一 → 周一命中', hit('0 8 1 * 1', '2026-10-12 08:00:00'), true);
check('1 号 或 周一 → 普通周三不命中', hit('0 8 1 * 1', '2026-10-14 08:00:00'), false);

console.log('\n════ 补跑：睡眠后只补最近一次，不补多次 ════');
const daily = parseCron('0 8 * * *');
check(
  '关机 3 天后 → 只返回最近一次（10-15 08:00）',
  mostRecentMatch(daily, at('2026-10-12 08:00:00'), at('2026-10-15 08:30:00'))?.toISOString(),
  at('2026-10-15 08:00:00').toISOString(),
);
check(
  '刚跑过 1 分钟 → 不重复返回',
  mostRecentMatch(daily, at('2026-10-12 08:00:00'), at('2026-10-12 08:01:00')),
  null,
);
check(
  '跨天后 → 返回新的那次',
  mostRecentMatch(daily, at('2026-10-12 08:00:00'), at('2026-10-13 08:30:00'))?.toISOString(),
  at('2026-10-13 08:00:00').toISOString(),
);
check(
  '回溯上限外 → 返回 null（不会翻旧账）',
  // 窗口只看最近 60 分钟（11:00–12:00），而那次命中在 08:00，不在窗口内
  mostRecentMatch(daily, at('2020-01-01 00:00:00'), at('2026-10-15 12:00:00'), {
    maxLookbackMinutes: 60,
  }),
  null,
);

console.log('\n════ 非法表达式必须被拒绝 ════');
const bad = ['0 8 * *', '0 8 * * * *', '60 8 * * *', '0 24 * * *', '0 8 32 * *', '0 8 * 13 *', 'abc', '0 8 * * 9'];
for (const expr of bad) {
  check(`拒绝 "${expr}"`, isValid(expr), false);
}

console.log('\n════ 人性化描述 ════');
check('每天 08:00', describe('0 8 * * *'), '每天 08:00');
check('工作日 09:00', describe('0 9 * * 1-5'), '工作日 09:00');
check('未知表达式也能给个说法', typeof describe('7 6 * * 2'), 'string');

console.log(`\n════ 结果：${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail === 0 ? 0 : 1);
