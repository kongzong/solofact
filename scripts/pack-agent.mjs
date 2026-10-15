// pack:agent —— 自包含 skill 包（agent 用户）。
// 产物：dist/solofact-skill-<ver>.tar.gz，解压即得 solofact/ 目录——
// **符合 skill 规范：SKILL.md 在目录根**，cp 进 skills/ 即装：
//   cp -r solofact ~/.workbuddy/skills/solofact        （用户级）
//   cp -r solofact <项目>/.workbuddy/skills/solofact   （项目级）
// 组装内容：SKILL.md（根）+ cli/ + core/ + contract/——CLI 按自身位置解析路径，
// 所以在 skills/ 目录下任何位置都能跑。**不含 vault**：数据与工具分离，
// 覆盖更新这个包永远不会碰用户的数据。
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { run, hasCmd } from './run.mjs';
import { copyFileTo, copyTreeTo } from './copy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STAGE_ROOT = path.join(DIST, '_agent-stage');

export async function main() {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  rmSync(STAGE_ROOT, { recursive: true, force: true });
  const skillDir = path.join(STAGE_ROOT, 'solofact');
  rmSync(skillDir, { recursive: true, force: true });

  // SKILL.md 提到根（skill 规范的硬要求），cli/core/contract 作为它的子目录
  copyFileTo(path.join(ROOT, 'skill', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
  for (const d of ['cli', 'core', 'contract']) {
    copyTreeTo(path.join(ROOT, d), path.join(skillDir, d));
  }

  if (!(await hasCmd('tar'))) throw new Error('找不到 tar 命令');
  const targz = path.join(DIST, `solofact-skill-${version}.tar.gz`);
  rmSync(targz, { force: true });
  // 产物路径必须写绝对路径 + -C 指定工作目录——在 STAGE_ROOT 里用 basename 输出的话，
  // 打完 rmSync(STAGE_ROOT) 会把产物一起删掉（2026-10-13 实测踩到：release 显示成功、
  // dist/ 里却没有文件）。
  await run('tar', ['czf', targz, '-C', STAGE_ROOT, 'solofact']);
  rmSync(STAGE_ROOT, { recursive: true, force: true });

  console.log(`✓ pack:agent → dist/solofact-skill-${version}.tar.gz（解压 cp 进 skills/ 即装）`);
  return targz;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
