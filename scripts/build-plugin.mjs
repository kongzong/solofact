// 插件的构建逻辑，**只有这一份**：esbuild.config.mjs（装进开发库）和
// scripts/pack-plugin.mjs（出分发包）都调这里——两处各写一遍 esbuild 配置，
// 迟早出现"开发库能跑、分发包是旧的"这种灵异事故。
// 为什么必须打包：Obsidian 只认插件目录里的 main.js，而 core/ 是 ESM；'obsidian' 保持
// external——宿主运行时才注入真 app 实例，打进去了反而拿不到。
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function optsFor(outDir) {
  return {
    entryPoints: [path.join(ROOT, 'plugin', 'main.ts')],
    outfile: path.join(outDir, 'main.js'),
    bundle: true,
    external: ['obsidian'],
    format: 'cjs',
    target: ['es2018'],
    platform: 'browser',
    sourcemap: 'inline',
    logLevel: 'info',
  };
}

// 一次性构建：main.js + manifest.json 进 outDir。返回 main.js 路径。
export async function buildPlugin(outDir) {
  mkdirSync(outDir, { recursive: true });
  await esbuild.build(optsFor(outDir));
  copyFileSync(path.join(ROOT, 'plugin', 'manifest.json'), path.join(outDir, 'manifest.json'));
  return path.join(outDir, 'main.js');
}

// 持续监听（开发用）：返回 esbuild context，调用方负责 dispose。
export async function watchPlugin(outDir) {
  mkdirSync(outDir, { recursive: true });
  const ctx = await esbuild.context(optsFor(outDir));
  await ctx.watch();
  return ctx;
}
