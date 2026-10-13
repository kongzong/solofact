// 主题=目录：这一版形态的行为测试。核心命题——
//   每个主题是一个自包含目录（真源 + 事实 md + <主题>.base），
//   没有 type、没有单位校验，同主题内 howmuch 天然同义，id 只需主题内唯一。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
