// "一个内核两个壳"靠自觉是守不住的：分叉的表现不是崩溃，是两份规则悄悄给出不同答案。
// 所以这里做的不是行为测试，是源码级断言——插件壳一旦开始自己写校验、自己拼枚举、自己动磁盘，
// 这条测试先红，比任何一次"看起来没出问题"的验收都早。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enums = JSON.parse(readFileSync(path.join(root, 'contract/enums-5w2h.json'), 'utf8'));

// 允许 import 的东西：宿主 API、快照 store、布局、会话、契约数据。
// 名单里没有 ../core/store.js：它 import node:fs，打进 main.js 会让 Obsidian 加载即失败（实测到的）。
// 名单里没有 ../core/fact.js／scan.js：内核的规则只能经 openSession 用，直接 import 就是想自己判对错。
const ALLOWED = new Set(['obsidian', '../core/rel.js', '../core/vault.js', '../core/adapters/vault.js', '../core/record.js', '../contract/enums-5w2h.json']);
// core 的全部导出名：插件壳一个都不许 import，它只准通过 snapshotStore/openSession 两个入口用内核
const CORE_EXPORTS = new Set([
  // core/fact.js
  'makeId', 'idParts', 'parseDate', 'dayString', 'parseTime', 'parseFrontmatter', 'dumpFrontmatter',
  'linkName', 'normalize', 'validate', 'renderFactFile', 'parseFactFile', 'renderPointerLine', 'duplicateDraft',
  // core/vault.js
  'DIR', 'topicFacts', 'topicTruthFile', 'topicBase', 'topicTimelineMd', 'topicTimelineHtml',
  'TYPES_5W2H', 'buildBase', 'listTopics', 'ensureTopic', 'writeTypes', 'resetViews', 'writeTimeline',
  'renderTimeline', 'renderTimelineHtml', 'adaptFact', 'readTruth', 'appendTruth', 'factFile', 'writeFact',
  // core/scan.js
  'scanVault', 'reportLines', 'writeReport', 'tally', 'countFiles',
  // core/record.js
  'localDay', 'localHHMM', 'randHex4', 'makeFact', 'openSession',
  // core/store.js / core/rel.js
  'fsAdapter', 'assertRel',
  // core/adapters/vault.js
  'snapshotStore', 'needsContent', 'isConfigPath', 'CONFIG_FILES',
]);
const ALLOWED_IMPORTS = new Set(['DIR', 'snapshotStore', 'openSession']);

const sources = (() => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []
    );
  return walk(path.join(root, 'plugin'));
})();

test('插件壳存在，且只有 TS 源码这一个入口', () => {
  assert.ok(sources.length >= 1, 'plugin/ 里没有源码');
});

test('插件壳不碰 node:fs、不碰 node:path：写入只能经过快照 store', () => {
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/from ['"]node:|require\(['"]node:|require\(['"]fs['"]\)/.test(text), false, `${path.basename(file)} 直接引用了 node 内置模块`);
  }
});

test('插件壳 import 的东西限定在名单内：内核只能经 snapshotStore/openSession 两个入口用', () => {
  const offenders = [];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
      if (!ALLOWED.has(m[1])) offenders.push(`${path.basename(file)} → ${m[1]}`);
    }
    for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](\.\.\/core\/[^'"]+)['"]/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (name && CORE_EXPORTS.has(name) && !ALLOWED_IMPORTS.has(name)) offenders.push(`${path.basename(file)} 直接用了内核函数 ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('；'));
});

test('插件壳不许自带第二份规则：一个校验/渲染/落盘函数都不许定义', () => {
  const RULES = [
    'validate', 'normalize', 'makeId', 'dumpFrontmatter', 'parseFrontmatter', 'renderFactFile',
    'appendTruth', 'writeFact', 'buildBase',
  ];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const name of RULES) {
      assert.equal(
        new RegExp(`(function\\s+${name}\\b|(const|let|var)\\s+${name}\\s*=|\\b${name}\\s*\\([^)]*\\)\\s*:\\s*(?:string|number|void|boolean)\\s*[{=]|\\b${name}\\s*=\\s*(?:function|\\())`).test(text),
        false,
        `${path.basename(file)} 定义了 ${name}()——规则只有一份，在 core/ 里`
      );
    }
  }
});

test('插件壳不许硬编码枚举值：表单选项一律来自 contract/enums-5w2h.json', () => {
  const keys = Object.values(enums.enums).flatMap((spec) => Object.keys(spec));
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    // 只看字符串字面量里的枚举 key：5w2h 的 enums 故意为空（枚举从库内历史事实抽），
    // 这里只是守住"壳不在源码里写死封闭枚举值"的护栏——枚举只有一个来源。
    const q = (k, s) => text.includes(`${s}${k}${s}`);
    const hit = keys.filter((k) => q(k, "'") || q(k, '"') || q(k, '`'));
    assert.deepEqual(hit, [], `${path.basename(file)} 写死了枚举值：${hit.join(', ')}——枚举只有一个来源`);
  }
});

test('用户点出来的异步路径不许静默吞异常：点了必须有反应', () => {
  const text = readFileSync(path.join(root, 'plugin', 'main.ts'), 'utf8');
  // 从方法名取到配平的函数体：括号计数够了，这里只要判断"体里有没有 catch"
  function bodyOf(name) {
    // 只认定义行：`void this.submit()` 这种调用点在文件里出现得更早，拿它找到的"{\" 是别人的函数体
    const re = new RegExp(`^[ \\t]*(?:private[ \\t]+|async[ \\t]+|static[ \\t]+)*${name}[ \\t]*\\([^)]*\\)[^{;]*\\{`, 'm');
    const m = text.match(re);
    assert.ok(m, `找不到 ${name}() 的定义——接线被改名了，这条保护得跟着改，不许直接删测试`);
    let depth = 1;
    let end = m.index + m[0].length;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    return text.slice(m.index + m[0].length - 1, end + 1);
  }
  // 真机上"点记下来没反应"：record 抛出的异常落在 await 链里，而调用点写的是 void this.submit()，
  // Promise 的拒绝没人接，界面一个字都不说。这三条是用户能点到的全部路径。
  for (const name of ['submit', 'rebuildFromTruth', 'runAudit']) {
    assert.match(bodyOf(name), /catch/, `${name}() 里没有 catch：异常会被吞掉，用户只会看到"无响应"`);
  }
  // 同理，任何被 void 丢弃的调用，目标方法自己必须接住异常
  for (const m of text.matchAll(/void this\.(\w+)\(/g)) {
    assert.match(bodyOf(m[1]), /catch/, `this.${m[1]}() 被 void 丢弃异常，又自己没接住`);
  }
});

test('插件 manifest 是合法 JSON，且声明的 id 与安装目录名一致', () => {
  const m = JSON.parse(readFileSync(path.join(root, 'plugin', 'manifest.json'), 'utf8'));
  assert.equal(m.id, 'solofact');
  assert.equal(typeof m.minAppVersion, 'string');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});

test('致命错误必须标回具体输入框：showErrors 按 field 映射行并加标红 class（缺必填/主题行要变红）', () => {
  const text = readFileSync(path.join(root, 'plugin', 'main.ts'), 'utf8');
  function bodyOf(name) {
    const re = new RegExp(`^[ \\t]*(?:private[ \\t]+|async[ \\t]+|static[ \\t]+)*${name}[ \\t]*\\([^)]*\\)[^{;]*\\{`, 'm');
    const m = text.match(re);
    assert.ok(m, `找不到 ${name}() 的定义——接线被改名了，这条保护得跟着改，不许直接删测试`);
    let depth = 1;
    let end = m.index + m[0].length;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    return text.slice(m.index + m[0].length - 1, end + 1);
  }
  const body = bodyOf('showErrors');
  // 真机验收（2026-10-12）发现：客户填含"/"的名字，表单不关但客户行没变红——
  // 根因是标红视觉没生效，不是映射逻辑错（validate 返回的 field='customer' 已脚本核实）。
  // 这条静态守护锁住"映射逻辑本身不退化"：每条致命 issue 都要找到对应输入框并加红。
  assert.match(body, /this\.settings\[i\.field\]/, 'showErrors 必须按 i.field 找到对应输入框（主题→主题行 / who→who 行）');
  assert.match(body, /descEl\.setText/, '必须在输入框描述里写出错误码');
  assert.match(body, /markRowBad\(/, '必须给该行标红（直接设内联样式，不依赖注入的全局 CSS，规避加载期崩溃）');
});

test('5W2H 表单：两阶段（先主题后事实），必填 who/when/what，候选按主题作用域，输入框无占位符', () => {
  const text = readFileSync(path.join(root, 'plugin', 'main.ts'), 'utf8');
  // 用户定调（2026-10-12）：记录要自由，who 做成输选框——能从历史 who 里选，也能随手新建手工填。
  assert.match(text, /import enums5w2h from '\.\.\/contract\/enums-5w2h\.json'/, '必须用 5W2H 契约（contract/enums-5w2h.json）');
  assert.doesNotMatch(text, /shape:/, 'v01 的 shape 参数已移除，内核只有 5W2H 单形态');
  assert.doesNotMatch(text, /fact-types\.json/, 'type 这一级已去掉，插件不该再引 fact-types.json');
  assert.doesNotMatch(text, /typeTemplate/, 'type 模板已去掉，插件不该再引 typeTemplate');
  assert.match(text, /this\.settings\.who\s*=/, 'who 输入框必须存在（必填）');
  assert.match(text, /this\.settings\.when\s*=/, 'when 输入框必须存在（必填）');
  assert.match(text, /this\.settings\.what\s*=/, 'what 输入框必须存在（必填）');
  assert.match(text, /this\.settings\.topic\s*=/, '主题输入框必须存在（必填，= 目录）');
  // 两阶段（2026-10-13 用户定调）：主题的创建/选择与事实录入分开——先定主题，再录事实。
  assert.match(text, /private stage: 'topic' \| 'fact'/, '表单必须分两个阶段：先选/建主题，再录事实');
  assert.match(text, /this\.attachCombo\(t\.inputEl, this\.plugin\.topicsOf\(\)\)/, '阶段一主题候选必须来自现有主题目录（topicsOf），同时支持自由新建');
  assert.match(text, /this\.attachCombo\(t\.inputEl, this\.historyOf\('who', topic\)\)/, '阶段二主题已定：who 候选直接按该主题取（不再有随时重挂的中间态）');
  assert.match(text, /topicsOf\(\): string\[\]/, 'topicsOf 必须存在——列出现有主题目录名');
  assert.match(text, /private historyOf\(/, 'historyOf 必须存在——读库里已有的字段值做候选');
  // 用户定调（2026-10-12）：枚举按「同主题」取，不跨主题混。主题=目录后，作用域 = <topic>/事实/。
  assert.match(text, /f\.path\.startsWith\(prefix\)/, 'historyOf 必须用 prefix 限定到该主题目录——候选只来自该主题历史');
  // 用户定调（2026-10-13）：字段描述已在行内，输入框里不再放占位提示（唯一例外是主题框的阶段一引导）。
  assert.ok((text.match(/setPlaceholder\(/g) ?? []).length <= 1, '5W2H 输入框不设占位符：提示走字段描述，不塞进输入框');
});

test('改回视图文件名必须在原位：不许用 fileManager.renameFile（2026-10-15 真机：文件跑到库根去了）', () => {
  const text = readFileSync(path.join(root, 'plugin', 'main.ts'), 'utf8');
  // fileManager.renameFile 的第二个参数是**文件名不是路径**：它会把文件挪到"新文件的默认位置"
  // （实际就是库根目录），原文件夹里反而空了。用户点了「改回 公司记账.base」，名字改对了、
  // 位置却跑到了根目录——主题目录里依然没有视图入口，等于修了个寂寞。改名的正确写法是
  // vault.rename(file, 完整新路径)，linh就地改名、路径不变。这条从源头禁掉那个 API。
  assert.doesNotMatch(text, /fileManager\.renameFile\(/, '改名请用 app.vault.rename(file, 完整路径)——fileManager.renameFile 会把文件挪到根目录');
  // 反向确认那处确实是就地改（带目录前缀的完整路径），不是只给一个文件名
  assert.match(text, /vault\.rename\(file, `\$\{topic\}\/\$\{topic\}\.base`\)/, '改回必须是 <主题>/<主题>.base 这条完整路径');
});

test('不留空白按钮：addButton 回调不许条件早退（2026-10-15 真机：编辑表单漏出空壳按钮）', () => {
  const text = readFileSync(path.join(root, 'plugin', 'main.ts'), 'utf8');
  // Obsidian 的 Setting.addButton 先建 DOM 再执行回调：回调里 if (...) return 只是不给它文字，
  // 按钮照样渲染成一个空壳——编辑模式隐藏「记下来并继续」时就是这么漏出来的，用户当场看到
  // 一颗没字的按钮。想隐藏按钮必须整颗不建（不调用 addButton），所以这里从源头禁掉回调早退。
  const bad = [...text.matchAll(/\.addButton\(\(([^)]*)\) => \{\s*(?:\/\/[^\n]*\s*)*if\s*\(/g)];
  assert.deepEqual(bad.map((m) => m[0].slice(0, 40)), [], 'addButton 的回调不许以条件早退——会留下没有文字的空按钮');
  // 反向确认那处确实是"整颗不建"而不是"建了不说话"
  assert.match(text, /if \(!this\.editing\) \{[\s\S]{0,220}?bar\.addButton\(/, '连记按钮必须是编辑模式下整颗不建');
});
