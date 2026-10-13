// pack:demo —— vault 总入口 zip（新用户的第一触点，含装好的插件 + 5 主题样例）。
// 流程 = 重建 → 装插件 → 质量门 → 打包：
//   1. build.js 全量重建 demo（清掉开发期试录的私密主题——**发布物必须干净**）
//   2. esbuild 把最新插件打进 vault（保证 zip 里的插件 = 当前源码）
//   3. 体检质量门：致命 ≠ 0 拒绝出包（发布物带致命错误比晚发一天严重）
//   4. zip，排除 Obsidian 运行时的本机状态文件（app.json/workspace.json 等）
import { rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { run, hasCmd } from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const VAULT = 'vault-5w2h';

// 每台机器不同、不该进发布物的 Obsidian 本地状态
const LOCAL_STATE = [
  '.obsidian/app.json',
  '.obsidian/appearance.json',
  '.obsidian/workspace.json',
  '.obsidian/core-plugins.json',
];

export async function main() {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  // 1. 重建 demo（build.js 自带 fatal 门：有致命它自己 exitCode=1）
  console.log('· 重建 demo vault…');
  console.log(await run('node', ['vault-5w2h/build.js'], { cwd: ROOT }));

  // 2. 最新插件装进 vault（zip 里的插件必须与源码同版）
  console.log('· 插件打进 vault…');
  console.log(await run('node', ['esbuild.config.mjs', VAULT], { cwd: ROOT }));

  // 3. 质量门：跑真实 CLI 体检，验「致命 0」——测的是发布物本身，不是测试替身
  console.log('· 体检质量门…');
  const audit = await run('node', ['cli/solofact.js', '体检', '--vault', VAULT], { cwd: ROOT });
  console.log(audit.split('\n').map((l) => `    ${l}`).join('\n'));
  if (!/致命\s*0/.test(audit)) {
    throw new Error(`质量门未过：体检报告里没有「致命 0」——带伤不许出包\n${audit}`);
  }

  // 4. 打包：dist 下组一个包内根目录 solofact-vault/（用户解压即得库文件夹）
  if (!(await hasCmd('zip'))) throw new Error('找不到 zip 命令——apt install zip 或改用其它打包方式');
  const stage = path.join(DIST, `solofact-vault-${version}`);
  rmSync(stage, { recursive: true, force: true });
  cpSync(path.join(ROOT, VAULT), stage, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(path.join(ROOT, VAULT), src);
      return !LOCAL_STATE.includes(rel) && path.basename(src) !== '.DS_Store';
    },
  });
  const zip = path.join(DIST, `solofact-vault-${version}.zip`);
  rmSync(zip, { force: true });
  await run('zip', ['-r', '-q', path.basename(zip), path.basename(stage)], { cwd: DIST });
  rmSync(stage, { recursive: true, force: true });

  console.log(`✓ pack:demo → dist/solofact-vault-${version}.zip（新用户总入口：解压 → Obsidian 打开）`);
  return zip;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
