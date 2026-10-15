// 构建产物自检（2026-10-15 事故的回归锁）：
// 一次 `npm run plugin` 里「拷贝 manifest.json」被环境拦下，构建其实是崩了的——但崩溃输出
// 被 `| tail -1` 切在前一屏，我看到的是"成功"。结果插件目录只剩 main.js，Obsidian 认不出
// 这个插件目录，宿主面板里 solofact 整个消失，而没有任何报错。
// 这类失败不能靠人看日志发现，得让构建命令自己炸：产物不齐＝构建失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlugin, assertPluginBundle } from '../scripts/build-plugin.mjs';

function tmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-bundle-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('buildPlugin 产物齐全：main.js 非空 + manifest.json 的 id 对得上，自检不误杀', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const main = await buildPlugin(dir, { expectId: 'solofact' });
    assert.equal(existsSync(main), true, 'main.js 应产出');
    assert.ok(readFileSync(main, 'utf8').length > 0, 'main.js 不应为空（空 bundle 也是装不上的）');
    assert.equal(existsSync(path.join(dir, 'manifest.json')), true, 'manifest.json 应产出');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).id, 'solofact');
  } finally {
    cleanup();
  }
});

test('缺 manifest.json → 自检抛错（就是它让插件在面板里整个消失）', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await buildPlugin(dir);
    rmSync(path.join(dir, 'manifest.json'), { force: true });
    assert.throws(() => assertPluginBundle(dir), /认不出这个插件/, '缺 manifest 必须炸，不许静默产出半成品');
  } finally {
    cleanup();
  }
});

test('manifest 的 id 与插件目录名不一致 → 自检抛错（宿主不加载，也不说原因）', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await buildPlugin(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), id: '别处去了' }));
    assert.throws(() => assertPluginBundle(dir, 'solofact'), /两者必须一致/);
  } finally {
    cleanup();
  }
});
