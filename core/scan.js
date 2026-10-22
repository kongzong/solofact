// vault 扫描与体检报告：CLI（体检/重建）、插件壳共用，规则只有一份。
// 一条事实 = 一个文件，所以"全库校验"就是遍历每个主题的 事实/ 并把每个文件读回契约。
// 主题 = 目录：跨所有主题汇总一份体检（数字层面），但不生成任何跨主题视图。
// IO 全部走注入的 store（见 core/store.js），本文件不 import node:fs。
import { validate, parseFactFile, dayString, localDayString } from './fact.js';
import { DIR, listTopics, topicFacts, viewIssues } from './vault.js';

// 没有主题目录时返回空（而不是抛）——插件首跑、空库都该得到"0 主题 0 事实"而不是一条红错误。
// 体检不只是扫事实文件：视图文件的名字坏了（缺 <主题>.base / 有异名 .base）也得报——
// 那也是2026-10-15 之前报"全库干净"的静默之一。views 是库级检查，不进 rows（rows 的粒度必须是
// 事实，rows.length 直接被当成事实总数用）。
function scanVault(store, ctx) {
  const topics = listTopics(store);
  const rows = [];
  for (const topic of topics) {
    const dir = topicFacts(topic);
    if (!store.exists(dir)) continue;
    for (const p of store.list(dir)) {
      if (!p.endsWith('.md')) continue;
      const id = p.slice(dir.length + 1).replace(/\.md$/, '');
      const { fact, error } = parseFactFile(store.read(p), ctx.enums);
      if (error) {
        rows.push({ file: p, topic, id, fact: null, issues: [{ code: 'E_BAD_FRONTMATTER', message: error }] });
      } else {
        rows.push({ file: p, topic, id: fact.id || id, fact, issues: validate(fact, ctx) });
      }
    }
  }
  markDuplicates(rows, ctx);
  return { rows, fileCount: countFiles(store), topics, views: viewIssues(store) };
}

// 顺序很重要：先标重复 id 再算检出率，否则自检会漏看 E_DUPLICATE_ID。
// 重复按 (主题, id) 判——id 只需主题内唯一，两个主题各有同 id 不算撞。
function markDuplicates(rows, ctx) {
  const tally = new Map();
  for (const r of rows) {
    if (!r.fact?.id) continue;
    const key = `${r.topic}/${r.fact.id}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  for (const r of rows) {
    if (!r.fact) continue;
    if (tally.get(`${r.topic}/${r.fact.id}`) < 2) continue;
    r.fact.duplicateId = true;
    r.issues = validate(r.fact, ctx);
  }
}

function flatIssues(rows) {
  const all = [];
  for (const r of rows) for (const i of r.issues) all.push({ ...i, where: r.file });
  return all.sort((a, b) => (a.code[0] === 'E' ? 0 : 1) - (b.code[0] === 'E' ? 0 : 1) || a.code.localeCompare(b.code));
}

// views = 库级检查（视图文件名），和行级告警并成一处，否则"告警 0 条"会撒谎。
function tally(rows, views = []) {
  const all = flatIssues(rows).concat(views);
  return {
    fatal: all.filter((i) => i.code.startsWith('E_')),
    warn: all.filter((i) => i.code.startsWith('W_')),
    all,
  };
}

function latestDay(rows) {
  const days = rows.map((r) => dayString(r.fact?.when)).filter(Boolean).sort();
  return days.length ? days[days.length - 1] : '—';
}

// 字段填充画像（2026-10-22）：体检报告从"只报问题"升级成"录入习惯的客观画像"——
// 每主题每字段填了百分之几。可选字段哪些真有人填、哪些是摆设，这是复盘"记录结构
// 要不要调"（spec §5.2）的现成素材：印象会骗人，百分比不会。
// 口径：howmuch=0 算填了（0 是数据不是空缺）；坏行（fact=null）
// 不进画像——它们已经在错误明细里，掺进百分比只会把两个问题搅在一起。
// time 不列入：makeFact 给每条事实自动打戳（非当天的补 00:00），它的填充率恒 100%，
// 是机器产物不是录入习惯——放进表里只会让人以为"时刻字段人人都在填"。
// tags 不列入：2026-10-22 实测全库 0% 填充，字段已从契约移除（5W2H 本无此字段）。
function fieldFillRows(rows) {
  const FIELDS = ['who', 'when', 'what', 'where', 'why', 'how', 'howmuch'];
  const filled = (fact, f) => {
    const v = f === 'what' ? fact.content ?? fact.what : fact[f];
    if (v == null || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  };
  const pct = (facts, f) => `${Math.round((facts.filter((x) => filled(x, f)).length / facts.length) * 100)}%`;
  const span = (facts) => {
    const days = facts.map((x) => dayString(x.when)).filter(Boolean).sort();
    return days.length ? `${days[0].slice(5)} ~ ${days.at(-1).slice(5)}` : '—';
  };
  const cells = (facts) => FIELDS.map((f) => pct(facts, f)).join(' | ');
  const byTopic = new Map();
  for (const r of rows) {
    if (!r.fact) continue;
    if (!byTopic.has(r.topic)) byTopic.set(r.topic, []);
    byTopic.get(r.topic).push(r.fact);
  }
  const all = [...byTopic.values()].flat();
  const lines = [
    '## 字段填充（录入画像）',
    '',
    '| 主题 | 条数 | 跨度 | who | when | what | where | why | how | howmuch |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [t, facts] of byTopic) lines.push(`| ${t} | ${facts.length} | ${span(facts)} | ${cells(facts)} |`);
  if (all.length) lines.push(`| **全库** | **${all.length}** | ${span(all)} | ${cells(all)} |`);
  lines.push('', '> 可选字段（where 起；time 由内核自动打戳，不列入）填得越少越接近摆设——调记录结构前先看这张表，别凭印象。', '');
  return lines;
}

// 录入频率（2026-10-22）：spec §5.2 立论实验的核心指标是"坚持住了吗"——solocrm 就死在
// 没人坚持记。字段画像回答"填了什么"，本节回答"哪天记了、断档几天"：印象会骗人，
// 曲线不会。数据全来自 rows 的 when（日粒度，同一天多条只计一天）。
function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function frequencyLines(rows, now) {
  const days = [...new Set(rows.map((r) => dayString(r.fact?.when)).filter(Boolean))].sort();
  if (!days.length) return [];
  const counts = new Map();
  for (const r of rows) {
    const d = dayString(r.fact?.when);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const today = localDayString(now);
  const first = days[0];
  const last = days.at(-1);
  const spanDays = dayDiff(first, last) + 1;
  // 断档口径 = 记录日之间的空白 **加上尾部**（最后记录日 → 今天）。只算日期间断的话，
  // "只记过一条"的库会报最长断档 0 天——而它明明断档了几百天，那是这个库最重要的事实。
  let maxGap = 0;
  let maxGapAt = '';
  for (let i = 1; i < days.length; i++) {
    const gap = dayDiff(days[i - 1], days[i]) - 1;
    if (gap > maxGap) {
      maxGap = gap;
      maxGapAt = days[i - 1];
    }
  }
  const curGap = Math.max(0, dayDiff(last, today));
  if (curGap > maxGap) {
    maxGap = curGap;
    maxGapAt = last;
  }
  // 最近 14 天逐日：有记录的显条数，空档显 ———扫一眼就知道这周记没记
  const recent = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
    recent.push(counts.has(d) ? `${d.slice(5)}·${counts.get(d)}` : `${d.slice(5)}—`);
  }
  return [
    '## 录入频率（按天）',
    '',
    `- 跨度 ${first.slice(5)} ~ ${last.slice(5)}（${spanDays} 天），有记录 **${days.length}** 天（${Math.round((days.length / spanDays) * 100)}%）`,
    `- 最长断档 **${maxGap}** 天${maxGap ? `（${maxGapAt.slice(5)} 之后）` : ''}；当前断档 **${curGap}** 天${curGap === 0 ? '（今天有记录）' : ''}`,
    `- 最近 14 天：${recent.join('　')}`,
    '',
  ];
}

function reportLines({ title, vault, enums, now, rows, topics = [], extra = [], views = [] }) {
  const { fatal, warn, all } = tally(rows, views);
  const byTopic = new Map();
  for (const r of rows) byTopic.set(r.topic, (byTopic.get(r.topic) || 0) + 1);
  return [
    `# 体检 · ${title}`,
    '',
    `- 库：\`${vault}\``,
    `- 规则：\`contract/enums-5w2h.json\` v${enums.version}，枚举从库内历史抽取，主题=目录（同主题 howmuch 天然同义，不校验单位）`,
    `- 体检时间：${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `- 判定：致命 = 必须改数据；告警 = 需要人看一眼。错误码前缀就是级别，不按"看起来严不严重"排`,
    '',
    '## 数字',
    '',
    `- 主题数：**${topics.length}**`,
    `- 事实总数：**${rows.length}**（一条事实 = 一个文件，行的粒度就是文件的粒度）`,
    `- 各主题：${[...byTopic.entries()].map(([t, n]) => `${t} ${n}`).join('、') || '（空）'}`,
    `- 最近一条 when：${latestDay(rows)}`,
    `- 致命错误：**${fatal.length}** 条，分布在 ${new Set(fatal.map((f) => f.where)).size} 个文件`,
    `- 告警：**${warn.length}** 条`,
    '',
    ...(rows.length ? fieldFillRows(rows) : []),
    ...(rows.length ? frequencyLines(rows, now) : []),
    ...extra,
    '## 按错误码',
    '',
    '| code | 级别 | 条数 | 前三个位置 |',
    '| --- | --- | --- | --- |',
    ...codeRows(fatal.concat(warn)),
    '',
    '## 明细',
    '',
    ...(all.map((i) => `- \`${i.code}\` \`<${i.where}>\` — ${i.message}`)),
    all.length ? '' : '- 无',
    '',
  ];
}

function writeReport(store, lines) {
  store.write(DIR.report, lines.join('\n'));
}

function group(list) {
  const m = new Map();
  for (const i of list) {
    if (!m.has(i.code)) m.set(i.code, []);
    m.get(i.code).push(i);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function codeRows(list) {
  if (!list.length) return ['| （零条，全库干净） | — | 0 | — |'];
  return group(list).map(
    ([code, items]) =>
      `| \`${code}\` | ${code[0] === 'E' ? '致命' : '告警'} | ${items.length} | ${items
        .slice(0, 3)
        .map((l) => `\`<${l.where}>\``)
        .join(' ')} |`
  );
}

// 事实文件数：只数每个主题的 事实/*.md（一条事实一个文件）。这是个不变量交叉校验——
// 它该恒等于扫描出的 rows 数；不等就说明有 .md 没被扫到（或有多余文件），体检要能暴露这种漂移。
function countFiles(store) {
  const factMd = new RegExp(`^[^/]+/${DIR.facts}/[^/]+\\.md$`);
  return store.list('').filter((p) => factMd.test(p)).length;
}

export { DIR, scanVault, reportLines, writeReport, tally, countFiles };
