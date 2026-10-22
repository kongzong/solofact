// 时间线视图（mermaid 笔记 + HTML）是 事实.base 之外的第二套读模型，由内核从事实抽取。
// 这里锁住：字段归一、mermaid 语法、冒号清洗、HTML 结构——防止哪天改坏时间线生成还不自知。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTimeline, renderTimelineHtml, adaptFact } from '../core/vault.js';

test('adaptFact 把 5w2h 的 when/who/what 归一成时间线字段', () => {
  const f = adaptFact({ when: '2026-10-12', who: '我自己', what: '跑了 5 公里', where: '江边', howmuch: 5 });
  assert.equal(f.date, '2026-10-12');
  assert.equal(f.who, '我自己');
  assert.equal(f.body, '跑了 5 公里');
  assert.equal(f.howmuch, 5);
});

test('renderTimeline 产出 Obsidian 原生 callout 时间线（不依赖 mermaid timeline 图表类型）', () => {
  const facts = [
    { date: '2026-10-12', who: 'A', body: '做了 X', time: '09:00' },
    { date: '2026-10-12', who: 'B', body: '做了 Y', where: '公司' },
  ];
  const md = renderTimeline(facts);
  assert.match(md, /> \[!note\] 📅 2026-10-12/);
  assert.match(md, /> - \*\*A\*\* — 做了 X/);
  assert.match(md, /> - \*\*B\*\* — 做了 Y/);
  assert.ok(!md.includes('```mermaid'), '不该再依赖可能不被支持的 mermaid timeline 图表类型');
});

test('renderTimeline 给每条事实带时间/地点/方式/度量元信息', () => {
  const md = renderTimeline([{ date: '2026-10-12', who: 'A', body: '做了 X', time: '09:00', where: '公司', how: '会议', howmuch: 5 }]);
  assert.match(md, /🕐 09:00/);
  assert.match(md, /📍 公司/);
  assert.match(md, /🔧 会议/);
  assert.match(md, /📊 5/);
});

test('renderTimelineHtml 产出可浏览器预览的时间线页面', () => {
  const html = renderTimelineHtml([
    { date: '2026-10-12', who: 'A', body: '做了 X', time: '09:00', where: '公司', how: '会议', howmuch: 5 },
  ]);
  assert.match(html, /<html/);
  assert.match(html, /class="card"/);
  assert.match(html, /做了 X/);
  assert.match(html, /🕐 09:00/);
});

test('renderTimelineHtml 给负值 howmuch 染绿色（出/减），正值不染', () => {
  const html = renderTimelineHtml([
    { date: '2026-10-12', who: 'A', body: '云服务器续费', howmuch: -1200 },
    { date: '2026-10-12', who: 'A', body: '项目回款', howmuch: 140000 },
    { date: '2026-10-12', who: 'A', body: '晨起称重', howmuch: 72.5 },
  ]);
  assert.match(html, /<span class="neg">-1200<\/span>/, '负值染绿——资金主题的"出"要一眼看见');
  assert.doesNotMatch(html, /<span class="neg">140000/);
  assert.doesNotMatch(html, /<span class="neg">72\.5/, '正值不染：符号语义是主题级约定，体重/里程没有正负含义，染红会误示警');
  assert.match(html, /📊 140000/);
  assert.match(html, /📊 72\.5/);
});
