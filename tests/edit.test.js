// 编辑这条事实的行为锁（2026-10-15）：
// 用户要的是"改这条"，形态上不提供原地改——真源只追加，改旧行就是篡改历史。
// 于是编辑 = 复制 + 删除：录一条改好的新事实，再删掉旧稿。
//
// 顺序是硬的：**先录后删**。这个顺序的失败最坏态是"库里两条都在"（看得见、删一条就好）；
// 反过来先删后录，一次失败就是这条事实彻底没了，那才叫不可恢复。
// 壳（plugin/main.ts#submit 的编辑分支）走的就是这条路径，这里在 core 层锁住它的可观测结果——
// 壳的 UI 层没有测试设施（插件只写不看、宿主 API 不可注入），所以语义只能在这一层守住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsAdapter } from '../core/store.js';
import { openSession } from '../core/record.js';
import enums from '../contract/enums-5w2h.json' with { type: 'json' };

const NOW = new Date('2026-10-15T09:00:00').getTime();

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-edit-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 走一遍壳的编辑动作：读旧稿 md → session 门生成草稿 → 改字段 → 录新 → 删旧
function editFlow(s, store, topic, patch) {
  const draft = s.duplicateDraftFromMarkdown(store.read(store.list(`${topic}/事实`)[0]));
  assert.ok(draft, '旧稿应能生成草稿');
  const saved = s.record({ ...draft, ...patch, topic });
  assert.equal(saved.written, true, JSON.stringify(saved.fatal));
  return { draft, saved };
}

test('编辑闭环：改完另存为新事实 + 删旧稿 → 真源 / md / 时间线 都只剩改后那一条', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const oldId = String(s.record({ topic: '家庭记账', who: '我', when: '2026-10-12', what: '早餐', howmuch: 9 }).fact.id);

    const { saved } = editFlow(s, store, '家庭记账', { howmuch: -9, what: '早餐（补上金额）' });
    const gone = s.remove({ topic: '家庭记账', id: oldId });
    assert.equal(gone.removed, true, JSON.stringify(gone.fatal));

    // 真源：只有一行，是改后的内容，旧 id 不在
    const rows = store
      .read('家庭记账/_真源/facts.ndjson')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(rows.length, 1, '编辑后真源只剩一行（旧稿被压缩掉）');
    assert.equal(rows[0].id, String(saved.fact.id));
    assert.notEqual(rows[0].id, oldId, '新 id ≠ 旧 id——编辑绝不继承 id');
    assert.equal(rows[0].what, '早餐（补上金额）');
    assert.equal(rows[0].howmuch, -9, '资金主题负=出，符号是主题级约定，核心不拦');
    assert.equal(rows[0].when, '2026-10-12', 'when 照旧：改的是内容，不是发生日');
    assert.equal(rows[0].recorded, '2026-10-15', 'recorded 是编辑当天——"什么时候改的"诚实');

    // 读模型三层同步
    const files = store.list('家庭记账/事实');
    assert.equal(files.length, 1, '旧稿 md 已删');
    assert.ok(files[0].includes(String(saved.fact.id)), '留下的是新稿');
    assert.match(store.read('家庭记账/时间线.md'), /1 条/);
    const audit = s.audit();
    assert.equal(audit.fatal.length, 0, JSON.stringify(audit.fatal.map((f) => f.code)));
    assert.equal(audit.rows.length, 1);
  } finally {
    cleanup();
  }
});

test('编辑的收尾失败不丢数据：删旧稿用错 id → 副本还在（最坏态是两条，不是零条）', () => {
  // 这是"先录后删"那条顺序约束的实测出口：副本落盘在前，收尾的删除无论怎么失败，
  // 都不可能把刚改好的那条带走。反过来（先删后录）在这里会断言成 0 条——那就是数据丢失。
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const oldId = String(s.record({ topic: '家庭记账', who: '我', when: '2026-10-12', what: '早餐', howmuch: 9 }).fact.id);
    const { saved } = editFlow(s, store, '家庭记账', { howmuch: -9 });

    const wrong = s.remove({ topic: '家庭记账', id: 'f-20261012-0000-ffff' });
    assert.equal(wrong.removed, false);
    assert.ok(wrong.fatal.some((f) => f.code === 'E_NO_SUCH_FACT'), JSON.stringify(wrong.fatal.map((f) => f.code)));

    const rows = store
      .read('家庭记账/_真源/facts.ndjson')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(rows.length, 2, '副本和旧稿都还在——失败态是"多一条"，用户对旧稿再删一次即可');
    assert.ok(rows.some((r) => r.id === oldId) && rows.some((r) => r.id === String(saved.fact.id)));
  } finally {
    cleanup();
  }
});

test('编辑中途取消 = 零副作用（草稿不落盘，旧稿一个字节不动）', () => {
  // 壳里"取消"就是关窗；core 侧对应的事实是：生成草稿本身不写任何东西。
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const { fact } = s.record({ topic: '家庭记账', who: '我', when: '2026-10-12', what: '早餐', howmuch: 9 });
    const before = store.read('家庭记账/_真源/facts.ndjson');
    const draft = s.duplicateDraftFromMarkdown(store.read(store.list('家庭记账/事实')[0]));
    assert.ok(draft);
    // 只生成草稿、什么都不录
    assert.equal(store.read('家庭记账/_真源/facts.ndjson'), before, '生成草稿不写真源');
    assert.equal(store.list('家庭记账/事实').length, 1);
    assert.equal(String(fact.id), String(JSON.parse(before.trim()).id));
  } finally {
    cleanup();
  }
});
