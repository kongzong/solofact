// 插件的构建逻辑，**只有这一份**：esbuild.config.mjs（装进开发库）和
// scripts/pack-plugin.mjs（出分发包）都调这里——两处各写一遍 esbuild 配置，
// 迟早出现"开发库能跑、分发包是旧的"这种灵异事故。
// 为什么必须打包：Obsidian 只认插件目录里的 main.js，而 core/ 是 ESM；'obsidian' 保持
// external——宿主运行时才注入真 app 实例，打进去了反而拿不到。
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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

// 产物自检（2026-10-15 事故后加）：main.js 和 manifest.json 必须都在，装进库时 manifest 的
// id 还得和插件目录名一致。缺 manifest 的后果不是报错，是**宿主面板里插件整个消失**——
// Obsidian 认不出这个目录，也不说为什么。更糟的是那次构建看上去"成功了"：
// 构建命令的崩溃输出被 `| tail -1` 切掉，我只看到拷贝 manifest 失败前那行的正常日志。
// 所以把这道检查做进构建本身：宁可构建失败并说清楚，也不许产出一个装不上的半成品。
export function assertPluginBundle(outDir, expectId) {
  const main = path.join(outDir, 'main.js');
  const manifest = path.join(outDir, 'manifest.json');
  if (!existsSync(main) || statSync(main).size === 0) throw new Error(`插件产物不完整：${main} 缺失或为空`);
  if (!existsSync(manifest)) {
    throw new Error(`插件产物不完整：${manifest} 缺失——没有它 Obsidian 认不出这个插件，宿主面板里会整个消失`);
  }
  const meta = JSON.parse(readFileSync(manifest, 'utf8'));
  if (expectId && meta.id !== expectId) {
    throw new Error(`manifest 的 id 是「${meta.id}」，插件目录却叫「${expectId}」——两者必须一致，否则 Obsidian 不加载`);
  }
  return meta;
}

// 一次性构建：main.js + manifest.json 进 outDir，然后自检产物。返回 main.js 路径。
export async function buildPlugin(outDir, { expectId } = {}) {
  mkdirSync(outDir, { recursive: true });
  await esbuild.build(optsFor(outDir));
  copyFileSync(path.join(ROOT, 'plugin', 'manifest.json'), path.join(outDir, 'manifest.json'));
  assertPluginBundle(outDir, expectId);
  return path.join(outDir, 'main.js');
}

// 持续监听（开发用）：返回 esbuild context，调用方负责 dispose。
export async function watchPlugin(outDir) {
  mkdirSync(outDir, { recursive: true });
  const ctx = await esbuild.context(optsFor(outDir));
  await ctx.watch();
  return ctx;
}
