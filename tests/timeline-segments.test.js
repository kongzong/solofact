// 时间线按月分段的行为锁（2026-10-15 形态变更，用户拍板）。
//
// 以前一个主题一份 时间线.md，体积随事实线性上涨：bench 实测 1000 条 43KB、10000 条 412KB、
// 30000 条 1.2MB——算它只要零点几秒，**卡的是 Obsidian 打开一个大 md**。而且每录一条都要重写
// 全份，成本随总量线性涨。分段之后：每月一份小文件 + 一个恒定大小的索引页，
// 录入只重写受影响的那个月。这里锁的就是这个"O(1)"的承诺，别哪天改回去又变成 O(n) 了。
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
const NOW = new Date('2026-10-15T12:00:00').getTime();
const TOPIC = '公司记账';

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-seg-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 写操作的探针：包一层记下每次 write 的路径——"录入重写了哪些文件"是这次优化的核心命题，
// 不看到这份清单就等于没验证。
function spy(inner) {
  const writes = [];
  return {
    writes,
    proxy: new Proxy(inner, {
      get: (t, k) => (k === 'write' ? (p, s) => { writes.push(p); return t.write(p, s); } : t[k]),
    }),
  };
}

function seed(dir, dates) {
  const session = openSession(fsAdapter(dir), { enums, now: NOW });
  dates.forEach((when, i) => {
    const r = session.record({ topic: TOPIC, who: '甲', when, what: `第 ${i} 条事实`, howmuch: -9 });
    assert.equal(r.written, true, JSON.stringify(r.fatal));
  });
  return dir;
}

test('分段形态：每月一份 时间线-YYYY-MM.md + 索引页 时间线.md', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seed(dir, ['2026-01-05', '2026-01-20', '2026-02-10', '2026-03-20']);
    assert.ok(existsSync(path.join(dir, TOPIC, '时间线-2026-01.md')), '1 月应有自己的分段');
    assert.ok(existsSync(path.join(dir, TOPIC, '时间线-2026-02.md')), '2 月应有自己的分段');
    assert.ok(existsSync(path.join(dir, TOPIC, '时间线-2026-03.md')), '3 月应有自己的分段');
    assert.ok(existsSync(path.join(dir, TOPIC, '时间线.md')), '索引页应在');
    // 单月文件只放自己那个月的事实
    const jan = readFileSync(path.join(dir, TOPIC, '时间线-2026-01.md'), 'utf8');
    assert.match(jan, /2026-01-05/);
    assert.ok(!jan.includes('2026-02-10'), '1 月文件里不该出现 2 月的事实');
    const feb = readFileSync(path.join(dir, TOPIC, '时间线-2026-02.md'), 'utf8');
    assert.ok(!feb.includes('2026-01-05'), '2 月文件里不该出现 1 月的事实');
  } finally {
    cleanup();
  }
});

test('索引页：尺寸恒定（最近 20 条 + 月份链接），不再随总量线性上涨', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const dates = [];
    for (let i = 0; i < 60; i++) dates.push(`2026-0${(i % 3) + 1}-${String((i % 27) + 1).padStart(2, '0')}`);
    seed(dir, dates);
    const index = readFileSync(path.join(dir, TOPIC, '时间线.md'), 'utf8');
    assert.match(index, /共 \*\*60\*\* 条事实/, '总量要说清楚');
    assert.match(index, /时间线-2026-01\.md/, '要有分月链接');
    // 60 条跨 27 个日期；索引页只放最近 20 条，所以 callout 数必须被压到 20 以内、且明显少于 27
    const notes = (index.match(/\[!note\]/g) ?? []).length;
    assert.ok(notes > 0 && notes <= 20, `索引页的 callout 数应有上限（实际 ${notes}）`);
    assert.ok(notes < 27, `索引页不该把全部 27 个日期都铺出来（实际 ${notes}）——那意味着它又随总量线性上涨了`);
  } finally {
    cleanup();
  }
});

test('核心承诺：录一条只重写「那个月 + 索引」，其它月份一个字节都不碰', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seed(dir, ['2026-01-05', '2026-02-10', '2026-03-20']);
    const { proxy, writes } = spy(fsAdapter(dir));
    const r = openSession(proxy, { enums, now: NOW }).record({ topic: TOPIC, who: '乙', when: '2026-02-11', what: '补一条 2 月的事' });
    assert.equal(r.written, true, JSON.stringify(r.fatal));
    const touched = writes.filter((p) => p.includes('时间线'));
    assert.deepEqual(touched.sort(), [
      `${TOPIC}/时间线-2026-02.html`,
      `${TOPIC}/时间线-2026-02.md`,
      `${TOPIC}/时间线.html`,
      `${TOPIC}/时间线.md`,
    ], '只该重写 2 月的那一段和两个索引页——牵连到别月就等于回到 O(n) 的老路');
  } finally {
    cleanup();
  }
});

test('删掉某月最后一条 → 那个月的分段文件跟着消失（不留空壳）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seed(dir, ['2026-01-05', '2026-02-10']);
    const session = openSession(fsAdapter(dir), { enums, now: NOW });
    const id = JSON.parse(readFileSync(path.join(dir, TOPIC, '_真源/facts.ndjson'), 'utf8').trim().split('\n')[1]).id;
    const r = session.remove({ topic: TOPIC, id, dryRun: false });
    assert.equal(r.removed, true, JSON.stringify(r.fatal));
    const left = readFileSync(path.join(dir, TOPIC, '_真源/facts.ndjson'), 'utf8').trim();
    const months = new Set(left.split('\n').map((l) => JSON.parse(l).when.slice(0, 7)));
    for (const m of ['2026-01', '2026-02']) {
      if (months.has(m)) continue;
      assert.equal(existsSync(path.join(dir, TOPIC, `时间线-${m}.md`)), false, `清空后的 ${m} 不该留下分段文件`);
    }
  } finally {
    cleanup();
  }
});

test('重建清理孤儿分段：分段文件跟着真源重生成，多余的那份被删掉', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seed(dir, ['2026-01-05', '2026-02-10']);
    // 手工造一个不属于任何事实的分段（模拟"删除后残留"或人手放进去的）
    const store = fsAdapter(dir);
    store.write(`${TOPIC}/时间线-1999-01.md`, '# 时间线 · 1999 年 1 月\n');
    openSession(store, { enums, now: NOW }).rebuild();
    assert.equal(existsSync(path.join(dir, TOPIC, '时间线-1999-01.md')), false, '孤儿分段该被清理');
    assert.ok(existsSync(path.join(dir, TOPIC, '时间线-2026-01.md')), '真实存在的月份要重建出来');
  } finally {
    cleanup();
  }
});

test('日期倒序（顺手修的老 bug：标题写着"倒序"，实际按录入顺序排）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seed(dir, ['2026-01-05', '2026-03-20', '2026-02-10']);
    const index = readFileSync(path.join(dir, TOPIC, '时间线.md'), 'utf8');
    const days = [...index.matchAll(/📅 (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    assert.deepEqual(days, [...days].sort().reverse(), '索引页的最近条目必须是日期倒序');
    const jan = readFileSync(path.join(dir, TOPIC, '时间线-2026-03.md'), 'utf8');
    assert.match(jan, /2026-03-20/);
  } finally {
    cleanup();
  }
});

test('分段页：页眉与第一条 callout 之间必须有空行（2026-10-22 真机 bug）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seed(dir, ['2026-01-05', '2026-01-06']);
    const seg = readFileSync(path.join(dir, TOPIC, '时间线-2026-01.md'), 'utf8');
    // Obsidian 要求 [!note] 声明前有空行：只有一个换行的话，callout 按引用块内纯文本渲染，
    // 日期头变成一行字面的"[!note] 📅 …"。分段页页眉（"重建会覆盖"）紧接第一条 callout，
    // 每个分段页**最新的一条**都中招——索引页因隔着「## 最近 20 条」标题才幸免。
    assert.match(seg, /重建会覆盖。\n\n> \[!note\]/, '页眉与第一条 callout 之间缺空行');
    assert.match(seg, /_\n\n> \[!note\]/, '各组 callout 之间的空行也不能丢');
    // 反向 sanity：全文不该出现"引用行紧跟 [!note]"的形态
    assert.ok(!/^>.*\n> \[!note\]/m.test(seg), '任何一行引用都不允许直接接 [!note]');
  } finally {
    cleanup();
  }
});

test('html 索引页：最近 20 条要渲染成卡片，不能只有月份链接', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seed(dir, ['2026-01-05', '2026-01-06', '2026-02-10']);
    const html = readFileSync(path.join(dir, TOPIC, '时间线.html'), 'utf8');
    assert.equal((html.match(/class="card"/g) ?? []).length, 3, 'html 索引要把最近条目渲染成卡片');
    assert.match(html, /2026-02\.html/, '月份导航链接还要在');
  } finally {
    cleanup();
  }
  // 索引页尺寸恒定：25 个不同日期也只渲染最近 20 张卡片（与 md 索引同一上限）
  const { dir: dir2, cleanup: cleanup2 } = tmpVault();
  try {
    const dates = [];
    for (let i = 0; i < 25; i++) dates.push(`2026-01-${String(i + 1).padStart(2, '0')}`);
    seed(dir2, dates);
    const html = readFileSync(path.join(dir2, TOPIC, '时间线.html'), 'utf8');
    assert.equal((html.match(/class="card"/g) ?? []).length, 20, 'html 索引同样只放最近 20 条');
  } finally {
    cleanup2();
  }
});
