// scripts/copy.mjs 的行为锁 + 静态守卫（2026-10-15 事故的回归）。
//
// 事故回放：构建里「拷 manifest.json 进插件目录」那步被环境以 EPERM 拒掉，而且**拒之前先把
// 目标删了**——git 跟踪的那份 manifest.json 就这么消失，Obsidian 认不出插件目录、宿主面板里
// solofact 整个消失，一句报错都没有。所以复制必须走 read+write：
//   · 成功时覆盖得干净（这条测）
//   · 失手时不许碰到目标（静态守卫那条拦住回退）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFileTo, copyTreeTo } from '../scripts/copy.mjs';

function tmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-copy-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('copyFileTo：拷到不存在的目标也能建好（黎明前空目录）', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const src = path.join(dir, 'a', 'manifest.json');
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, '{"id":"solofact"}');
    const dest = path.join(dir, 'b', 'c', 'manifest.json'); // 目标的两层父目录都不存在
    copyFileTo(src, dest);
    assert.equal(readFileSync(dest, 'utf8'), '{"id":"solofact"}');
  } finally {
    cleanup();
  }
});

test('copyFileTo：目标已存在则整个换成新内容（这是更新的样子，不是拼接）', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const src = path.join(dir, 'src.json');
    const dest = path.join(dir, 'dest.json');
    writeFileSync(src, 'NEW');
    writeFileSync(dest, 'OLD-and-longer-than-new'); // 旧内容更长，能顺带查到"没截断干净"的情况
    copyFileTo(src, dest);
    assert.equal(readFileSync(dest, 'utf8'), 'NEW', '覆盖后不许残留旧内容的尾巴');
  } finally {
    cleanup();
  }
});

test('copyTreeTo：深层目录结构原样搬过去', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const src = path.join(dir, 'src');
    mkdirSync(path.join(src, 'cli', 'deep'), { recursive: true });
    writeFileSync(path.join(src, 'SKILL.md'), '# hi');
    writeFileSync(path.join(src, 'cli', 'deep', 'x.js'), 'x');
    const dest = path.join(dir, 'dest');
    copyTreeTo(src, dest);
    assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# hi');
    assert.equal(readFileSync(path.join(dest, 'cli', 'deep', 'x.js'), 'utf8'), 'x');
  } finally {
    cleanup();
  }
});

test('copyTreeTo：filter 返回 false 连子树一起跳过（发布物排除本机状态的依据）', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const src = path.join(dir, 'src');
    mkdirSync(path.join(src, '.obsidian'), { recursive: true });
    writeFileSync(path.join(src, 'keep.md'), 'keep');
    writeFileSync(path.join(src, '.obsidian', 'workspace.json'), '{}');
    const dest = path.join(dir, 'dest');
    copyTreeTo(src, dest, { filter: (s) => path.basename(s) !== '.obsidian' });
    assert.equal(existsSync(path.join(dest, 'keep.md')), true);
    assert.equal(existsSync(path.join(dest, '.obsidian')), false, '被过滤的目录不许出现在产物里');
  } finally {
    cleanup();
  }
});

// 静态守卫：谁再把 node 的 cpSync / copyFileSync 请回来，就让测试炸——
// 那个 syscall 被挡时是「先删目标，再报失败」，一次失手就是丢文件的代价。
test('静态守卫：脚本里不许再用 node 的 copyFileSync / copyFile / cpSync', () => {
  const files = [
    'esbuild.config.mjs',
    ...readdirSync(path.join(process.cwd(), 'scripts'))
      .filter((f) => f.endsWith('.mjs') && f !== 'copy.mjs')
      .map((f) => path.join('scripts', f)),
  ];
  const banned = /\b(copyFileSync|copyFile|cpSync)\s*\(/;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, ''); // 注释里提这些名字是允许的（要解释为什么不用）
      assert.equal(banned.test(code), false, `${file}:${i + 1} 不许用 node 复制 API，改调 scripts/copy.mjs 的 copyFileTo / copyTreeTo`);
    });
  }
});
