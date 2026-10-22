// 第三批打磨（2026-10-22）的行为测试。核心命题——
//   ① tags 已从契约移除：field_order 无它；旧数据带 tags 读得出、报 W_UNKNOWN_FIELD 告警；
//   ② 事实笔记题注行：renderFactFile 在正文顶部渲染元信息引用块，
//      parseFactFile 必须剥掉它（否则体检读回的"正文"不再是正文）；
//   ③ .base 正/负值表带 Sum 汇总（2026-10-22 用户拍板）；
//   ④ 体检报告「录入频率（按天）」：跨度/有记录天数/最长断档/当前断档/最近 14 天。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsAdapter } from '../core/store.js';
import { openSession } from '../core/record.js';
import { renderFactFile, parseFactFile } from '../core/fact.js';
import { buildBase } from '../core/vault.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enums = JSON.parse(readFileSync(path.join(root, 'contract/enums-5w2h.json'), 'utf8'));
// 固定"现在"：让 when 用过去的日期，不撞 E_FUTURE_DATE / E_RECORDED_BEFORE。
// 取 10-13，录到 09 月的记录会让"当前断档"是 13 天——频率节断言用这个已知值。
const NOW = new Date('2026-10-13T12:00:00').getTime();

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-batch3-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('契约里没有 tags：5W2H 形态本无此字段（2026-10-22 全库 0% 填充后移除）', () => {
  assert.ok(!enums.field_order.includes('tags'), 'field_order 不该再有 tags');
  assert.ok(!enums.required.includes('tags'));
});

test('题注行：renderFactFile 在正文顶部渲染元信息引用块', () => {
  const md = renderFactFile(
    { id: 'f-20261012-0930-a1b2', who: '腾讯·老王', when: '2026-10-12', time: '09:30', content: '聊了合作框架', where: '腾讯滨海大厦', how: '会议', howmuch: 500, recorded: '2026-10-12' },
    enums
  );
  assert.match(md, /\n> 2026-10-12 · 09:30 · 腾讯·老王 · 腾讯滨海大厦 · 会议 · 📊 500\n\n/, '题注行紧跟 frontmatter，与正文之间空行');
  assert.match(md, /\n\n聊了合作框架\n$/, '正文在题注行之后，原样保留');
});

test('题注行：parseFactFile 剥掉它——往返之后 content 是纯正文，不带元信息', () => {
  // content 而非 what：makeFact 会把 what 规范成 content（渲染层只认 content），
  // 真实链路 record→writeFact 喂进来的 fact 永远有 content。这里与真链路对齐。
  const fact = { id: 'f-20261012-0930-a1b2', who: '腾讯·老王', when: '2026-10-12', time: '09:30', content: '聊了合作框架', where: '腾讯滨海大厦', how: '会议', howmuch: 500, recorded: '2026-10-12' };
  const md = renderFactFile(fact, enums);
  const { fact: back, error } = parseFactFile(md, enums);
  assert.equal(error, null);
  assert.equal(back.content, '聊了合作框架', '题注行被剥掉，content 只剩正文');
  // 往返保真：frontmatter 字段一个不少一个不错
  assert.equal(back.who, '腾讯·老王');
  assert.equal(back.howmuch, 500);
  assert.equal(back.when, '2026-10-12');
});

test('题注行：只剥 leading 那一块——正文里用户自己写的引用块不动', () => {
  const md = [
    '---',
    'who: 我',
    'when: 2026-10-12',
    'what: 记一笔',
    '---',
    '',
    '> 2026-10-12 09:30 · 我',
    '',
    '正文第一段',
    '',
    '> 这是我自己写的引用块',
    '',
    '第二段',
    '',
  ].join('\n');
  const { fact } = parseFactFile(md, enums);
  assert.equal(fact.content, '正文第一段\n\n> 这是我自己写的引用块\n\n第二段', '只剥内核题注，用户引用块保留');
});

test('题注行：字段缺失时优雅退化——没有可选字段就只渲染 when/who', () => {
  const md = renderFactFile({ id: 'f-20261012-0000-0001', who: '我', when: '2026-10-12', content: '裸记一笔', recorded: '2026-10-12' }, enums);
  assert.match(md, /\n> 2026-10-12 · 我\n\n/, '缺 time/where/how/howmuch 时不留空段');
  const { fact } = parseFactFile(md, enums);
  assert.equal(fact.content, '裸记一笔');
});

test('.base 正/负值表各带一处 howmuch Sum 汇总（2026-10-22 用户拍板）', () => {
  const base = buildBase('公司记账');
  // 两处 summaries：正值记录 + 负值记录。全表混排的「全部事实」不给 Sum——
  // 进和出加在一起是个没有意义的数。
  const sums = [...base.matchAll(/summaries:\n      howmuch: Sum/g)];
  assert.equal(sums.length, 2, '正值/负值两张表各一处 Sum');
  const posIdx = base.indexOf('name: 正值记录');
  const negIdx = base.indexOf('name: 负值记录');
  const posSum = base.indexOf('summaries:', posIdx);
  const negSum = base.indexOf('summaries:', negIdx);
  assert.ok(posSum > posIdx && posSum < negIdx, '正值表的 Sum 在正值视图段落内');
  assert.ok(negSum > negIdx, '负值表的 Sum 在负值视图段落内');
});

test('体检报告带「录入频率（按天）」：跨度、有记录天数、断档、最近 14 天', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    // 三天有记录（09-01/09-02/09-03），"现在"是 10-13：
    // 跨度 3 天全有记录；记录日之间无断档，尾部断档 = 09-03 → 10-13 = 40 天
    // （它同时就是最长断档——这个库的全部故事就是"记了三天然后消失"）；
    // 当前断档同样 40 天。最近 14 天（09-30 ~ 10-13）全空。
    // record 传 what（必填项），makeFact 会规范成 content——渲染层只认 content。
    s.record({ topic: '体重检测', who: '我', when: '2026-09-01', what: '晨起称重', howmuch: 72.5 });
    s.record({ topic: '体重检测', who: '我', when: '2026-09-02', what: '晨起称重', howmuch: 72 });
    s.record({ topic: '体重检测', who: '我', when: '2026-09-03', what: '晨起称重', howmuch: 71.8 });
    s.auditAndReport('测试库');
    const report = readFileSync(path.join(dir, '_体检.md'), 'utf8');
    assert.match(report, /## 录入频率（按天）/);
    assert.match(report, /跨度 09-01 ~ 09-03（3 天），有记录 \*\*3\*\* 天（100%）/);
    assert.match(report, /最长断档 \*\*40\*\* 天（09-03 之后）；当前断档 \*\*40\*\* 天/, '尾部断档必须进最长断档——只记过三条的库，"最长断档 0" 会是谎言');
    // 最近 14 天逐日明细：全部空档（最后记录是 09-03，早于 14 天窗口）
    const recent = report.match(/最近 14 天：(.+)/)[1];
    assert.equal(recent.split('　').length, 14, '最近 14 天逐日一项');
    assert.ok(recent.includes('10-13—'), '今天（10-13）无记录显 —');
  } finally {
    cleanup();
  }
});

test('频率节：今天有记录时当前断档 0，且明细里当天显条数', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: '体重检测', who: '我', when: '2026-10-13', what: '今天记了', howmuch: 71 });
    s.record({ topic: '体重检测', who: '我', when: '2026-10-12', what: '昨天也记了', howmuch: 71.2 });
    s.auditAndReport('测试库');
    const report = readFileSync(path.join(dir, '_体检.md'), 'utf8');
    assert.match(report, /当前断档 \*\*0\*\* 天（今天有记录）/);
    assert.match(report, /10-13·1/, '今天一条');
    assert.match(report, /10-12·1/, '昨天一条');
    assert.match(report, /最长断档 \*\*0\*\* 天/, '连续两天无断档');
  } finally {
    cleanup();
  }
});

test('频率节：同一天多条只计一天（日粒度是"坚持"的口径，不是产量口径）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: '体重检测', who: '我', when: '2026-10-13', time: '07:00', what: '晨起称重', howmuch: 71 });
    s.record({ topic: '体重检测', who: '我', when: '2026-10-13', time: '15:00', what: '饭后', howmuch: 71.8 });
    s.auditAndReport('测试库');
    const report = readFileSync(path.join(dir, '_体检.md'), 'utf8');
    assert.match(report, /跨度 10-13 ~ 10-13（1 天），有记录 \*\*1\*\* 天/, '两天...不，同一天两条计一天');
    assert.match(report, /10-13·2/, '明细里当天显 2 条');
  } finally {
    cleanup();
  }
});
