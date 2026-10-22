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
};

// 视图文件名也是规矩的一部分：一个主题目录下只能有一个 .base，名字必须等于目录名。
//
// 为什么这么严（2026-10-15 定）：<主题>.base 是**读模型**，由程序生成、重建覆盖；插件的
// 「打开某个主题的视图」也按 `${topic}/${topic}.base` 这个路径找它。用户把它改名之后：
//   · 插件找不到它 → 这个主题的视图入口没了（命令会说"还不存在"）
//   · 下次记一条事实，ensureTopic 发现正主不在又补一份 → 目录里两个入口、两份同样的视图
//   · 重建会重生成正主并**删掉异名那份**（用户那边看就是"文件被吃了"）
// 这三件事以前全是静默的——体检照样报"全库干净"，因为体检只扫 事实/*.md，不看视图文件。
//
// 级别是告警 W_ 而不是致命 E_：base 里写的是 file.inFolder("<主题>/事实")，查的是**目录**
// 不含文件名，所以改文件名本身不会让视图变空（那才是目录改名的症状）。它坏的是约定，
// 不必改数据就能修——所以是"需要人看一眼"，不是"必须改数据"。
function viewIssues(store) {
  const issues = [];
  for (const topic of listTopics(store)) {
    const bases = (store.listReal(topic) || []).filter((p) => p.endsWith('.base'));
    const main = topicBase(topic);
    if (!bases.includes(main)) {
      issues.push({
        code: 'W_BASE_MISSING',
        where: `${topic}/`,
        message: `主题「${topic}」缺 ${topic}.base（视图入口）——跑「从真源重建」会按当前目录名重新生成一份`,
      });
    }
    for (const p of bases) {
      if (p === main) continue;
      issues.push({
        code: 'W_BASE_NAME',
        where: p,
        message: `视图文件名必须是 ${topic}.base（= 主题目录名）——插件和重建都按这个名字认它；这份异名的会被重建删掉。想保留就在重建前把文件名改回 ${topic}.base`,
      });
    }
  }
  return issues;
}

// 单个主题的 事实.base。凡是可枚举的文本字段都给一个"按 X 分组"看板：who/where/why/how 各一板，
// when 走时间线，howmuch 拆"正值记录/负值记录"两张表（howmuch 是有符号数：资金主题 负=出、正=进，
// 一张表混排看不出进出，拆开各是一本账；0 值罕见，归"全部事实"看）。howmuch 是通用度量，同主题内
// 天然同义——三张表都带 howmuch 的 Sum 汇总（2026-10-22 用户拍板）：
//   · 全部事实（默认视图，第一眼落在这里）：Sum = 净流量——有符号数直接相加，资金主题的
//     "进-出"净值本就该打开即见，是"记录要有回报"最直接的一格；
//   · 正值记录：进账/收 的合计；负值记录：出账/支 的合计——两本账各一个总数。
// 早前"全部事实不给 Sum"的立场（进和出加在一起无意义）被真机验收推翻：用户打开 .base 停在
// 默认视图，正/负表的汇总根本看不见——汇总放在没人看的视图里等于没有。且混符号相加恰是
// 净流量而非无意义数。非资金主题（体重/里程）的累计值无意义，用户不理那格即可（Sum 是
// 默认值不是强制，在 Bases 里可删）。录入路径不覆盖已有 base（见 ensureTopic），
// 只有显式「重建」才统一重写——用户手加的 summary 那时归用户自己维护。
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
    summaries:
      howmuch: Sum
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
    summaries:
      howmuch: Sum
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
    summaries:
      howmuch: Sum
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
// 用 listReal（磁盘真实文件）而不是 list（vault 索引）：索引在目录改名后可能没有旧名文件这一条，
// 索引版列举不到它，删孤儿就变成空操作（2026-10-15 真机复现，snapshotStore.listReal 兜底扫盘）。
// 只删"名字不是当前主题"的 .base：用户手改当前 .base 的内容重建本来就覆盖（确认框里说过），
// 而自建第二视图不是文档化用法——真出现了，重建前看一眼确认框就能救。
function resetViews(store) {
  writeTypes(store);
  for (const topic of listTopics(store)) {
    store.write(topicBase(topic), buildBase(topic));
    for (const p of store.listReal(topic)) {
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
// 一组事实 → callout 列表。**按日期倒序**（之前的实现按出现顺序分组，标题却写着"倒序"——
// 真源是按录入顺序 append 的，先记昨天的再记今天的，页面上就变成了正序。这里显式排一次）。
function timelineCallouts(facts) {
  const byDate = new Map();
  for (const f of facts) {
    if (!byDate.has(f.date)) byDate.set(f.date, []);
    byDate.get(f.date).push(f);
  }
  const lines = [];
  for (const [date, items] of [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
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

function renderTimeline(facts, opts = {}) {
  const lines = [
    opts.title ?? '# 时间线',
    '',
    opts.sub ??
      `> 内核从 \`_真源/\` 自动生成的可视化读模型（${facts.length} 条，按日期倒序）。在 Obsidian 里改这张图没用——重建会覆盖。`,
    '',
    // 这个空行是 callout 的命根子：Obsidian 要求 [!note] 声明前必须有空行，
    // 少一个换行，整段按引用块内纯文本渲染——日期头变成一行字面的 "[!note] 📅 …"。
    // 2026-10-22 真机踩到：分段页页眉（"重建会覆盖"那行）紧跟着第一条 callout，
    // 每个分段页最新的一条都中招。索引页因为隔着「## 最近 20 条」标题才幸免。
    '',
  ];
  return lines.join('\n') + timelineCallouts(facts) + '\n';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTimelineHtml(facts) {
  return timelineHtmlDoc({
    sub: `${facts.length} 条事实 · 按日期倒序 · 由内核自动生成`,
    sections: timelineSections(facts),
  });
}
// 一组事实 → HTML 的 day 区块（日期倒序，与 md 那份保持一致）
function timelineSections(facts) {
  const groups = new Map();
  for (const f of facts) {
    if (!groups.has(f.date)) groups.set(f.date, []);
    groups.get(f.date).push(f);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => {
      const cards = items
        .map((f) => {
          const meta = [
            f.who,
            f.time && `🕐 ${f.time}`,
            f.where && `📍 ${f.where}`,
            f.how && `🔧 ${f.how}`,
          ]
            .filter(Boolean)
            .map(escHtml)
            .join('　');
          // howmuch 按符号着色（2026-10-22）：负=绿（出/减），正值不染。符号语义是**主题级约定**
          // （资金主题 负=出；体重/里程没有符号语义，染红会误示警）——负方向是唯一跨主题一致的，
          // 所以只染它。这里单独拼而不过 escHtml 数组：span 是 HTML，过一遍转义就废了。
          const amount =
            f.howmuch == null
              ? ''
              : Number(f.howmuch) < 0
                ? `${meta ? '　' : ''}📊 <span class="neg">${escHtml(String(f.howmuch))}</span>`
                : `${meta ? '　' : ''}📊 ${escHtml(String(f.howmuch))}`;
          return `<li class="card"><div class="body">${escHtml(f.body)}</div><div class="meta">${meta}${amount}</div></li>`;
        })
        .join('');
      return `<section class="day"><div class="date">${escHtml(date)}</div><ul class="cards">${cards}</ul></section>`;
    })
    .join('');
}

// 一份时间线 HTML 文档。nav 是页面顶部的导航条（分段之间来回跳用），缺省没有。
function timelineHtmlDoc({ title = '事实时间线', sub = '', nav = '', sections }) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    background: #0f1115; color: #e6e8ec; padding: 32px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b93a1; margin: 0 0 28px; font-size: 13px; }
  .nav { max-width: 720px; margin: 0 auto 26px; font-size: 13px; line-height: 1.9; }
  .nav a { color: #8ab4ff; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
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
  .neg { color: #4ade80; font-weight: 600; }
</style>
</head>
<body>
  <h1>${escHtml(title)}</h1>
  <p class="sub">${sub}</p>
  ${nav ? `<div class="nav">${nav}</div>` : ''}
  <div class="timeline">${sections}</div>
</body>
</html>
`;
}

// —— 时间线的分段（2026-10-15：这是为了让它在数据涨到几千条后仍能打开）——
// 以前的形态是"一个主题一份 时间线.md"，倍数是线性的：npm run bench 实测 1000 条 43KB、
// 10000 条 412KB（1 万行）、30000 条 1.2MB。Node 侧算它只要零点几秒，**卡的是宿主**——
// Obsidian 打开一个 1MB 的 callout 列表才会真的僵住。而且每录一条都要重写整份文件，
// 写盘 + 宿主重索引的成本随总量线性上涨（2000 条时每条录入已从 9ms 退化到 37ms）。
//
// 所以按月分段：每个月一份小文件，<主题>/时间线.md 变成索引页（尺寸恒定），
// 录入一条只重写**那一个月** + 索引页 → 每次录入的成本只和那个月有多少条有关，与总量无关。
const timelineSegFile = (topic, month) => `${topic}/时间线-${month}.md`;
const timelineSegHtml = (topic, month) => `${topic}/时间线-${month}.html`;
const monthOf = (date) => (/^\d{4}-\d{2}/.test(String(date ?? '')) ? String(date).slice(0, 7) : '未标日期');
const monthLabel = (month) => (month === '未标日期' ? '未标日期' : `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`);
const TIMELINE_RECENT = 20; // 索引页内嵌的最近条数——它是"打开就看到最近的事"的唯一保证，别调成 0

// 事实按所属年月分组，键倒序（最新月份在前）
function groupByMonth(facts) {
  const segs = new Map();
  for (const f of facts) {
    const m = monthOf(f.date);
    if (!segs.has(m)) segs.set(m, []);
    segs.get(m).push(f);
  }
  return new Map([...segs.entries()].sort((a, b) => b[0].localeCompare(a[0])));
}

function renderTimelineMonth(topic, month, facts, total) {
  const file = `时间线-${month}.md`;
  const sub = `> [← 时间线索引](时间线.md)　|　本月 **${facts.length}** 条 · 全主题 ${total} 条\n> \n> 这是自动生成的可视化读模型，在这里改没用——重建会覆盖。`;
  return renderTimeline(facts, { title: `# 时间线 · ${monthLabel(month)}`, sub });
}

// 索引页：月 份清单 + 最近若干条。**尺寸恒定**是它的设计目标（不随总量上涨）。
function renderTimelineIndex(topic, segs, facts) {
  const months = [...segs.keys()];
  const total = facts.length;
  const lines = [
    '# 时间线',
    '',
    '> 这是**索引页**（自动生成）。时间线按月分段存放——单文件会随着事实变多涨到打不开，',
    '> 分段之后每次录入只重写那一个月。在这里改没用，重建会覆盖。',
    '',
    `- 共 **${total}** 条事实，跨 **${months.length}** 个月${months.length ? `（${months.at(-1)} ~ ${months[0]}）` : ''}`,
    '- 全览：[时间线.html](时间线.html)（浏览器打开）',
    '',
    '## 按月打开',
    '',
  ];
  for (const [month, list] of segs) {
    // 不编码：Obsidian 的 md 链接按 vault 内的名字解析，中文路径百分号编码反而认不出来
    lines.push(`- [${monthLabel(month)} · ${list.length} 条](时间线-${month}.md)`);
  }
  if (!months.length) lines.push('- （还没有事实）');
  const recent = [...facts].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, TIMELINE_RECENT);
  lines.push('', `## 最近 ${TIMELINE_RECENT} 条`, '');
  lines.push(recent.length ? timelineCallouts(recent) : '_没有事实。_', '');
  if (total > recent.length) {
    lines.push(`> [!tip] 更早的 ${total - recent.length} 条在上面对应的月份里。`, '');
  }
  return lines.join('\n');
}

function renderTimelineSegHtml(topic, month, facts, total) {
  return timelineHtmlDoc({
    title: `时间线 · ${monthLabel(month)}`,
    sub: `本月 ${facts.length} 条 · 全主题 ${total} 条 · 由内核自动生成`,
    nav: '<a href="时间线.html">← 索引</a>',
    sections: timelineSections(facts),
  });
}

function renderTimelineIndexHtml(topic, segs, facts) {
  const months = [...segs.keys()];
  // 与 md 索引页同一套"最近 20 条"：html 索引不能只有月份链接——
  // 打开 html 就该看到最近发生的事，否则它得再点进当月分段才算数（2026-10-22 补：
  // 此前 sections 传的是 ''，.timeline 容器从来没填过，纯半成品）。
  const recent = [...facts].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, TIMELINE_RECENT);
  return timelineHtmlDoc({
    sub: `共 ${facts.length} 条事实 · 跨 ${months.length} 个月 · 按月分段`,
    nav: months
      .map((m) => `<a href="${encodeURI(`时间线-${m}.html`)}">${monthLabel(m)}</a>（${segs.get(m).length}）`)
      .join(' · ') || '（还没有事实）',
    sections: recent.length ? timelineSections(recent) : '',
  });
}

// 全量：所有分段 + 两个索引 + 清掉已经没有事实的月份文件（比如那个被删空的月）
function writeTimeline(store, topic) {
  const facts = timelineFacts(store, topic);
  const segs = groupByMonth(facts);
  for (const [month, list] of segs) {
    store.write(timelineSegFile(topic, month), renderTimelineMonth(topic, month, list, facts.length));
    store.write(timelineSegHtml(topic, month), renderTimelineSegHtml(topic, month, list, facts.length));
  }
  const want = new Set([...segs.keys()].flatMap((m) => [timelineSegFile(topic, m), timelineSegHtml(topic, m)]));
  for (const p of store.listReal(topic)) {
    const name = p.split('/').pop();
    if (/^时间线-.+\.(md|html)$/.test(name) && !want.has(p)) store.removeTree(p);
  }
  store.write(topicTimelineMd(topic), renderTimelineIndex(topic, segs, facts));
  store.write(topicTimelineHtml(topic), renderTimelineIndexHtml(topic, segs, facts));
}

// 段级：只重写**被那一条事实影响的月份** + 索引页。录入/删除走这条，成本与总量无关。
// html 索引也重写（它只有链接，尺寸恒定），但 html 分段只动当月那一份。
function writeTimelineSegment(store, topic, month) {
  const facts = timelineFacts(store, topic);
  const segs = groupByMonth(facts);
  const list = segs.get(month) || [];
  const file = timelineSegFile(topic, month);
  const html = timelineSegHtml(topic, month);
  if (!list.length) {
    if (store.exists(file)) store.removeTree(file);
    if (store.exists(html)) store.removeTree(html);
  } else {
    store.write(file, renderTimelineMonth(topic, month, list, facts.length));
    store.write(html, renderTimelineSegHtml(topic, month, list, facts.length));
  }
  store.write(topicTimelineMd(topic), renderTimelineIndex(topic, segs, facts));
  store.write(topicTimelineHtml(topic), renderTimelineIndexHtml(topic, segs, facts));
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
  viewIssues,
  ensureTopic,
  writeTypes,
  resetViews,
  writeTimeline,
  writeTimelineSegment,
  monthOf,
  timelineFacts,
  renderTimeline,
  renderTimelineIndex,
  renderTimelineMonth,
  renderTimelineHtml,
  adaptFact,
  readTruth,
  appendTruth,
  factFile,
  writeFact,
};
