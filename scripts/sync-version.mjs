// 版本号单一源头：package.json 的 version 是唯一真源，本脚本把它同步到
//   - plugin/manifest.json          （Obsidian 插件版本，用户靠它判断要不要更新）
//   - skill/SKILL.md frontmatter    （agent 靠它判断 CLI 与插件是否同版本）
// 为什么值得一个脚本：三个副本手改必漂移——插件 0.4 而 CLI 还是 0.3，两套 core 行为不一致，
// agent 录一条插件体检报错，这种"灵异 bug"排查半小时，根因就是版本没对齐。
// 用法：node scripts/sync-version.mjs [--check]（--check 只校验不写，不一致退出码 1）
// 也被 scripts/release.mjs import 复用——同步逻辑只有这一份。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function syncVersion({ checkOnly = false } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!version) throw new Error('package.json 没有 version 字段——版本唯一真源缺失');

  const results = [];

  // 1) manifest.json：JSON 原地改 version，2 空格缩进 + 结尾换行，保持原格式。
  {
    const file = path.join(ROOT, 'plugin', 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.version === version) {
      results.push(`✓ manifest.json 已是 ${version}`);
    } else if (checkOnly) {
      results.push(`✗ manifest.json 是 ${manifest.version}，应为 ${version}`);
    } else {
      manifest.version = version;
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
      results.push(`→ manifest.json ${version}`);
    }
  }

  // 2) SKILL.md frontmatter：正则替换 version 行；没有则插在 description 行之后。
  {
    const file = path.join(ROOT, 'skill', 'SKILL.md');
    let text = readFileSync(file, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) throw new Error('skill/SKILL.md 没有 frontmatter（--- 包裹的头部）');
    const current = m[1].match(/^version:\s*(.+)$/m)?.[1]?.trim();
    if (current === version) {
      results.push(`✓ SKILL.md 已是 ${version}`);
    } else if (checkOnly) {
      results.push(`✗ SKILL.md 是 ${current ?? '（无 version 字段）'}，应为 ${version}`);
    } else {
      if (current) {
        text = text.replace(/^version:\s*.+$/m, `version: ${version}`);
      } else {
        text = text.replace(/^(---\n(?:name:.*\n)?description:.*\n)/m, `$1version: ${version}\n`);
      }
      writeFileSync(file, text);
      results.push(`→ SKILL.md ${version}`);
    }
  }

  console.log(`版本单一源头 = ${version}`);
  for (const r of results) console.log(`  ${r}`);
  return !results.some((r) => r.startsWith('✗'));
}

// 直接跑才执行；被 release.mjs import 时不自动跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ok = syncVersion({ checkOnly: process.argv.includes('--check') });
  if (!ok) process.exitCode = 1;
}
