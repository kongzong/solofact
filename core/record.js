// 写入序列：参数 → 事实 → 校验 → 拒绝或落盘。CLI 壳和插件壳共用这一份。
// 抽出来的理由不是"少写重复代码"：落盘顺序（真源先于 Markdown）本身就是规则的一部分，
// 两个壳各写一遍迟早会分叉，而分叉的后果是"Markdown 存在但真源没有这一行"——那正是本项目要消灭的静默错误。
// 本文件不 import 任何宿主 API：随机数用 globalThis.crypto（Node 和 Obsidian 移动端都有）。
//
// 主题 = 目录：每条 record() 带一个 topic，落盘进 <topic>/_真源/facts.ndjson + <topic>/事实/。
// 没有 type、没有主题注册表——同主题内 howmuch 天然同义，type 这一级整个去掉。
import { makeId, duplicateDraft, parseDate, validate } from './fact.js';
import {
  DIR,
  ensureTopic,
  resetViews,
  listTopics,
  topicFacts,
  topicTruthFile,
  readTruth,
  appendTruth,
  factFile,
  writeFact,
  writeTimeline,
} from './vault.js';
import { scanVault, reportLines, writeReport, tally } from './scan.js';

const pad = (n) => String(n).padStart(2, '0');

function localDay(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localHHMM(ms = Date.now()) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function randHex4() {
  const bytes = new Uint8Array(2);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 输入 → 事实。三条法律写在这里，不在壳里：
// 1. **when 必须由壳给**（CLI 用 --when 或今天，插件表单给日期框的值）。
//    这里不兜底：给导入数据编一个"今天"就是把未知当已知，那是编数据，而且是原样保留的旧行为。
//    缺了就交给契约报 E_MISSING_REQUIRED。
// 2. 不许拿写入时刻冒充发生时刻——只有发生日期就是今天，才允许用当前时间填 time，否则写 00:00。
// 3. 不猜字段名（body→content 是仅有的别名；howmuch 会被转成数字）。
// 传进来的事实如果已经带 id/when/time，这里就是原样收下（幂等），所以真源回放也走同一个函数。
function makeFact(input, { now = Date.now() } = {}) {
  const fact = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'body') fact.content = value;
    else if (key === 'howmuch') fact.howmuch = Number(value);
    else fact[key] = value;
  }
  // when 是事实的发生日
  const daySrc = fact.when;
  if (!fact.time && parseDate(daySrc)) fact.time = daySrc === localDay(now) ? localHHMM(now) : '00:00';
  if (!fact.recorded) fact.recorded = localDay(now);
  if (!fact.tags) fact.tags = ['fact'];
  // 5w2h 的 what 既是必填字段也是正文：规范成 content，渲染层只认 content
  if (fact.what && !fact.content) fact.content = fact.what;
  if (!fact.id && parseDate(daySrc)) fact.id = makeId(daySrc, fact.time, randHex4());
  return fact;
}

// 主题名 = 目录名：复用契约的非法字符（含 /），再挡"以 . 开头"（会变隐藏目录/撞 .obsidian）。
// assertRel 另有一道关挡 ../ 越界，两道门都要在，否则插件壳成了唯一能写出库外路径的那扇门。
function topicProblem(topic, enums) {
  if (!topic) return '主题不能为空——用 --topic 指定这条事实归到哪个主题目录';
  const bad = (enums.name_illegal_chars || []).filter((c) => topic.includes(c));
  if (bad.length) return `主题名含非法字符 ${bad.join(' ')}（主题是目录名，不能带这些）`;
  if (topic.startsWith('.')) return '主题名不能以 . 开头（会变成隐藏目录，或撞上 .obsidian）';
  if (topic === '_真源' || topic === DIR.facts) return `主题名「${topic}」是保留目录名`;
  return null;
}

// 会话建立时主题可能还没建（第一条录入就要能建主题），所以该主题真源缺失在这里容忍；
// 而 体检/重建 走 readTruth，缺真源就直接抛——那条路径没有"也许还没建库"的余地。
function readTruthIfAny(store, topic) {
  if (!store.exists(`${topic}/_真源/facts.ndjson`)) return [];
  return readTruth(store, topic);
}

// 一次会话：一份枚举 + 每个主题一份"已写 id"缓存。id 只需主题内唯一（同日期同分钟同随机的碰撞按主题查）。
function openSession(store, { enums, now = Date.now() }) {
  const ctx = { enums, now };
  const idSets = new Map();
  const topicIdSet = (topic) => {
    if (!idSets.has(topic)) idSets.set(topic, new Set(readTruthIfAny(store, topic).map((f) => f.id)));
    return idSets.get(topic);
  };

  // 真源只在"这是一条新事实"时追加。重建读的就是真源，再写回去等于把真源越写越厚——
  // 跑一次翻一倍，第二次重建就会报"真源里有重复 id"，那是我们自己造的脏数据。
  // timeline=false 是重建专用：逐条刷时间线是 O(n²)，重建末尾 resetViews 统一刷一次即可。
  // 录入路径必须刷——时间线是静态读模型，不刷就永远停在建主题那一刻的空态。
  function commit(topic, fact, { toTruth = true, timeline = true } = {}) {
    if (toTruth) appendTruth(store, topic, fact);
    writeFact(store, topic, fact, enums);
    if (timeline) writeTimeline(store, topic);
    topicIdSet(topic).add(fact.id);
  }

  // 致命 = 一个字节都不写。返回值里的 fatal 交给壳决定怎么吓人（CLI 打印并 exit 1，插件标红输入框）。
  function record(input) {
    const topic = String(input.topic ?? '').trim();
    const problem = topicProblem(topic, enums);
    if (problem) {
      const issue = { code: topic ? 'E_BAD_TOPIC' : 'E_MISSING_TOPIC', message: problem, field: 'topic' };
      return { topic, fact: {}, issues: [issue], fatal: [issue], warn: [], written: false };
    }
    ensureTopic(store, topic);
    const { topic: _drop, ...rest } = input;
    const fact = makeFact(rest, { now });
    const issues = validate(fact, ctx);
    const fatal = issues.filter((i) => i.code.startsWith('E_'));
    if (topicIdSet(topic).has(fact.id) || store.exists(factFile(topic, fact.id))) {
      fatal.push({ code: 'E_DUPLICATE_ID', message: `id ${fact.id} 已在主题「${topic}」里，覆盖等于静默丢掉一条事实`, field: 'id' });
    }
    if (fatal.length) return { topic, fact, issues, fatal, warn: issues.filter((i) => i.code.startsWith('W_')), written: false };
    commit(topic, fact);
    return { topic, fact, issues, fatal: [], warn: issues.filter((i) => i.code.startsWith('W_')), written: true };
  }

  function audit() {
    const scan = scanVault(store, { enums, now });
    const { fatal, warn } = tally(scan.rows);
    return { rows: scan.rows, fatal, warn, fileCount: scan.fileCount, topics: scan.topics };
  }

  // 删除一条事实（2026-10-15 加）。为什么允许它存在：记错了没有任何产品化的纠正方式时，
  // 用户会不敢记——"记错收拾不了"比录入摩擦更隐蔽，也更致命。删掉的事实从世界上消失，
  // 恢复只能靠库自己的 git，所以壳必须先 dryRun 预览、人确认后才真删。
  //
  // 真源压缩重写是整个 core 里唯一一次非 append 的真源写（append-only 的正当例外：显式删除，
  // 不是静默覆盖）。读模型（md / 时间线）跟着删和刷，与"真源才是事实"不矛盾——
  // 矛盾的是另一种形态：md 被手删、真源还在，下次重建把它复活（那个洞由这个命令补上）。
  function remove(input) {
    const topic = String(input.topic ?? '').trim();
    const id = String(input.id ?? '').trim();
    const problem = topicProblem(topic, enums);
    if (problem) {
      const issue = { code: topic ? 'E_BAD_TOPIC' : 'E_MISSING_TOPIC', message: problem, field: 'topic' };
      return { topic, removed: false, fact: null, fatal: [issue], warn: [] };
    }
    if (!id) {
      return { topic, removed: false, fact: null, fatal: [{ code: 'E_MISSING_ID', message: '删除需要事实 id（f-YYYYMMDD-HHmm-4hex）', field: 'id' }], warn: [] };
    }
    const facts = readTruthIfAny(store, topic);
    const target = facts.find((f) => f.id === id) || null;
    if (!target) {
      return { topic, removed: false, fact: null, fatal: [{ code: 'E_NO_SUCH_FACT', message: `主题「${topic}」里没有 id 为 ${id} 的事实`, field: 'id' }], warn: [] };
    }
    if (input.dryRun === true) {
      return { topic, removed: false, fact: target, fatal: [], warn: [] };
    }
    const kept = facts.filter((f) => f.id !== id);
    // 压缩重写真源：删空就留空文件（和 init 的初始态一致），不留尾随空行
    store.write(topicTruthFile(topic), kept.map((f) => JSON.stringify(f)).join('\n') + (kept.length ? '\n' : ''));
    store.removeTree(factFile(topic, id));
    writeTimeline(store, topic);
    topicIdSet(topic).delete(id);
    return { topic, removed: true, fact: target, fatal: [], warn: [] };
  }

  function auditAndReport(title) {
    const result = audit();
    writeReport(store, reportLines({ title, vault: store.label, enums, now, rows: result.rows, topics: result.topics }));
    return result;
  }

  // 重建，不修：每个主题的 Markdown、视图全部从它自己的 _真源/ 重新生成。真源才是事实。
  // 只有这条路径会覆盖 <主题>.base／types.json——记录一条事实不会（见 ensureTopic 的"只在缺失时写"）。
  function rebuild() {
    const topics = listTopics(store);
    let written = 0;
    let truthRows = 0;
    const skipped = [];
    for (const topic of topics) {
      const facts = readTruth(store, topic);
      store.removeTree(topicFacts(topic));
      ensureTopic(store, topic);
      const seen = new Set();
      for (const f of facts) {
        if (seen.has(f.id)) {
          skipped.push(`${topic}/${f.id}`);
          continue;
        }
        seen.add(f.id);
        commit(topic, f, { toTruth: false });
      }
      written += seen.size;
      truthRows += facts.length;
    }
    resetViews(store);
    return { written, truthRows, skipped, topics, ...auditAndReport('重建后的事实库') };
  }

  // 复制/编辑这条事实的底稿（2026-10-15）：**取自真源，不取自 Markdown**。
  // （剥 id/time/recorded、when 照旧——约定和单测都在 core/fact.js#duplicateDraft。）
  // 挂 session 而不是让壳直接 import fact.js：内核函数只能经这道门用（plugin.test.js 的守卫）。
  //
  // 为什么不用 md 当底稿（真机教训，同一天改的）：md 是读模型，用户手改过就可能缺字段——
  // 真机里一条被手改成 what 空的事实，走 md 底稿会被 validate 判 E_MISSING_REQUIRED 拒绝，
  // 编辑/复制直接提示"读不了契约"。而**最需要编辑的偏偏是记错的那条**：手改 md 的人正是
  // 想改内容的人，把他挡在门外等于堵死纠正路径，还和"手改 md 不算数"的语义自相矛盾
  // （既然不算数，就不该拿它当底稿）。真源那条写入时就过过校验，永远完整。
  // 顺带：真源在快照里本来就要读（bodies:false 也读），改这条不增加读面。
  //
  // 真源里找不到这条 → null（孤儿 md：手改过 id/文件名，或真源行被人工删过），壳提示先跑体检。
  // 这里不做 validate 拦截：真源里的坏记录恰恰是最该被编辑修好的对象，宽容放行。
  function duplicateDraftFromTruth(topic, id) {
    const target = readTruthIfAny(store, topic).find((f) => f.id === id);
    return target ? duplicateDraft(target) : null;
  }

  return { store, enums, now, ctx, record, remove, duplicateDraftFromTruth, audit, auditAndReport, rebuild };
}

export { localDay, localHHMM, randHex4, makeFact, openSession };
