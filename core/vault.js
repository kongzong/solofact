// vault 的物理布局：目录、真源、读模型模板、幂等的主题维护。
// 只有写入路径（CLI／插件的写函数集）用这一套，实验脚本也用同一套模板，所以模板不会分叉。
// 这里的参数一律叫 store（见 core/store.js）：本文件不 import node:fs，插件壳才能复用。
//
// 形态：**主题 = 一个自包含目录**（一堆事实的上级目录）。每个主题自带
//   <主题>/_真源/facts.ndjson   append-only 真源
//   <主题>/事实/f-*.md          读模型（一条事实一个文件）
//   <主题>/<主题>.base          Bases 视图（只索引本主题的 事实/）
//   <主题>/时间线.md / .html    可视化时间线
// 根级只有 .obsidian/types.json（属性类型，全局共享）和 _体检.md（跨主题汇总的诊断报告）。
// 没有主题 frontmatter 字段、没有 type——主题从目录名推断，同主题内 howmuch 天然同义。
import { renderFactFile } from './fact.js';

const DIR = {
  facts: '事实',
  truth: '_真源',
  report: '_体检.md',
  types: '.obsidian/types.json',
  obsidian: '.obsidian',
  timelineMd: '时间线.md',
  timelineHtml: '时间线.html',
};

// —— 主题作用域的路径 helpers（主题名是一个目录名，assertRel 已挡掉 ../ 越界）——
const topicFacts = (topic) => `${topic}/事实`;
const topicTruthFile = (topic) => `${topic}/_真源/facts.ndjson`;
const topicBase = (topic) => `${topic}/${topic}.base`;
const topicTimelineMd = (topic) => `${topic}/时间线.md`;
const topicTimelineHtml = (topic) => `${topic}/时间线.html`;

// 主题 = 库根下"含 _真源/facts.ndjson 的子目录"。空目录（还没记过）不算，.obsidian/报告等排除。
function listTopics(store) {
  return store
    .entries('')
    .filter((name) => name !== DIR.obsidian && !name.startsWith('.') && !name.startsWith('_'))
    .filter((name) => store.exists(`${name}/_真源/facts.ndjson`));
}

// 5W2H 形态的属性类型：when/recorded 是日期、howmuch 是数字，视图才能排序/分组/汇总。
const TYPES_5W2H = {
  who: 'text',
  when: 'date',
  time: 'text',
  what: 'text',
  where: 'text',
  why: 'text',
  how: 'text',
  howmuch: 'number',
  recorded: 'date',
  tags: 'tags',
};

// 单个主题的 事实.base。凡是可枚举的文本字段都给一个"按 X 分组"看板：who/where/why/how 各一板，
// when 走时间线，howmuch 拆"正值记录/负值记录"两张表（howmuch 是有符号数：资金主题 负=出、正=进，
// 一张表混排看不出进出，拆开各是一本账；0 值罕见，归"全部事实"看）。howmuch 是通用度量，同主题内
// 天然同义，但不做 Sum（跨行相加仍可能无意义，用户要算自己在 Bases 里加 summary 即可）。
// what 是长叙述，表格只放「摘要」公式预览列。
function buildBase(topic) {
  return `filters:
  and:
    - file.inFolder("${topic}/事实")
formulas:
  summary: 'if(what.length > 40, what.slice(0, 40) + "…", what)'
properties:
  formula.summary:
    displayName: 摘要
  who:
    displayName: 谁
  when:
    displayName: 何时
  time:
    displayName: 时刻
  what:
    displayName: 啥
  where:
    displayName: 在哪
  why:
    displayName: 为何
  how:
    displayName: 方式
  howmuch:
    displayName: 多少
views:
  - type: table
    name: 全部事实
    order:
      - file.name
      - when
      - time
      - who
      - where
      - why
      - how
      - howmuch
      - formula.summary
  - type: kanban
    name: 按谁聚合
    groupBy:
      property: who
      direction: ASC
  - type: kanban
    name: 按在哪看板
    groupBy:
      property: where
      direction: ASC
  - type: kanban
    name: 按方式看板
    groupBy:
      property: how
      direction: ASC
  - type: kanban
    name: 按为何看板
    groupBy:
      property: why
      direction: ASC
  - type: table
    name: 时间线
    sortBy:
      property: when
      direction: DESC
    order:
      - when
      - time
      - who
      - where
      - why
      - how
      - howmuch
      - formula.summary
  - type: table
    name: 正值记录
    filters:
      and:
        # 资金主题即"进账/收"；其他主题（体重/里程/读数）本来就是正的，全落在这张
        - howmuch > 0
    order:
      - when
      - time
      - who
      - where
      - why
      - how
      - howmuch
      - formula.summary
  - type: table
    name: 负值记录
    filters:
      and:
        # 资金主题即"出账/支"；非资金主题通常一张都没有——空着就对了
        - howmuch < 0
    order:
      - when
      - time
      - who
      - where
      - why
      - how
      - howmuch
      - formula.summary
`;
}

// 建一个主题的物理布局（幂等）：真源缺失才建空文件，视图/类型注册表只在缺失时写——
// 用户被明确要求"要改视图就在 Obsidian 里改 <主题>.base"，而"记一条事实"绝不该把那些改动抹掉。
// .obsidian/types.json 是根级共享的，所有主题共用同一份属性类型注册表。
function ensureTopic(store, topic) {
  store.mkdir(topicFacts(topic));
  store.mkdir(`${topic}/_真源`);
  store.mkdir(DIR.obsidian);
  if (!store.exists(topicTruthFile(topic))) store.write(topicTruthFile(topic), '');
  if (!store.exists(DIR.types)) writeTypes(store);
  if (!store.exists(topicBase(topic))) store.write(topicBase(topic), buildBase(topic));
  if (!store.exists(topicTimelineMd(topic))) writeTimeline(store, topic);
}

function writeTypes(store) {
  store.write(DIR.types, JSON.stringify(TYPES_5W2H, null, 2) + '\n');
}

// 读模型全部重生成：每个主题的 base + 时间线按当前 事实/ 重写，类型注册表重写。
// 只有这条路径（重建）会覆盖 base／types.json——记录一条事实不会（见 ensureTopic 的"只在缺失时写"）。
// 顺带清掉同目录下的旧名 .base 孤儿：主题目录被改名/搬家后，<旧名>.base 不会跟着改（宿主改目录名
// 不改文件名），它的 inFolder 写死旧目录名——留着就是 Bases 面板两个入口、一个打开是空的。
// 只删"名字不是当前主题"的 .base：用户手改当前 .base 的内容重建本来就覆盖（确认框里说过），
// 而自建第二视图不是文档化用法——真出现了，重建前看一眼确认框就能救。
function resetViews(store) {
  writeTypes(store);
  for (const topic of listTopics(store)) {
    store.write(topicBase(topic), buildBase(topic));
    for (const p of store.list(topic)) {
      if (p.endsWith('.base') && p !== topicBase(topic)) store.removeTree(p);
    }
    writeTimeline(store, topic);
  }
}

// —— 时间线视图（每主题一份）——
// Obsidian Bases 没有原生 timeline 视图类型，所以内核从该主题的事实抽一张 callout 笔记放到主题目录，
// 宿主原生渲染。和 <主题>.base 一样是读模型：真源才是事实，重建会覆盖它。
// 另外生成一份同数据的 HTML（时间线.html），给浏览器/预览面板用。
//
// 数据源是 _真源/facts.ndjson 而不是 事实/*.md（2026-10-15 改）：真源本来就是权威、字段比
// frontmatter 还全；更重要的是录入路径因此不再需要预读全库事实正文——时间线曾是 snapshotStore
// 全量预加载的唯一理由，去掉它，录入从 O(全库) 读数降为 O(该主题真源) 一次读。
// 副作用是正向的：用户手改 事实/*.md 不再污染时间线（读模型只认真源，与"重建覆盖手改"同一逻辑）。
function adaptFact(data) {
  return {
    date: data.when,
    who: data.who || '—',
    body: String(data.what || data.content || '').trim(),
    time: data.time,
    where: data.where,
    how: data.how,
    howmuch: data.howmuch,
  };
}

function timelineFacts(store, topic) {
  const file = topicTruthFile(topic);
  if (!store.exists(file)) return [];
  return readTruth(store, topic)
    .map(adaptFact)
    .filter((f) => f.date)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 倒序：新的在上
}

// Obsidian 各版本都原生渲染 callout + 列表，不依赖 mermaid 的 timeline 图表类型
// （后者只在较新的 Obsidian 内置 mermaid 里才有，老版本会显示成原始代码）。
// 富卡片版仍然在 时间线.html（浏览器/预览面板用）。
function renderTimeline(facts) {
  const byDate = new Map();
  for (const f of facts) {
    if (!byDate.has(f.date)) byDate.set(f.date, []);
    byDate.get(f.date).push(f);
  }
  const lines = [
    '# 时间线',
    '',
    `> 内核从 \`_真源/\` 自动生成的可视化读模型（${facts.length} 条，按日期倒序）。在 Obsidian 里改这张图没用——重建会覆盖。`,
    '',
  ];
  for (const [date, items] of byDate) {
    lines.push(`> [!note] 📅 ${date}`);
    for (const f of items) {
      const meta = [
        f.time && `🕐 ${f.time}`,
        f.where && `📍 ${f.where}`,
        f.how && `🔧 ${f.how}`,
        f.howmuch != null && `📊 ${f.howmuch}`,
      ]
        .filter(Boolean)
        .join('　');
      const metaStr = meta ? `  _(${meta})_` : '';
      lines.push(`> - **${f.who}** — ${f.body}${metaStr}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTimelineHtml(facts) {
  const groups = new Map();
  for (const f of facts) {
    if (!groups.has(f.date)) groups.set(f.date, []);
    groups.get(f.date).push(f);
  }
  const sections = [...groups.entries()]
    .map(([date, items]) => {
      const cards = items
        .map((f) => {
          const meta = [
            f.who,
            f.time && `🕐 ${f.time}`,
            f.where && `📍 ${f.where}`,
            f.how && `🔧 ${f.how}`,
            f.howmuch != null && `📊 ${f.howmuch}`,
          ]
            .filter(Boolean)
            .map(escHtml)
            .join('　');
          return `<li class="card"><div class="body">${escHtml(f.body)}</div><div class="meta">${meta}</div></li>`;
        })
        .join('');
      return `<section class="day"><div class="date">${escHtml(date)}</div><ul class="cards">${cards}</ul></section>`;
    })
    .join('');
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>事实时间线</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    background: #0f1115; color: #e6e8ec; padding: 32px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b93a1; margin: 0 0 28px; font-size: 13px; }
  .timeline { max-width: 720px; margin: 0 auto; position: relative; padding-left: 18px; }
  .timeline::before { content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 2px;
    background: linear-gradient(#3b82f6, #8b5cf6); }
  .day { position: relative; margin: 0 0 26px; }
  .day::before { content: ""; position: absolute; left: -18px; top: 6px; width: 12px; height: 12px;
    border-radius: 50%; background: #3b82f6; box-shadow: 0 0 0 4px #0f1115; }
  .date { font-weight: 700; font-size: 14px; color: #c7d2fe; margin-bottom: 10px; letter-spacing: .3px; }
  .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 12px; padding: 12px 14px;
    transition: border-color .15s, transform .15s; }
  .card:hover { border-color: #3b82f6; transform: translateX(2px); }
  .body { color: #e6e8ec; }
  .meta { margin-top: 6px; font-size: 12px; color: #8b93a1; }
</style>
</head>
<body>
  <h1>事实时间线</h1>
  <p class="sub">${facts.length} 条事实 · 按日期倒序 · 由内核自动生成</p>
  <div class="timeline">${sections}</div>
</body>
</html>
`;
}

function writeTimeline(store, topic) {
  const facts = timelineFacts(store, topic);
  store.write(topicTimelineMd(topic), renderTimeline(facts));
  store.write(topicTimelineHtml(topic), renderTimelineHtml(facts));
}

function readTruth(store, topic) {
  const file = topicTruthFile(topic);
  const text = store.read(file);
  if (text === null) throw new Error(`没有 ${file}——先跑 init，或者 --vault 指错了地方`);
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split('\n').map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`${file} 第 ${i + 1} 行不是合法 JSON：真源坏了。从 git 恢复它，改 Markdown 没用`);
    }
  });
}

function appendTruth(store, topic, fact) {
  store.append(topicTruthFile(topic), JSON.stringify(fact) + '\n');
}

const factFile = (topic, id) => `${topicFacts(topic)}/${id}.md`;

function writeFact(store, topic, fact, enums) {
  store.write(factFile(topic, fact.id), renderFactFile(fact, enums));
}

export {
  DIR,
  topicFacts,
  topicTruthFile,
  topicBase,
  topicTimelineMd,
  topicTimelineHtml,
  TYPES_5W2H,
  buildBase,
  listTopics,
  ensureTopic,
  writeTypes,
  resetViews,
  writeTimeline,
  renderTimeline,
  renderTimelineHtml,
  adaptFact,
  readTruth,
  appendTruth,
  factFile,
  writeFact,
};
