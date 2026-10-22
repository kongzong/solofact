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

test('duplicateDraft：剥 id、when 照旧、无 time、tags 已出契约不进草稿', () => {
  const { fact } = parseFactFile(FACT_MD, enums);
  const draft = duplicateDraft(fact);
  assert.equal(draft.who, '腾讯·老王');
  assert.equal(draft.when, '2026-10-12'); // 照旧，等用户自己改
  assert.equal(draft.what, '聊了 Q4 的合作框架，对方出方案我们出排期。');
  assert.equal(draft.where, '腾讯滨海大厦');
  assert.equal(draft.why, '推进决策');
  assert.equal(draft.how, '会议');
  assert.equal(draft.howmuch, 500);
  // tags 2026-10-22 从契约移除（全库 0% 填充，5W2H 本无此字段）。FACT_MD 里那行是
  // 旧数据：解析器照读（宽容），但草稿不带它——录出来的新事实没有 tags。
  assert.ok(!('tags' in draft), 'tags 已出契约，不进草稿');
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

// ── 集成：壳走的那道门（session.duplicateDraftFromTruth）──
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
    // 壳的动作：从文件路径解析出 (主题, id) → 过 session 的门按真源取底稿
    const draft = s.duplicateDraftFromTruth('人情来往', originalId);
    assert.ok(draft, '真源里那条应生成底稿');
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

test('集成：真源里没有这条 → 门返回 null（孤儿 md：手改过 id/文件名，壳提示先跑重建）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW2 });
    s.record({ topic: '人情来往', who: '我', when: '2026-10-12', what: 'x' });
    assert.equal(s.duplicateDraftFromTruth('人情来往', 'f-20261012-0000-ffff'), null, '真源里没有这个 id');
    assert.equal(s.duplicateDraftFromTruth('没这个主题', 'f-20261012-0000-ffff'), null, '连主题都没有');
  } finally {
    cleanup();
  }
});

test('集成：md 被手改成缺字段，底稿仍来自真源——坏记录也能编辑（2026-10-15 真机回归）', () => {
  // 真机：用户手改 md 把 what 清空 → 旧实现拿 md 当底稿 → validate 判 E_MISSING_REQUIRED
  // → 编辑/复制提示"读不了契约"。而**最需要编辑的偏偏是记错的那条**：把想改内容的人挡在
  // 门外，等于堵死纠正路径，还和"手改 md 不算数"自相矛盾（既然不算数就不该拿它当底稿）。
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW2 });
    const id = String(s.record({ topic: '一人公司CRM业务', who: '我', when: '2026-10-15', what: '4444' }).fact.id);
    // 模拟手改：清空 md 的 what（真源那行不动）
    const rel = store.list('一人公司CRM业务/事实')[0];
    store.write(rel, store.read(rel).replace(/^what:.*$/m, 'what:'));
    // 手改的后果照旧被体检抓到（体检读 md）——这是应有的，不是要抹掉的
    assert.ok(s.audit().fatal.some((f) => f.code === 'E_MISSING_REQUIRED'), '手改 md 的后果仍被体检抓到');
    // 但编辑/复制的门走真源：底稿完整，坏记录照样能改好
    const draft = s.duplicateDraftFromTruth('一人公司CRM业务', id);
    assert.ok(draft, '底稿取自真源，不被手改的 md 影响');
    assert.equal(draft.what, '4444', '拿到的是真源里的正文');
    const saved = s.record({ ...draft, topic: '一人公司CRM业务', what: '吃了个饭' });
    assert.equal(saved.written, true, JSON.stringify(saved.fatal));
    assert.equal(s.remove({ topic: '一人公司CRM业务', id }).removed, true);
    assert.match(store.read('一人公司CRM业务/_真源/facts.ndjson'), /吃了个饭/);
    assert.equal(s.audit().fatal.length, 0, '编辑完体检干净——坏记录被修好了');
  } finally {
    cleanup();
  }
});
