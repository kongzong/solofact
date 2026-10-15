#!/usr/bin/env node
// 内核的无头壳（agent 录入通道，配合 skill/SKILL.md 使用）。
// 写入路径的规则在 core/{fact,vault,scan,record}.js 里，那份实现只有一份，插件壳不许自带校验。
// 设计约束：致命错误拒绝写入（不是写完再报告），Markdown 可以随时从 _真源/ 重建。
// 形态：主题 = 目录。--topic 指定这条事实归到哪个主题，落盘进 <topic>/_真源/facts.ndjson + <topic>/事实/。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderPointerLine } from '../core/fact.js';
import { fsAdapter } from '../core/store.js';
import { DIR, writeTypes, listTopics } from '../core/vault.js';
import { localDay, openSession } from '../core/record.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// init 的护栏：库根的"散落文件"只有这些才敢直接动。主题是任意目录名，目录一律当主题候选放过；
// .obsidian 是宿主自己的。真正要拦的是"--vault 指进了一个装满无关文件的目录"。
const KNOWN_ROOT_FILES = new Set([DIR.report, '_导入拒绝.json']);
const COMMANDS = {
  init: 'init',
  记录: 'record',
  record: 'record',
  体检: 'audit',
  audit: 'audit',
  重建: 'rebuild',
  rebuild: 'rebuild',
  导入: 'import',
  import: 'import',
  // 删除（2026-10-15 加）：唯一的破坏性写入——真源压缩。默认只预览，--yes 才执行。
  删除: 'remove',
  remove: 'remove',
  // 唯一的只读命令：给 agent 在录入前对齐主题名（拼写不一致，按主题的聚合就碎）。
  // 零写入，所以它不算"写入面"的一员。
  主题: 'topics',
  topics: 'topics',
};

const { cmd, flags, rest } = parseArgs(process.argv.slice(2));
const action = COMMANDS[cmd];
const vault = flags.vault || process.env.SOLOFACT_VAULT;
const enums = JSON.parse(readFileSync(path.join(ROOT, 'contract/enums-5w2h.json'), 'utf8'));
const now = Date.now();

if (!action || flags.help || flags.h) help();
else if (!vault) die('缺少 --vault：指向你的 Obsidian 库目录（或设 SOLOFACT_VAULT）。不给多套配置，是为了少一个能配错的地方。');
else run(action);

function run(action) {
  const store = fsAdapter(vault);
  if (action === 'init') return doInit(store);
  if (action === 'record') return doRecord(store);
  if (action === 'remove') return doRemove(store);
  if (action === 'audit') return doAudit(store);
  if (action === 'rebuild') return doRebuild(store);
  if (action === 'import') return doImport(store);
  if (action === 'topics') return doTopics(store);
}

function doInit(store) {
  if (!store.exists('')) die(`${vault} 不存在——--vault 要指向已有的 Obsidian 库目录`);
  const rootFiles = store.list('').filter((p) => !p.includes('/'));
  const strangers = rootFiles.filter((p) => !KNOWN_ROOT_FILES.has(p));
  if (strangers.length && !flags.force) {
    die(`${vault} 根目录有我不认识的文件：${strangers.join(', ')}。确认这是你要动的那个库就加 --force。`);
  }
  store.mkdir(DIR.obsidian);
  if (!store.exists(DIR.types)) writeTypes(store);
  const topics = listTopics(store);
  console.log(`✓ 已就绪：${vault}`);
  console.log(`  ${DIR.types} 就位（when/recorded→date、howmuch→number；所有主题共享这一份）`);
  console.log(`  已有 ${topics.length} 个主题${topics.length ? `：${topics.join(', ')}` : '（空）'}`);
  console.log('  下一步：记录时带 --topic <主题>，会自动建 <主题>/ 目录、真源、<主题>.base。');
}

// 参数 → 表单式的输入对象。when 的"今天"兜底在壳里做，不在 core 做：
// 记今天刚发生的事是人的场景，导入没有 when 是机器的场景，两者默认值不同，core 不许猜。
function recordInput() {
  const body = rest.join(' ').trim() || flags.what;
  if (!body) die('缺正文：solofact 记录 --vault <库> --topic 潮汕6日游 --who 我自己 --when 2026-10-12 "今天跑了 5 公里"');
  const text = flags.what || body;
  return {
    topic: flags.topic || flags.主题 || flags.theme,
    id: flags.id,
    who: flags.who,
    when: flags.when || flags.occurred || localDay(now),
    time: flags.time,
    what: text,
    content: text,
    where: flags.where,
    why: flags.why,
    how: flags.how,
    howmuch: flags.howmuch,
    recorded: flags.recorded,
    tags: flags.tags ? String(flags.tags).split(',').map((t) => t.trim()).filter(Boolean) : undefined,
  };
}

function doRecord(store) {
  const result = openSession(store, { enums, now }).record(recordInput());
  if (!result.written) {
    console.error(`✗ 拒绝写入${result.topic ? ` 主题「${result.topic}」` : ''}：契约判定 ${result.fatal.length} 条致命错误。改字段，不是改脚本。`);
    for (const i of result.fatal) console.error(`  ${i.code} — ${i.message}`);
    process.exit(1);
  }

  // 真源先落地，Markdown 只是读模型；中间断了跑一次 重建 就补齐（顺序在 core/record.js，不在这里）
  console.log(`✓ ${result.topic}/事实/${result.fact.id}.md`);
  console.log(`  ${renderPointerLine(result.fact)}`);
  for (const i of result.warn) console.log(`  ⚠ ${i.code} — ${i.message}`);
  if (result.warn.length) console.log('  告警不阻断写入，但体检会一直报，直到它消失或你确认它是对的');
}

// 只读：列出现有主题和各主题的事实数。录入前先跑它——主题名和库里的拼写一致，
// "按谁/按方式"的聚合才不会因为「潮汕六日游 / 潮汕6日游」这种漂移碎成两摊。
function doTopics(store) {
  if (!store.exists('')) die(`${vault} 不存在——--vault 要指向已有的 Obsidian 库目录`);
  const topics = listTopics(store);
  if (!topics.length) {
    console.log('还没有任何主题：记录时带 --topic <主题> 就会建出来。');
    return;
  }
  console.log(`${topics.length} 个主题：`);
  for (const t of topics) {
    const n = store.list(`${t}/${DIR.facts}`).filter((p) => p.endsWith('.md')).length;
    console.log(`  ${t} — ${n} 条`);
  }
}

// 删除：唯一的破坏性写入。默认 dryRun 预览（who/when/what 打给人看），--yes 才真删——
// 真源压缩不可逆（恢复靠库自己的 git），agent 必须先让用户过目，这跟"致命错误拒绝写入"
// 是同一种哲学：危险动作不许静默完成。删完 md 与时间线由 core 的 remove 一并处理。
function doRemove(store) {
  const topic = flags.topic || flags.主题 || flags.theme;
  const id = rest[0] || flags.id;
  if (!topic || !id) {
    die('删除需要主题和事实 id：solofact 删除 --vault <库> --topic <主题> <id> [--yes]（先预览，确认后才删）');
  }
  const session = openSession(store, { enums, now });
  if (!flags.yes) {
    const p = session.remove({ topic, id, dryRun: true });
    if (p.fatal.length) {
      console.error(`✗ ${p.fatal[0].message}`);
      process.exit(1);
    }
    console.log(`将要从「${topic}」删除这条事实（真源压缩，不可逆——恢复靠库自己的 git）：`);
    console.log(`  ${renderPointerLine(p.fact)}`);
    console.log('  确认删除：重跑同一命令加 --yes');
    return;
  }
  const r = session.remove({ topic, id });
  if (!r.removed) {
    console.error(`✗ 拒绝删除：${r.fatal.map((i) => i.code).join(' ')}`);
    for (const i of r.fatal) console.error(`  ${i.code} — ${i.message}`);
    process.exit(1);
  }
  console.log(`✓ 已从「${topic}」删除 ${id}`);
  console.log(`  ${renderPointerLine(r.fact)}`);
  console.log('  该主题真源已压缩、事实 md 已删、时间线已刷新。删错了？库若在 git 里，从历史恢复。');
}

function doAudit(store) {
  const { rows, fatal, warn, fileCount, topics } = openSession(store, { enums, now }).auditAndReport('事实库');
  console.log(`主题 ${topics.length}｜事实 ${rows.length} 条｜致命 ${fatal.length}｜告警 ${warn.length}｜事实文件 ${fileCount}`);
  for (const i of fatal.slice(0, 20)) console.log(`  ✗ ${i.code} <${i.where}> — ${i.message}`);
  if (fatal.length > 20) console.log(`  …其余 ${fatal.length - 20} 条见 ${DIR.report}`);
  for (const i of warn.slice(0, 10)) console.log(`  ⚠ ${i.code} <${i.where}> — ${i.message}`);
  if (!topics.length) console.log('  还没有任何主题：用 `记录 --topic <主题> …` 建第一个。');
  else if (!fatal.length && !warn.length) console.log('  全库干净。');
  console.log(`报告：${DIR.report}`);
  process.exitCode = fatal.length ? 1 : 0;
}

// 重建，不修：序列在 core/record.js，插件的"从真源重建"命令走的是同一个函数
function doRebuild(store) {
  const r = openSession(store, { enums, now }).rebuild();
  console.log(`✓ 重建 ${r.topics.length} 个主题、${r.written} 个事实文件（真源共 ${r.truthRows} 行）`);
  if (r.skipped.length) console.log(`  !! 真源里有重复 id，只写了第一份：${r.skipped.join(', ')}`);
  console.log(`  体检：致命 ${r.fatal.length}｜告警 ${r.warn.length}——重建不修数据，坏数据照样会报出来`);
  process.exitCode = r.fatal.length ? 1 : 0;
}

function doImport(store) {
  const file = rest[0] || flags.file;
  if (!file) die('导入需要一个 NDJSON 文件路径：solofact 导入 --vault <库> [--topic <主题>] facts.ndjson');
  const session = openSession(store, { enums, now });
  const lines = readFileSync(path.resolve(file), 'utf8').trim().split('\n').filter(Boolean);
  const rejected = [];
  let ok = 0;
  for (const [i, line] of lines.entries()) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      rejected.push({ at: `第 ${i + 1} 行`, topic: '—', id: '—', codes: ['E_BAD_JSON'], messages: [String(e.message)] });
      continue;
    }
    // 每行自带 topic；也可用 --topic 一次性套给所有行
    if (flags.topic && raw.topic == null) raw.topic = flags.topic;
    const r = session.record(raw);
    if (r.written) {
      ok++;
      continue;
    }
    // 撞 id 单独判定，且 fatal 里连它一起报：否则第二条错误码会盖住"这条已经在库里"这个最要紧的事实
    rejected.push({
      at: `第 ${i + 1} 行`,
      topic: r.topic || raw.topic || '—',
      id: r.fact.id || '—',
      codes: [...new Set(r.fatal.map((x) => x.code))],
      messages: r.fatal.map((x) => x.message),
    });
  }
  console.log(`导入 ${file}：${lines.length} 行 → 写入 ${ok} 条，拒绝 ${rejected.length} 条`);
  for (const r of rejected.slice(0, 15)) {
    console.log(`  ✗ ${r.at} ${r.topic}/${r.id} ${r.codes.join(' ')} — ${r.messages.join('；')}`);
  }
  if (rejected.length > 15) console.log(`  …其余 ${rejected.length - 15} 条省略`);
  if (rejected.length) {
    store.write('_导入拒绝.json', JSON.stringify(rejected, null, 2));
    console.log('  拒绝清单：_导入拒绝.json（改原文件再导一次，别改库里的 Markdown）');
    process.exitCode = 1;
  }
}

// —— 参数解析 ——

function parseArgs(argv) {
  const [cmd = '', ...rest] = argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
      continue;
    }
    pos.push(a);
  }
  return { cmd, flags, rest: pos };
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

function help() {
  console.log(`solofact — Obsidian 库上的事实层（5W2H · 主题=目录）。写入路径只有这一条命令面（外加一个只读的「主题」）。

  solofact init    --vault <库目录> [--force]
  solofact 记录    --vault <库> --topic 潮汕6日游 --who 我自己 --when 2026-10-12 [--time 09:30] \\
                  [--where 江边] [--why 记录习惯] [--how 运动] [--howmuch 5] [--tags 日常] "跑了 5 公里"
  solofact 删除    --vault <库> --topic <主题> <id> [--yes]  # 唯一的破坏性写入：默认只预览，--yes 才真删（真源压缩不可逆）
  solofact 主题    --vault <库>          # 只读：列出现有主题和各主题事实数（录入前先对齐主题名）
  solofact 体检    --vault <库>          # 跨所有主题汇总，写 _体检.md；有致命错误退出码 1
  solofact 重建    --vault <库>          # 每个主题的 Markdown 从它自己的 _真源/ 重生成
  solofact 导入    --vault <库> [--topic <主题>] <file.ndjson>  # 走同一套校验，致命的那行拒绝入库

主题 = 一个自包含目录：--topic 潮汕6日游 会建 潮汕6日游/{_真源,事实,潮汕6日游.base}。同主题内 howmuch 天然同义——没有 type、不校验单位，符号也是主题级约定（资金主题 负=出、正=进），核心只查是不是数字。
规则在 contract/enums-5w2h.json（必填 who/when/what，枚举从库内历史事实抽，不预设场景）。
致命 = 必须改数据；告警 = 需要人看一眼。护栏：不要修改脚本本体；改完规则跑一次 体检。`);
}
