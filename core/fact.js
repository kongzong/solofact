// 纯函数核：解析 / 规范化 / 校验 / 渲染。不碰文件系统，不取当前时间。
// 插件、MCP 门面、脚本以后都复用这一套规则，规则只有一份。

const TIME_RE = /^(\d{2}):(\d{2})$/;

// occurred 是日期（宿主认成 Date，才能排序/分组/求区间），time 是分钟精度（文本）。
// 分钟精度的唯一权威落点是 id：f-YYYYMMDD-HHmm-4hex。
function makeId(occurred, time, rand4) {
  const d = parseDate(occurred);
  if (!d) throw new Error('makeId: occurred 无法解析');
  const t = TIME_RE.test(String(time)) ? String(time).replace(':', '') : '0000';
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return `f-${date}-${t}-${String(rand4).slice(0, 4)}`;
}

function idParts(id) {
  const m = String(id).match(/^f-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-[0-9a-f]{4}$/);
  if (!m) return null;
  return { occurred: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

function parseDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const m = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
  if (Number.isNaN(d.getTime())) return null;
  // 2026-13-40 会被 Date 滚成 2027-02-09 并且"看起来合法"。日期必须原样往返，
  // 否则越界的月份/日号被自动纠正，脏日期就静默成功了——这正是这套契约要消灭的东西。
  const pad = (n) => String(n).padStart(2, '0');
  const roundTrip = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return roundTrip === `${m[1]}-${m[2]}-${m[3]}` ? d : null;
}

function dayString(value) {
  const d = parseDate(value);
  if (!d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// occurred 是本地日历日；parseDate 把它锚到 UTC 午夜，直接和 Date.now() 比毫秒，
// UTC+8 的早上 8 点前"今天"会被误判成未来。和未来比的是"本地日 > 今天"这种日粒度。
function localDayString(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseTime(value) {
  const m = TIME_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh < 24 && mm < 60 ? `${m[1]}:${m[2]}` : null;
}

function parseFrontmatter(markdown) {
  const lines = String(markdown).replace(/^/, '').split(/\r?\n/);
  if (lines[0] !== '---') return { data: {}, body: String(markdown), error: null };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { data: {}, body: '', error: 'frontmatter 未闭合' };
  const data = {};
  let pendingListKey = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // Obsidian 的属性面板会把 tags 这类列表重新序列化成块式（下一行起 "  - 值"）。
    // 读模型由宿主改写是常态，解析器若不认块式列表就会把宿主的手笔报成致命错误。
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && pendingListKey) {
      if (!Array.isArray(data[pendingListKey])) data[pendingListKey] = [];
      data[pendingListKey].push(parseScalar(item[1]));
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_.\u4e00-\u9fa5-]+):\s*(.*)$/);
    if (!m) return { data, body: '', error: `第 ${i + 1} 行不是 key: value` };
    if (m[2].trim() === '') {
      data[m[1]] = null;
      pendingListKey = m[1];
    } else {
      data[m[1]] = parseScalar(m[2]);
      pendingListKey = null;
    }
  }
  return { data, body: lines.slice(end + 1).join('\n'), error: null };
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((p) => stripQuotes(p.trim())) : [];
  }
  return stripQuotes(s);
}

function stripQuotes(s) {
  if (s.length > 1 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

const NON_PROPERTY_KEYS = new Set(['content', 'body', 'duplicateId']);

function dumpFrontmatter(fact, enums) {
  const keys = Object.keys(fact).filter((k) => !NON_PROPERTY_KEYS.has(k));
  const order = [...enums.field_order, ...keys.filter((k) => !enums.field_order.includes(k))].filter((k) =>
    keys.includes(k)
  );
  const out = ['---'];
  for (const key of order) {
    const value = fact[key];
    if (value === undefined || value === null || value === '') continue;
    out.push(`${key}: ${dumpValue(key, value, enums)}`);
  }
  out.push('---');
  return out.join('\n');
}

function dumpValue(key, value, enums) {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  if (enums.link_fields.includes(key)) return `"[[${stripQuotes(String(value))}]]"`;
  if (typeof value === 'number') return String(value);
  const s = String(value);
  // 日期加引号会被宿主判成文本，Bases 就无法按日期排序、分组、算区间——这是形态 B 的全部价值所在
  if (enums.date_fields.includes(key)) return s;
  return /[:#{}[\],&*?|>'"%@`]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function linkName(value) {
  if (value == null) return null;
  const m = String(value).match(/^\[\[(.+?)\]\]$/);
  return (m ? m[1] : String(value)).trim() || null;
}

function normalize(raw, enums) {
  const fact = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === '') continue;
    fact[key] = enums.link_fields.includes(key) ? linkName(value) : value;
  }
  if (Array.isArray(fact.tags)) fact.tags = fact.tags.map((t) => String(t).replace(/^#/, ''));
  if (typeof fact.content === 'string') fact.content = fact.content.trim();
  return fact;
}

function validate(rawFact, ctx = {}) {
  const enums = ctx.enums;
  if (!enums) throw new Error('validate: ctx.enums 必填');
  const fact = normalize(rawFact, enums);
  const issues = [];
  const add = (code, message, field) => issues.push({ code, message, field });

  for (const field of enums.required) {
    const v = fact[field];
    if (v === undefined || v === null || v === '') add('E_MISSING_REQUIRED', `缺必填字段 ${field}`, field);
  }

  for (const [field, spec] of Object.entries(enums.enums)) {
    const v = fact[field];
    if (v === undefined || v === null || v === '') continue;
    if (!Object.prototype.hasOwnProperty.call(spec, v)) {
      add('E_UNKNOWN_ENUM', `${field}="${v}" 不在封闭枚举 ${Object.keys(spec).join('/')}`, field);
    }
  }

  validateId(fact, enums, add);
  validateNames(fact, enums, add);
  validateAmount(fact, enums, add);
  validateDates(fact, ctx, add);
  validateJudgement(fact, enums, add);
  if (!hasBody(fact)) add('E_EMPTY_BODY', '正文为空，只有字段没有事实', 'content');

  const known = new Set([...enums.field_order, 'content', 'body', 'duplicateId']);
  for (const key of Object.keys(fact)) {
    if (!known.has(key)) add('W_UNKNOWN_FIELD', `未知字段 ${key}，宿主视图不会显示它`, key);
  }
  if (fact.duplicateId) add('E_DUPLICATE_ID', `id ${fact.id} 在全库中重复`, 'id');

  return issues.sort((a, b) => {
    const ra = a.code.startsWith('E_') ? 0 : 1;
    const rb = b.code.startsWith('E_') ? 0 : 1;
    return ra - rb || a.code.localeCompare(b.code);
  });
}

function validateNames(fact, enums, add) {
  const chars = enums.name_illegal_chars;
  if (!Array.isArray(chars)) throw new Error('validate: 契约缺 name_illegal_chars（数组）');
  // who/where/why 是自由文本（不是文件名），但非法字符仍该拒——保持"一条事实一个文件"的清洁。
  const fields = ['who', 'where', 'why'];
  for (const field of fields) {
    const v = fact[field];
    if (v === undefined || v === null || v === '') continue;
    const bad = chars.filter((c) => String(v).includes(c));
    if (bad.length) add('E_BAD_NAME', `${field} "${v}" 含 ${bad.join(' ')}`, field);
  }
}

function validateId(fact, enums, add) {
  if (!fact.id) return;
  if (!new RegExp(enums.id_pattern).test(fact.id)) {
    add('E_BAD_ID', `id "${fact.id}" 不符合 ${enums.id_pattern}`, 'id');
    return;
  }
  const parts = idParts(fact.id);
  const day = dayString(fact.occurred);
  if (day && parts && parts.occurred !== day) {
    add('E_ID_DATE_MISMATCH', `id 日期段 ${parts.occurred} 与 occurred ${day} 不一致`, 'id');
  }
  if (fact.time && parts) {
    const t = parseTime(fact.time);
    // 格式本身由 validateDates 报 E_BAD_TIME，这里只做一致性比对，避免同一问题报两遍
    if (t && t.replace(':', '') !== fact.id.slice(11, 15)) {
      add('E_ID_DATE_MISMATCH', `id 时间段 ${fact.id.slice(11, 15)} 与 time ${t} 不一致`, 'id');
    }
  }
}

function validateAmount(fact, enums, add) {
  // 5w2h 用 howmuch（通用数值度量：金额/体重/尺寸皆可）。主题=目录，同主题内 howmuch 天然同义，
  // 所以不做单位/口径校验——只保证它是个数（有限数字），单位由 what/how 文本承载。
  // 正负也不校验：符号是主题级约定（资金主题 负=出、正=进），核心不可能知道每个主题的语义——
  // 全局判正负就是被删掉的 type 校验的还魂（2026-10-13 用户定调：放行负数与零）。
  const aField = 'howmuch';
  const hasAmount = fact[aField] !== undefined && fact[aField] !== null;
  if (!hasAmount) return;
  const n = Number(fact[aField]);
  if (!Number.isFinite(n)) add('E_AMOUNT_NAN', `${aField} "${fact[aField]}" 不是数字`, aField);
}

function validateDates(fact, ctx, add) {
  // 发生日期叫 when（time/recorded 通用）
  const dateField = 'when';
  const occurred = parseDate(fact[dateField]);
  if (fact[dateField] && !occurred) add('E_BAD_DATE', `${dateField} "${fact[dateField]}" 无法解析，请用 YYYY-MM-DD`, dateField);
  if (fact.time && !parseTime(fact.time)) add('E_BAD_TIME', `time "${fact.time}" 不是 HH:mm`, 'time');
  const recorded = parseDate(fact.recorded);
  if (fact.recorded && !recorded) add('E_BAD_DATE', `recorded "${fact.recorded}" 无法解析`, 'recorded');
  if (occurred && ctx.now != null && dayString(fact[dateField]) > localDayString(ctx.now)) {
    add('E_FUTURE_DATE', `${dateField} ${dayString(fact[dateField])} 在未来`, dateField);
  }
  if (occurred && recorded && recorded.getTime() < occurred.getTime()) {
    add('E_RECORDED_BEFORE', `recorded ${dayString(fact.recorded)} 早于 ${dateField} ${dayString(fact[dateField])}，先记录后发生不可能`, 'recorded');
  }
}

function validateJudgement(fact, enums, add) {
  const text = bodyText(fact) || '';
  for (const word of enums.judgement_words) {
    if (text.includes(word)) {
      add('W_JUDGEMENT', `正文含判断词「${word}」，本库只记事实不记判断`, 'content');
      return;
    }
  }
}

function bodyText(fact) {
  if (typeof fact.content === 'string') return fact.content;
  if (typeof fact.body === 'string') return fact.body;
  return null;
}

function hasBody(fact) {
  const t = bodyText(fact);
  return t != null && t.trim().length > 0;
}

function renderFactFile(fact, enums) {
  const f = normalize(fact, enums);
  return `${dumpFrontmatter(f, enums)}\n\n${(bodyText(f) || '').trim()}\n`;
}

function parseFactFile(markdown, enums) {
  const { data, body, error } = parseFrontmatter(markdown);
  if (error) return { fact: null, error };
  return { fact: normalize({ ...data, content: body.trim() }, enums), error: null };
}

// 事实的简短摘要（CLI 录入后回显用）：时间 + wikilink + who + 正文前 40 字。
// 它不是数据——重建时可以从 事实/ 全量重生成，改坏了也不影响真源。
function renderPointerLine(fact) {
  const time = parseTime(fact.time) || '??';
  const who = fact.who || '';
  const body = (bodyText(fact) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `- ${time} [[${fact.id}]] ${who} ${body}`.replace(/\s+$/, '');
}

export {
  makeId,
  idParts,
  parseDate,
  dayString,
  parseTime,
  parseFrontmatter,
  dumpFrontmatter,
  linkName,
  normalize,
  validate,
  renderFactFile,
  parseFactFile,
  renderPointerLine,
};
