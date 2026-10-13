// 把 core/ 和 plugin/main.ts 打成 Obsidian 要的单个 CommonJS main.js，装进指定库的 .obsidian/plugins/solofact/。
// 用法：node esbuild.config.mjs [库目录] [--watch]
// 构建逻辑在 scripts/build-plugin.mjs（和分发包共用一份，不许在这里另写 esbuild 配置）；
// 本文件只负责"装进库"这一层：库检查、把 id 写进 community-plugins.json 启用。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildPlugin, watchPlugin } from './scripts/build-plugin.mjs';

const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const vault = argv.find((a) => !a.startsWith('--')) ?? 'vault-5w2h';
const outDir = path.join(vault, '.obsidian', 'plugins', 'solofact');

if (!existsSync(path.join(vault, '.obsidian'))) {
  throw new Error(`${vault} 不是一个 Obsidian 库（没有 .obsidian/）——先跑 node cli/solofact.js init --vault ${vault}`);
}

if (watch) {
  await watchPlugin(outDir);
  console.log(` watching → ${outDir}`);
} else {
  await buildPlugin(outDir);
}

// 启用＝把 id 写进 .obsidian/community-plugins.json。已存在的列表要合并，不能覆盖——
// 那是用户自己启用的其它插件的清单。
const list = path.join(vault, '.obsidian', 'community-plugins.json');
const current = existsSync(list) ? JSON.parse(readFileSync(list, 'utf8')) : [];
if (!current.includes('solofact')) writeFileSync(list, JSON.stringify([...current, 'solofact'], 2));
