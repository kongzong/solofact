// CLI 壳的行为测试（子进程跑真命令，锁 skill 白纸黑字写给 agent 的退出码契约）：
//   0 = 成功；1 = 契约判致命（拒绝写入）；2 = 参数/配置错。
// 覆盖：只读「主题」命令、--topic 套导入、E_MISSING_TOPIC、负数 howmuch、缺正文、体检/重建。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'cli', 'solofact.js');

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-cli-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 跑真 CLI，返回 {status, stdout, stderr}——退出码是契约，不抛
function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd: root, // skill 约定：在包根执行
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

test('主题：空库提示还没有任何主题（退出码 0，零写入）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const r = run(['主题', '--vault', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /还没有任何主题/);
  } finally {
    cleanup();
  }
});

test('主题：录两条后列出主题名和事实数', () => {
  const { dir, cleanup } = tmpVault();
  try {
    assert.equal(run(['记录', '--vault', dir, '--topic', '潮汕6日游', '--who', '我', '--when', '2026-10-12', 'D1 抵达汕头']).status, 0);
    assert.equal(run(['记录', '--vault', dir, '--topic', '潮汕6日游', '--who', '我', '--when', '2026-10-13', 'D2 南澳岛']).status, 0);
    assert.equal(run(['记录', '--vault', dir, '--topic', '公司记账', '--who', '我', '--when', '2026-10-13', '服务器续费', '--howmuch', '-1200']).status, 0);
    const r = run(['主题', '--vault', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 个主题/);
    assert.match(r.stdout, /潮汕6日游 — 2 条/);
    assert.match(r.stdout, /公司记账 — 1 条/);
  } finally {
    cleanup();
  }
});

test('记录：成功退出码 0，输出 md 路径；负数 howmuch 放行', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const r = run(['记录', '--vault', dir, '--topic', '公司记账', '--who', '我', '--when', '2026-10-13', '服务器续费', '--howmuch', '-1200']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /公司记账\/事实\/f-\d{8}-\d{4}-[0-9a-f]{4}\.md/);
  } finally {
    cleanup();
  }
});

test('记录：缺 --topic → 退出码 1 + stderr 含 E_MISSING_TOPIC（agent 靠这个改字段重跑）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const r = run(['记录', '--vault', dir, '--who', '我', '--when', '2026-10-13', '没主题']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /E_MISSING_TOPIC/);
    assert.match(r.stderr, /拒绝写入/);
  } finally {
    cleanup();
  }
});

test('记录：主题名带 / → 退出码 1 + E_BAD_TOPIC', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const r = run(['记录', '--vault', dir, '--topic', '腾讯/集采', '--who', '我', '--when', '2026-10-13', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /E_BAD_TOPIC/);
  } finally {
    cleanup();
  }
});

test('记录：缺正文 → 退出码 2（参数错，不是契约致命）', () => {
  const { dir, cleanup } = tmpVault();
  try {
    const r = run(['记录', '--vault', dir, '--topic', 'A', '--who', '我', '--when', '2026-10-13']);
    assert.equal(r.status, 2);
  } finally {
    cleanup();
  }
});

test('任何命令：缺 --vault → 退出码 2', () => {
  const r = run(['主题'], { env: { SOLOFACT_VAULT: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--vault/);
});

test('导入：--topic 一次性套给所有行（行内无 topic 的两行都进该主题）', () => {
  const { dir, cleanup } = tmpVault();
  const file = path.join(dir, 'facts.ndjson');
  writeFileSync(
    file,
    [
      JSON.stringify({ who: '我', when: '2026-10-13', time: '10:00', what: '第一笔', howmuch: 100 }),
      JSON.stringify({ who: '我', when: '2026-10-12', time: '09:00', what: '第二笔', howmuch: -50 }),
    ].join('\n') + '\n'
  );
  try {
    const r = run(['导入', '--vault', dir, '--topic', '公司记账', file]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /写入 2 条，拒绝 0 条/);
    const t = run(['主题', '--vault', dir]);
    assert.match(t.stdout, /公司记账 — 2 条/);
  } finally {
    cleanup();
  }
});

test('体检/重建：干净库退出码 0，体检写 _体检.md', () => {
  const { dir, cleanup } = tmpVault();
  try {
    assert.equal(run(['记录', '--vault', dir, '--topic', 'A', '--who', '我', '--when', '2026-10-13', '一条']).status, 0);
    const audit = run(['体检', '--vault', dir]);
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, /全库干净/);
    assert.match(audit.stdout, /主题 1｜事实 1 条/);
    const rebuild = run(['重建', '--vault', dir]);
    assert.equal(rebuild.status, 0, rebuild.stderr);
    assert.match(rebuild.stdout, /重建 1 个主题、1 个事实文件/);
  } finally {
    cleanup();
  }
});

test('help：无参数/--help → 退出码 0，含主题命令和符号约定', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /solofact 主题/);
  assert.match(r.stdout, /负=出、正=进/);
});
