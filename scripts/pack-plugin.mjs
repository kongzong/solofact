// pack:plugin —— 裸插件更新包。
// 产物：dist/solofact-plugin-<ver>.zip，内含 solofact/ 目录（main.js + manifest.json + README）。
// 用途：老用户更新——解压后把 solofact/ 整个覆盖进 <他的库>/.obsidian/plugins/solofact/，
// 数据（主题目录/事实/_体检.md）一个字节不碰。新用户不需要它（vault zip 里已含装好的插件）。
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildPlugin } from './build-plugin.mjs';
import { copyTreeTo } from './copy.mjs';
import { run, hasCmd } from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

export async function main() {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const stage = path.join(DIST, `solofact-plugin-${version}`);
  rmSync(stage, { recursive: true, force: true });

  await buildPlugin(stage);

  // 包内自带更新说明——分发是单文件的，用户拿到手不该再去翻文档。
  writeFileSync(
    path.join(stage, 'README.md'),
    `# solofact 插件更新（${version}）

解压后得到 \`solofact/\` 目录，把它**整个覆盖**进你的库：

\`\`\`
<你的库>/.obsidian/plugins/solofact/
\`\`\`

然后重启 Obsidian（或 设置 → 社区插件 里把 solofact 关掉再打开）。

- **你的数据不受影响**：主题目录、事实文件、_体检.md 都不动，只换插件本身。
- 验证更新成功：插件面板里版本号应为 **${version}**。
- 内置 CLI 与插件应保持同版本（vault 里的 \`_体检.md\` 页首有标注）。
`,
  );

  if (!(await hasCmd('zip'))) throw new Error('找不到 zip 命令——apt install zip 或改用其它打包方式');
  const zip = path.join(DIST, `solofact-plugin-${version}.zip`);
  rmSync(zip, { force: true });
  // -x 排除 mac 垃圾；stage 在 dist/ 下，包内根就是 solofact-plugin-<ver>/？不——
  // 用户要的是解压即得 solofact/。所以在 dist/ 下建一个只含 solofact/ 的暂存层太绕，
  // 直接 cd 进 stage 的父目录打：包内路径形如 solofact-plugin-<ver>/main.js。
  // 但那样解压出来是带版本号的目录，用户还得改名。折中：把 stage 目录改名为 solofact/ 再打。
  const friendly = path.join(DIST, 'solofact');
  rmSync(friendly, { recursive: true, force: true });
  copyTreeTo(stage, friendly);
  rmSync(stage, { recursive: true, force: true });
  await run('zip', ['-r', '-q', path.basename(zip), 'solofact', '-x', '*.DS_Store'], { cwd: DIST });
  rmSync(friendly, { recursive: true, force: true });

  console.log(`✓ pack:plugin → dist/solofact-plugin-${version}.zip（更新用：覆盖 .obsidian/plugins/solofact/）`);
  return zip;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
