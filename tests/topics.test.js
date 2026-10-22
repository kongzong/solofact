// 主题=目录：这一版形态的行为测试。核心命题——
//   每个主题是一个自包含目录（真源 + 事实 md + <主题>.base），
//   没有 type、没有单位校验，同主题内 howmuch 天然同义，id 只需主题内唯一。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsAdapter } from '../core/store.js';
import { openSession } from '../core/record.js';
import { listTopics } from '../core/vault.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enums = JSON.parse(readFileSync(path.join(root, 'contract/enums-5w2h.json'), 'utf8'));
// 固定"现在"，让 when 用过去的日期、不撞 E_FUTURE_DATE / E_RECORDED_BEFORE
const NOW = new Date('2026-10-13T12:00:00').getTime();

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-topics-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('record 建主题自包含目录：真源 + 事实 md + <主题>.base + 根级 types.json', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const r = openSession(store, { enums, now: NOW }).record({
      topic: '潮汕6日游', who: '我自己', when: '2026-09-01', time: '10:00', what: '抵达汕头，小公园逛吃', howmuch: 1,
    });
    assert.equal(r.written, true, JSON.stringify(r.fatal));
    assert.equal(r.topic, '潮汕6日游');
    assert.ok(existsSync(path.join(dir, '潮汕6日游/_真源/facts.ndjson')), '主题真源应在');
    assert.ok(existsSync(path.join(dir, '潮汕6日游/潮汕6日游.base')), '主题 .base 应在');
    assert.ok(existsSync(path.join(dir, '.obsidian/types.json')), '根级 types.json 应在（所有主题共享）');
    assert.equal(readdirSync(path.join(dir, '潮汕6日游/事实')).length, 1, '一条事实一个文件');
    const fact = JSON.parse(readFileSync(path.join(dir, '潮汕6日游/_真源/facts.ndjson'), 'utf8').trim());
    assert.equal(fact.who, '我自己');
    assert.equal(fact.howmuch, 1);
    assert.equal(fact.主题, undefined, '主题不再是 frontmatter 字段（= 目录名）');
    assert.equal(fact.type, undefined, 'type 这一级整个去掉');
  } finally {
    cleanup();
  }
});

test('两个主题相互独立：同 id 在不同主题不算撞', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const base = { who: '我', when: '2026-09-01', time: '10:00', what: 'x', id: 'f-20260901-1000-aa01' };
    assert.equal(s.record({ ...base, topic: 'A' }).written, true);
    assert.equal(s.record({ ...base, topic: 'B' }).written, true, '同 id 在不同主题应各自成立');
  } finally {
    cleanup();
  }
});

test('同主题内重复 id → E_DUPLICATE_ID', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const base = { who: '我', when: '2026-09-01', time: '10:00', what: 'x', id: 'f-20260901-1000-aa01' };
    assert.equal(s.record({ ...base, topic: 'A' }).written, true);
    const dup = s.record({ ...base, topic: 'A' });
    assert.equal(dup.written, false);
    assert.ok(dup.fatal.some((i) => i.code === 'E_DUPLICATE_ID'), '同主题重复 id 必须致命');
  } finally {
    cleanup();
  }
});

test('缺主题 → E_MISSING_TOPIC；主题带 / → E_BAD_TOPIC', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const noTopic = s.record({ who: '我', when: '2026-09-01', what: 'x' });
    assert.equal(noTopic.written, false);
    assert.ok(noTopic.fatal.some((i) => i.code === 'E_MISSING_TOPIC'), '没给主题必须致命');
    const badTopic = s.record({ topic: '腾讯/集采', who: '我', when: '2026-09-01', what: 'x' });
    assert.equal(badTopic.written, false);
    assert.ok(badTopic.fatal.some((i) => i.code === 'E_BAD_TOPIC'), '主题名带 / 必须致命（它是目录名）');
  } finally {
    cleanup();
  }
});

test('howmuch 只查是不是数（无 type/单位/正负校验）；纯叙事不填 howmuch 也过', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const ok = s.record({ topic: '体重检测', who: '我', when: '2026-09-01', time: '07:00', what: '晨起称重 72 公斤', howmuch: 72.5 });
    assert.equal(ok.written, true, JSON.stringify(ok.fatal));
    assert.equal(ok.warn.length, 0, '不该有 W_UNKNOWN_TYPE / W_UNIT_MISMATCH——type 和单位校验都去掉了');
    const narr = s.record({ topic: '日常', who: '我', when: '2026-09-02', what: '读了半本书' });
    assert.equal(narr.written, true, JSON.stringify(narr.fatal));
    // 2026-10-13 用户定调：资金主题 负=出、正=进，核心不判正负；0 也是真事实（免费/平账）
    const out = s.record({ topic: '公司记账', who: '我', when: '2026-09-03', what: '办公用品采购', how: '付款', howmuch: -640 });
    assert.equal(out.written, true, JSON.stringify(out.fatal));
    assert.equal(out.fact.howmuch, -640);
    const zero = s.record({ topic: '公司记账', who: '我', when: '2026-09-04', what: '免费试用', howmuch: 0 });
    assert.equal(zero.written, true, JSON.stringify(zero.fatal));
    const nan = s.record({ topic: '日常', who: '我', when: '2026-09-05', what: '坏数据', howmuch: 'abc' });
    assert.equal(nan.written, false);
    assert.ok(nan.fatal.some((i) => i.code === 'E_AMOUNT_NAN'), 'howmuch 不是数字仍致命');
  } finally {
    cleanup();
  }
});

test('record 不再默认注入 tags：fact 标签无人消费，还把候选下拉污染成唯一值', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const r = s.record({ topic: '日常', who: '我', when: '2026-09-01', what: '读了半本书' });
    assert.equal(r.written, true, JSON.stringify(r.fatal));
    assert.equal(r.fact.tags, undefined, '没传 tags 就不该有 tags——曾经默认塞 ["fact"]，没有任何视图消费它');
  } finally {
    cleanup();
  }
});

test('tags 已从契约移除（2026-10-22）：旧数据里的 tags 读得出、但报未知字段告警', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    // 手写/旧数据带 tags：录入链路不拦（数据宽容），但体检会一直报 W_UNKNOWN_FIELD
    // ——字段出契约是有意的，提醒用户"这个字段宿主视图不显示了"。
    const t = s.record({ topic: '日常', who: '我', when: '2026-09-02', what: '跑步 5 公里', tags: ['健康'] });
    assert.equal(t.written, true, 'tags 不是致命错误，不拦写入');
    assert.ok(
      t.warn.some((w) => w.code === 'W_UNKNOWN_FIELD' && w.field === 'tags'),
      `传 tags 应报未知字段告警，实际：${JSON.stringify(t.warn)}`
    );
    // 告警必须落进体检报告——record 返回的 warn 是一次性的，报告才是持续可见的那层
    s.auditAndReport('测试库');
    const report = readFileSync(path.join(dir, '_体检.md'), 'utf8');
    assert.match(report, /W_UNKNOWN_FIELD/);
  } finally {
    cleanup();
  }
});

test('体检报告带字段填充画像：可选字段哪些真有人填，复盘的客观依据', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: '体重检测', who: '我', when: '2026-09-01', time: '07:00', what: '晨起称重', how: '测量', where: '家里', howmuch: 72.5 });
    s.record({ topic: '体重检测', who: '我', when: '2026-09-02', what: '晨起称重', howmuch: 72 });
    s.record({ topic: '体重检测', who: '我', when: '2026-09-03', what: '免费试用装', howmuch: 0 });
    s.auditAndReport('测试库');
    const report = readFileSync(path.join(dir, '_体检.md'), 'utf8');
    assert.match(report, /## 字段填充（录入画像）/);
    // who/when/what 恒满；where/how 各 1/3；why 0；howmuch 3/3——0 算填了，不是空缺。
    // time/tags 不列入：time 是内核自动打戳（恒 100% 是机器产物）；tags 2026-10-22 出契约。
    assert.match(
      report,
      /\| 体重检测 \| 3 \| 09-01 ~ 09-03 \| 100% \| 100% \| 100% \| 33% \| 0% \| 33% \| 100% \|/
    );
    assert.doesNotMatch(report, /\| time \|/, 'time 是内核自动打戳的字段，不进画像');
    assert.doesNotMatch(report, /\| tags \|/, 'tags 已从契约移除，不进画像');
    assert.match(report, /\| \*\*全库\*\* \| \*\*3\*\* \|/, '全库行汇总所有主题');
  } finally {
    cleanup();
  }
});

test('体检跨主题汇总；listTopics 只认有真源的主题目录', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: '潮汕6日游', who: '我', when: '2026-09-01', what: 'D1' });
    s.record({ topic: '潮汕6日游', who: '我', when: '2026-09-02', what: 'D2' });
    s.record({ topic: '公司记账', who: '我', when: '2026-09-01', what: '记一笔', howmuch: 100 });
    store.mkdir('还没记过的空目录'); // 没有 _真源/facts.ndjson，不算主题
    const { rows, fatal, warn, topics } = s.audit();
    assert.deepEqual([...topics].sort(), ['公司记账', '潮汕6日游']);
    assert.deepEqual([...listTopics(store)].sort(), ['公司记账', '潮汕6日游']);
    assert.equal(rows.length, 3);
    assert.equal(fatal.length, 0);
    assert.equal(warn.length, 0);
  } finally {
    cleanup();
  }
});

test('重建按主题从各自真源重生成读模型', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: 'A', who: '我', when: '2026-09-01', what: 'x' });
    s.record({ topic: 'B', who: '我', when: '2026-09-01', what: 'y' });
    // 破坏 A 的读模型，重建应从 A 的真源补回，且不碰 B
    rmSync(path.join(dir, 'A/事实'), { recursive: true, force: true });
    const r = s.rebuild();
    assert.equal(r.topics.length, 2);
    assert.equal(r.written, 2);
    assert.equal(r.fatal.length, 0);
    assert.equal(readdirSync(path.join(dir, 'A/事实')).length, 1, 'A 的事实 md 应被重建补回');
    assert.equal(readdirSync(path.join(dir, 'B/事实')).length, 1);
    assert.ok(existsSync(path.join(dir, 'A/A.base')), 'A.base 应在');
    assert.match(readFileSync(path.join(dir, 'A/时间线.md'), 'utf8'), /1 条/, '重建末尾统一刷时间线（逐条不刷，末尾 resetViews 一次）');
  } finally {
    cleanup();
  }
});

test('重建清掉旧名 .base 孤儿（主题目录被改名后，宿主不会跟着改文件名）', () => {
  // 2026-10-15 真机复现：用户把「一人公司CRM业务」目录改名「OPC CRM业务」——
  // 目录里留着旧名的 .base，inFolder 写死旧目录名，Bases 面板两个入口一个打开是空的。
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: '旧主题', who: '我', when: '2026-09-01', what: 'x' });
    // 模拟 Obsidian 里改目录名：整个目录搬到新名，里面的文件（含 .base）名字不变
    renameSync(path.join(dir, '旧主题'), path.join(dir, '新主题'));
    const r = s.rebuild();
    assert.equal(r.fatal.length, 0, JSON.stringify(r.fatal));
    const bases = readdirSync(path.join(dir, '新主题')).filter((f) => f.endsWith('.base'));
    assert.deepEqual(bases, ['新主题.base'], `应只剩新名 base，实际：${bases.join(', ')}`);
    assert.match(readFileSync(path.join(dir, '新主题/新主题.base'), 'utf8'), /inFolder\("新主题\/事实"\)/, '新 base 的 inFolder 应写新目录名');
  } finally {
    cleanup();
  }
});
