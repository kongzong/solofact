// vault 扫描与体检报告：CLI（体检/重建）、插件壳共用，规则只有一份。
// 一条事实 = 一个文件，所以"全库校验"就是遍历每个主题的 事实/ 并把每个文件读回契约。
// 主题 = 目录：跨所有主题汇总一份体检（数字层面），但不生成任何跨主题视图。
// IO 全部走注入的 store（见 core/store.js），本文件不 import node:fs。
import { validate, parseFactFile, dayString } from './fact.js';
import { DIR, listTopics, topicFacts } from './vault.js';

// 没有主题目录时返回空（而不是抛）——插件首跑、空库都该得到"0 主题 0 事实"而不是一条红错误。
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
  return { rows, fileCount: countFiles(store), topics };
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

function tally(rows) {
  const all = flatIssues(rows);
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

function reportLines({ title, vault, enums, now, rows, topics = [], extra = [] }) {
  const { fatal, warn } = tally(rows);
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
    ...extra,
    '## 按错误码',
    '',
    '| code | 级别 | 条数 | 前三个位置 |',
    '| --- | --- | --- | --- |',
    ...codeRows(fatal.concat(warn)),
    '',
    '## 明细',
    '',
    ...(flatIssues(rows).map((i) => `- \`${i.code}\` \`<${i.where}>\` — ${i.message}`)),
    flatIssues(rows).length ? '' : '- 无',
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
