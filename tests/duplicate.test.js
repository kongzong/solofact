// duplicateDraft 的行为锁（2026-10-15，复制这条事实）：
//   ① id 绝不进草稿——原样带 id 会撞 E_DUPLICATE_ID（Obsidian 自带复制正是这么作死的）；
//   ② when 照旧（副本默认是同一件事的修正版，要改成周期场景用户自己动）；
//   ③ time 不输出——壳渲染时自动填当前时刻，副本的发生时刻属于复制那一刻。
// 为什么值得单测：这三个约定全在"产出物里没有什么"上，壳里做的话，
// 某个未来的「顺手完善」把 id/time 加进草稿，运行时没有任何报错——只有这里能拦住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicateDraft, parseFactFile } from '../core/fact.js';
import { fsAdapter } from '../core/store.js';
import { openSession } from '../core/record.js';
import enums from '../contract/enums-5w2h.json' with { type: 'json' };

// 真实事实文件的形态（照 demo 库抄的）：正文双写——frontmatter 的 what 键 + body 一份。
const FACT_MD = `---
id: f-20261012-0930-a1b2
topic: 人情来往
who: 腾讯·老王
when: 2026-10-12
time: "09:30"
what: 聊了 Q4 的合作框架，对方出方案我们出排期。
where: 腾讯滨海大厦
why: 推进决策
how: 会议
howmuch: 500
recorded: 2026-10-12
tags: [商务, 茶水]
---

聊了 Q4 的合作框架，对方出方案我们出排期。
`;

test('duplicateDraft：剥 id、when 照旧、无 time、tags 数组转逗号串', () => {
  const { fact } = parseFactFile(FACT_MD, enums);
  const draft = duplicateDraft(fact);
  assert.equal(draft.who, '腾讯·老王');
  assert.equal(draft.when, '2026-10-12'); // 照旧，等用户自己改
  assert.equal(draft.what, '聊了 Q4 的合作框架，对方出方案我们出排期。');
  assert.equal(draft.where, '腾讯滨海大厦');
  assert.equal(draft.why, '推进决策');
  assert.equal(draft.how, '会议');
  assert.equal(draft.howmuch, 500);
  assert.equal(draft.tags, '商务, 茶水');
  // 三条铁律
  assert.ok(!('id' in draft), 'id 绝不进草稿——撞 E_DUPLICATE_ID 的就是它');
  assert.ok(!('time' in draft), 'time 不输出——壳自动填当前时刻');
  assert.ok(!('recorded' in draft), 'recorded 不继承——副本的记录时间是复制那天');
  assert.ok(!('topic' in draft), 'topic 由壳从文件路径解析后单设，函数不猜');
});

test('duplicateDraft：howmuch=0 保留、空值不进草稿', () => {
  const draft = duplicateDraft({
    who: '我', when: '2026-10-01', what: '零笔测试', howmuch: 0,
    where: '', why: null, how: undefined,
  });
  assert.equal(draft.howmuch, 0, '0 是合法值，不等于空');
  assert.ok(!('where' in draft) && !('why' in draft) && !('how' in draft), '空串/null/undefined 一律不进草稿');
});

test('duplicateDraft：正文字段 content 优先于 what（body 才是用户眼里的正文）', () => {
  const draft = duplicateDraft({ who: '我', when: '2026-10-01', what: 'frontmatter 里的旧值', content: 'body 里的新值' });
  assert.equal(draft.what, 'body 里的新值');
});

test('duplicateDraft：只有 what 没有 content 时兜底取 what（手写稿）', () => {
  const draft = duplicateDraft({ who: '我', when: '2026-10-01', what: '只有 frontmatter 有正文' });
  assert.equal(draft.what, '只有 frontmatter 有正文');
});

test('duplicateDraft：不变量——任何输入下输出都没有 id/time/recorded', () => {
  // 属性式抽查：把三个字段以各种形态塞进去（字符串/数字/null/数组），输出侧永远剥掉
  const nasty = [
    { id: 'f-20261012-0930-a1b2', time: '09:30', recorded: '2026-10-12', who: '我', when: '2026-10-01', what: 'x' },
    { id: null, time: null, recorded: null, who: '我', when: '2026-10-01', what: 'x' },
    { id: 12345, time: 0, recorded: ['a'], who: '我', when: '2026-10-01', what: 'x' },
  ];
  for (const data of nasty) {
    const draft = duplicateDraft(data);
    for (const k of ['id', 'time', 'recorded']) {
      assert.ok(!(k in draft), `${k} 泄漏进了草稿：${JSON.stringify(draft)}`);
    }
  }
});

// ── 集成：壳走的那道门（session.duplicateDraftFromMarkdown）──
// 纯函数测约定，这里测用户可感的最终结果：副本草稿真喂进 record()，录得进去、不撞 id。
const NOW2 = new Date('2026-10-15T09:00:00').getTime();

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-dup-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('集成：复制闭环——草稿喂 record() 录得进去，新 id 不撞、四层一致', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW2 });
    const original = s.record({ topic: '人情来往', who: '腾讯·老王', when: '2026-10-12', what: '聊了 Q4 框架', howmuch: 500 });
    const originalId = String(original.fact.id);
    // 壳的动作：读用户眼前这份 md → 过 session 的门生成草稿（解析在 core，不在壳）
    const factFileRel = store.list('人情来往/事实')[0];
    const draft = s.duplicateDraftFromMarkdown(store.read(factFileRel));
    assert.ok(draft, '正常事实 md 应生成草稿');
    assert.equal(draft.when, '2026-10-12', 'when 照旧，等用户自己改');
    // 用户只改一个字段就录——模拟"改完点记下来"
    draft.howmuch = 800;
    const copy = s.record({ ...draft, topic: '人情来往' });
    assert.equal(copy.written, true, JSON.stringify(copy.fatal));
    assert.notEqual(String(copy.fact.id), originalId, '新 id 绝不继承原 id');
    // 四层一致：真源两行、md 两个、时间线两条、体检干净
    const truth = store.read('人情来往/_真源/facts.ndjson').trim().split('\n');
    assert.equal(truth.length, 2);
    assert.ok(truth.some((l) => l.includes(originalId)) && truth.some((l) => l.includes(String(copy.fact.id))), '原稿+副本都在真源');
    assert.equal(store.list('人情来往/事实').length, 2);
    assert.match(store.read('人情来往/时间线.md'), /2 条/);
    const audit = s.audit();
    assert.equal(audit.fatal.length, 0, JSON.stringify(audit.fatal.map((f) => f.code)));
    assert.equal(audit.rows.length, 2);
  } finally {
    cleanup();
  }
});

test('集成：读不回契约的 md → 门返回 null（壳该提示先修，而不是拿半截数据去录）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW2 });
    assert.equal(s.duplicateDraftFromMarkdown('---\nid: f-20261012-0930-a1b2\nfrontmatter 未闭合'), null);
    assert.equal(s.duplicateDraftFromMarkdown('没有 frontmatter 的纯文本'), null);
  } finally {
    cleanup();
  }
});
