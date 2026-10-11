/**
 * 极简 cron 解析器。
 *
 * 支持标准 5 段格式：分 时 日 月 周
 *   每个字段支持  *  |  5  |  1-5  |  1,3,5  |  * /10  |  1-5/2
 *   周几支持 0-7（0 和 7 都是周日），也支持 sun/mon/tue/wed/thu/fri/sat
 *
 * 不依赖任何第三方库，因为这里只需要「某一分钟是否命中」这一个判断，
 * 而「最近一次应该运行的时间」由调用方逐分钟回溯得出。
 */

const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const FIELDS = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7, aliases: DOW_NAMES },
];

function parseField(text, { name, min, max, aliases }) {
  const values = new Set();
  const normalize = (token) => {
    const lower = String(token).toLowerCase();
    if (aliases && lower in aliases) return aliases[lower];
    const n = Number(lower);
    if (!Number.isInteger(n)) throw new Error(`${name}字段无法识别: "${token}"`);
    return n;
  };

  for (const part of String(text).split(',')) {
    if (part === '') throw new Error(`${name}字段有空项: "${text}"`);

    let range = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`${name}字段步长无效: "${part}"`);
      }
    }

    let lo;
    let hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = normalize(a);
      hi = normalize(b);
    } else {
      lo = hi = normalize(range);
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`${name}字段范围无效: "${part}"（应在 ${min}-${max}）`);
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  // 周日写成 7 时也当成 0
  if (name === '周' && values.has(7)) {
    values.add(0);
    values.delete(7);
  }
  return values;
}

/** 解析 cron 表达式，返回 { minutes, hours, dom, month, dow, domRestricted, dowRestricted } */
export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式需要 5 段（分 时 日 月 周），收到 ${parts.length} 段: "${expression}"`);
  }
  const [min, hour, dom, month, dow] = parts.map((text, i) => parseField(text, FIELDS[i]));
  return {
    expression: String(expression).trim(),
    minutes: min,
    hours: hour,
    dom,
    month,
    dow,
    // 标准 cron 语义：日 和 周 都限定时取「或」，只限定一个时取那个
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/** 判断某个时刻是否命中 */
export function matches(parsed, date) {
  const m = date.getMinutes();
  const h = date.getHours();
  const d = date.getDate();
  const mo = date.getMonth() + 1;
  const w = date.getDay();

  if (!parsed.minutes.has(m)) return false;
  if (!parsed.hours.has(h)) return false;
  if (!parsed.month.has(mo)) return false;

  const domOk = parsed.dom.has(d);
  const dowOk = parsed.dow.has(w);

  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true;
}

/**
 * 找出 (from, to] 区间内**最近一次**命中的整分钟。
 * 逐分钟回溯，最多回溯 maxLookbackMinutes 分钟（默认 24 小时）。
 * 用于机器睡眠/重启后的「补跑」：错过了就补一次，不会补很多次。
 */
export function mostRecentMatch(parsed, from, to, { maxLookbackMinutes = 24 * 60 } = {}) {
  const end = new Date(to);
  end.setSeconds(0, 0);
  const endMs = end.getTime();

  // 区间是【左开右闭】(from, to]：from 那一刻算「已经处理过」，
  // 否则任务跑完后再问一次会又把自己算成新的匹配，导致重复触发。
  const floorMs = Math.max(from.getTime(), endMs - maxLookbackMinutes * 60_000);

  for (let cursor = endMs; cursor > floorMs; cursor -= 60_000) {
    if (matches(parsed, new Date(cursor))) return new Date(cursor);
  }
  return null;
}

/** 向前找下一次命中（用于 /tasks 展示和日志），最多找 maxMinutes 分钟 */
export function nextMatch(parsed, from, { maxMinutes = 366 * 24 * 60 } = {}) {
  const start = new Date(from);
  start.setSeconds(0, 0);
  let cursor = start.getTime() + 60_000; // 从下一分钟开始，不含当下
  const limit = start.getTime() + maxMinutes * 60_000;
  while (cursor <= limit) {
    if (matches(parsed, new Date(cursor))) return new Date(cursor);
    cursor += 60_000;
  }
  return null;
}

/** 校验表达式是否合法（不抛异常版本） */
export function isValid(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** 人类可读的描述，用于日志和 /tasks 命令 */
export function describe(expression) {
  const raw = String(expression ?? '').trim();
  const presets = {
    '* * * * *': '每分钟',
    '0 * * * *': '每小时整点',
    '0 8 * * *': '每天 08:00',
    '0 9 * * 1-5': '工作日 09:00',
    '0 9 * * 1': '每周一 09:00',
    '0 20 * * 0': '每周日 20:00',
    '0 8 1 * *': '每月 1 号 08:00',
  };
  if (presets[raw]) return presets[raw];
  try {
    const p = parseCron(raw);
    const pad = (set, len = 2) => [...set].sort((a, b) => a - b).map((v) => String(v).padStart(len, '0'));
    const all = (set, max) => set.size === max + 1;
    const time = `${pad(p.hours).join(',')}:${pad(p.minutes).join(',')}`;
    const bits = [`在 ${time}`];
    if (!all(p.dom, 31) || p.dom.size !== 31) bits.push(`日=${[...p.dom].sort((a, b) => a - b).join(',')}`);
    if (p.dow.size !== 7) {
      const names = ['日', '一', '二', '三', '四', '五', '六'];
      bits.push(`周${[...p.dow].sort((a, b) => a - b).map((d) => names[d]).join('')}`);
    }
    if (p.month.size !== 12) bits.push(`月=${[...p.month].sort((a, b) => a - b).join(',')}`);
    return bits.join(' ');
  } catch {
    return raw;
  }
}
