// 视图文件（<主题>.base）的名字也是规矩的一部分——2026-10-15 之前它坏了不死也不响：
//   把 base 改名 → 体检报"全库干净"、插件的视图入口失效、下次记录还会补出第二份、
//   重建默默删掉改名的那份。这三件事都发生过，所以规矩是：**一个主题目录下只有一个 .base，
//   名字必须等于目录名**，坏了体检必须说出来（W_BASE_NAME / W_BASE_MISSING）。
//
// 为什么是告警不是致命：base 里写的是 file.inFolder("<主题>/事实")，查的是目录不含文件名，
// 所以改名不会让视图变空——那是目录改名的症状（那种才致命）。这里只需要人看一眼。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsAdapter } from '../core/store.js';
import { openSession } from '../core/record.js';
import { viewIssues } from '../core/vault.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enums = JSON.parse(readFileSync(path.join(root, 'contract/enums-5w2h.json'), 'utf8'));
const NOW = new Date('2026-10-13T12:00:00').getTime();

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-views-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seeded(dir, topic = '公司记账') {
  const session = openSession(fsAdapter(dir), { enums, now: NOW });
  session.record({ topic, who: '甲', when: '2026-10-01', what: '一笔账', howmuch: -9 });
  return dir;
}

test('规矩立得住：建好主题后名字合规，体检一条视图告警都没有', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seeded(dir);
    assert.deepEqual(viewIssues(fsAdapter(dir)), [], '合规的 <主题>.base 不许被误杀');
    const r = openSession(fsAdapter(dir), { enums, now: NOW }).audit();
    assert.deepEqual(r.views, [], '体检的库级检查也是空的');
    assert.equal(r.warn.length, 0, '不该有告警');
  } finally {
    cleanup();
  }
});

test('把 .base 改名 → W_BASE_MISSING + W_BASE_NAME 两条都说得清去向', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seeded(dir);
    renameSync(path.join(dir, '公司记账/公司记账.base'), path.join(dir, '公司记账/我的账本.base'));
    const issues = viewIssues(fsAdapter(dir));
    const codes = issues.map((i) => i.code).sort();
    assert.deepEqual(codes, ['W_BASE_MISSING', 'W_BASE_NAME']);
    assert.ok(
      issues.some((i) => i.code === 'W_BASE_NAME' && i.where === '公司记账/我的账本.base' && /重建删掉/.test(i.message)),
      '要指名哪个文件，也要说明它会被重建删掉'
    );
    assert.ok(
      issues.some((i) => i.code === 'W_BASE_MISSING' && /重建/.test(i.message)),
      '缺正主要给出修复路径'
    );
  } finally {
    cleanup();
  }
});

test('改名后的体检不再装干净：warn 里带着视图告警（这就是"全库干净"撒谎的回归锁）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seeded(dir);
    renameSync(path.join(dir, '公司记账/公司记账.base'), path.join(dir, '公司记账/我的账本.base'));
    const r = openSession(fsAdapter(dir), { enums, now: NOW }).audit();
    assert.equal(r.warn.length, 2, '两条视图告警必须出现在 audit 的告警里，不能只躺在报告字符串里');
    assert.equal(r.fatal.length, 0, '改 view 名不致命——真源没事，视图也照样能查数据');
  } finally {
    cleanup();
  }
});

test('把文件名改回去 → 告警消失（修复路径的最小动作，不用重建）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seeded(dir);
    renameSync(path.join(dir, '公司记账/公司记账.base'), path.join(dir, '公司记账/我的账本.base'));
    assert.equal(viewIssues(fsAdapter(dir)).length, 2);
    renameSync(path.join(dir, '公司记账/我的账本.base'), path.join(dir, '公司记账/公司记账.base'));
    assert.deepEqual(viewIssues(fsAdapter(dir)), [], '改回原名就干净了');
  } finally {
    cleanup();
  }
});

test('正主被删（不是改名）→ 只报 W_BASE_MISSING，不定什么别的罪', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seeded(dir);
    unlinkSync(path.join(dir, '公司记账/公司记账.base'));
    const issues = viewIssues(fsAdapter(dir));
    assert.deepEqual(issues.map((i) => i.code), ['W_BASE_MISSING']);
  } finally {
    cleanup();
  }
});

test('非主题的孤立 .base 不打扰（库根的、非主题目录里的都不是这规矩的地盘）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    seeded(dir);
    const store = fsAdapter(dir);
    store.write('随手记.base', 'filters:\n'); // 库根：不是主题目录，不管
    store.write('杂物/.keep', '');
    assert.deepEqual(viewIssues(store), [], '根级 / 非主题目录里的 base 不在本检查范围内');
  } finally {
    cleanup();
  }
});
