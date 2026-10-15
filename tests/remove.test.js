// 删除一条事实（2026-10-15 加）：core/record.js 的 remove()。
// 锁三件事——① 真源压缩 + md 删除 + 时间线刷新是一体的，删完库里没有任何残留；
// ② dryRun 预览一个字节都不写（危险动作先给人看，和"致命错误拒绝写入"同一种哲学）；
// ③ 删掉的事实不会被重建复活（手删 md 不管用、真源还在才会复活——这个洞由 remove 补上）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsAdapter } from '../core/store.js';
import { openSession } from '../core/record.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enums = JSON.parse(readFileSync(path.join(root, 'contract/enums-5w2h.json'), 'utf8'));
const NOW = new Date('2026-10-13T12:00:00').getTime();

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-remove-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function truthLines(dir, topic) {
  return readFileSync(path.join(dir, topic, '_真源/facts.ndjson'), 'utf8').trim().split('\n').filter(Boolean);
}

test('remove：真源压缩 + md 删除 + 时间线刷新，三者一体', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: '公司记账', who: '我', when: '2026-10-10', what: '第一笔', howmuch: 100 });
    const second = s.record({ topic: '公司记账', who: '我', when: '2026-10-11', what: '记错了的第二笔', howmuch: -50 });
    s.record({ topic: '公司记账', who: '我', when: '2026-10-12', what: '第三笔', howmuch: 30 });
    const id = String(second.fact.id);

    const r = s.remove({ topic: '公司记账', id });
    assert.equal(r.removed, true, JSON.stringify(r.fatal));
    assert.equal(truthLines(dir, '公司记账').length, 2, '真源应剩两行');
    assert.ok(!truthLines(dir, '公司记账').some((l) => l.includes(id)), '真源里不该再有被删的 id');
    assert.ok(!existsSync(path.join(dir, `公司记账/事实/${id}.md`)), '事实 md 应被删');
    assert.match(store.read('公司记账/时间线.md'), /2 条/, '时间线应刷成 2 条');
    const audit = s.audit();
    assert.equal(audit.fatal.length, 0);
    assert.equal(audit.rows.length, 2);
  } finally {
    cleanup();
  }
});

test('remove：删掉的事实不会被重建复活（手删 md 才会——那个洞由 remove 补上）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const a = s.record({ topic: 'A', who: '我', when: '2026-10-10', what: '留下' });
    const b = s.record({ topic: 'A', who: '我', when: '2026-10-11', what: '删掉' });
    assert.equal(s.remove({ topic: 'A', id: String(b.fact.id) }).removed, true);
    const r = s.rebuild();
    assert.equal(r.written, 1, '重建只该写回剩下的那条');
    assert.equal(truthLines(dir, 'A').length, 1);
    assert.ok(existsSync(path.join(dir, `A/事实/${a.fact.id}.md`)));
    assert.ok(!existsSync(path.join(dir, `A/事实/${b.fact.id}.md`)), '被 remove 的事实不许被重建复活');
  } finally {
    cleanup();
  }
});

test('remove：dryRun 预览一个字节都不写', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const r0 = s.record({ topic: 'A', who: '我', when: '2026-10-10', what: '一条' });
    const id = String(r0.fact.id);
    const p = s.remove({ topic: 'A', id, dryRun: true });
    assert.equal(p.removed, false);
    assert.equal(p.fatal.length, 0);
    assert.equal(String(p.fact.what), '一条', '预览要带回事实内容给壳显示');
    assert.equal(truthLines(dir, 'A').length, 1, '真源没动');
    assert.ok(existsSync(path.join(dir, `A/事实/${id}.md`)), 'md 没删');
  } finally {
    cleanup();
  }
});

test('remove：id 不存在 → E_NO_SUCH_FACT，什么都不写', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    s.record({ topic: 'A', who: '我', when: '2026-10-10', what: '一条' });
    const r = s.remove({ topic: 'A', id: 'f-20261010-1200-ffff' });
    assert.equal(r.removed, false);
    assert.ok(r.fatal.some((i) => i.code === 'E_NO_SUCH_FACT'));
    assert.equal(truthLines(dir, 'A').length, 1, '没删错东西');
  } finally {
    cleanup();
  }
});

test('remove：删空主题留空真源文件（与 init 初始态一致），之后能继续记', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const only = s.record({ topic: 'A', who: '我', when: '2026-10-10', what: '唯一一条' });
    assert.equal(s.remove({ topic: 'A', id: String(only.fact.id) }).removed, true);
    assert.equal(readFileSync(path.join(dir, 'A/_真源/facts.ndjson'), 'utf8'), '', '删空后是真源是空文件，不留尾随换行');
    assert.match(store.read('A/时间线.md'), /0 条/);
    const again = s.record({ topic: 'A', who: '我', when: '2026-10-12', what: '删光了也能重新记' });
    assert.equal(again.written, true, JSON.stringify(again.fatal));
  } finally {
    cleanup();
  }
});

test('remove：主题缺失/非法 → E_MISSING_TOPIC / E_BAD_TOPIC', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const store = fsAdapter(dir);
    const s = openSession(store, { enums, now: NOW });
    const noTopic = s.remove({ id: 'f-20261010-1200-aa01' });
    assert.ok(noTopic.fatal.some((i) => i.code === 'E_MISSING_TOPIC'));
    const badTopic = s.remove({ topic: '腾讯/集采', id: 'f-20261010-1200-aa01' });
    assert.ok(badTopic.fatal.some((i) => i.code === 'E_BAD_TOPIC'));
  } finally {
    cleanup();
  }
});
