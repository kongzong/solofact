// release —— 发布编排：一条命令出三个同版本产物。
// 顺序即纪律：
//   1. sync-version     package.json 的 version 是唯一真源，写进 manifest + SKILL.md
//   2. --check 断言    同步后再校验一遍，三处不一致就中止（不许带病发布）
//   3. pack:plugin     裸插件更新包（老用户覆盖 .obsidian/plugins/solofact/）
//   4. pack:demo       vault 总入口 zip（新用户；内含重建+质量门：致命≠0 拒绝出包）
//   5. pack:agent      自包含 skill 包（agent 用户；SKILL.md 在根，cp 进 skills/ 即装）
//   6. git 卫生检查    有未提交改动就提醒——分发的包应该对应一个可追溯的 commit
// 为什么"同步发布、独立更新"：三个包同版本号一次出（行为一致），但用户的更新动作
// 各走各的（只装插件的人更他的，只装 skill 的人更他的）——细节见 RELEASE.md。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncVersion } from './sync-version.mjs';
import { main as packPlugin } from './pack-plugin.mjs';
import { main as packDemo } from './pack-demo.mjs';
import { main as packAgent } from './pack-agent.mjs';
import { run } from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function gitDirty() {
  try {
    const out = await run('git', ['status', '--porcelain'], { cwd: ROOT });
    return out.trim();
  } catch {
    return null; // 不是 git 仓库
  }
}

const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
console.log(`\n=== solofact release ${version} ===\n`);

console.log('[1/5] 版本同步（package.json → manifest.json + SKILL.md）');
syncVersion();

console.log('\n[2/5] 版本一致性断言');
if (!syncVersion({ checkOnly: true })) {
  throw new Error('三处版本号不一致——先查 package.json / plugin/manifest.json / skill/SKILL.md');
}

console.log('\n[3/5] pack:plugin');
const plugin = await packPlugin();
console.log('\n[4/5] pack:demo');
const demo = await packDemo();
console.log('\n[5/5] pack:agent');
const agent = await packAgent();

console.log(`\n=== 产物（dist/，版本 ${version}）===`);
console.log(`  新用户总入口 : ${path.relative(ROOT, demo)}`);
console.log(`  插件更新包   : ${path.relative(ROOT, plugin)}`);
console.log(`  agent 套装   : ${path.relative(ROOT, agent)}`);

const dirty = await gitDirty();
if (dirty === null) {
  console.log('\n⚠ 还不是 git 仓库——分发前建议 git init 并 commit，让每个版本可追溯');
} else if (dirty) {
  console.log(`\n⚠ 有未提交改动（${dirty.split('\n').length} 个文件）——建议 commit 后再分发，否则包对应不上代码：`);
  console.log(dirty.split('\n').map((l) => `    ${l}`).join('\n'));
} else {
  console.log('\n✓ 工作区干净，产物对应当前 commit');
}
console.log('分发与更新机制见 RELEASE.md\n');
