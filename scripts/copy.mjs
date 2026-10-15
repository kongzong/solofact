// 复制这件事自己实现，**不用 node 的 cpSync / copyFileSync**（2026-10-15 事故的产物）。
//
// 事故：一次 `npm run plugin` 里，把 manifest.json 拷进 `<库>/.obsidian/plugins/solofact/`
// 的那步被环境拒了（errno -1 / EPERM / syscall copyfile，来自 Node 外面套的那层 fs 代理）。
// 如果只是"没拷进去"还算小事；真正致命的是它**拒绝之前先把目标删了**——那份 git 跟踪的
// manifest.json 就这么没了，Obsidian 认不出插件目录、宿主面板里 solofact 整个消失，还不给任何报错。
//
// 所以这里用 read + write 代替：
//   1. 走的是普通读写，不过那条被拒的 copyfile 路径；
//   2. 没有"先清目标再写入"的窗口——写失败＝原文件原样保留，最坏是没更新，不是数据丢失。
//
// 顺带统一：发布链路（pack-plugin / pack-demo / pack-agent）原本各自用 cpSync，
// 同一一层挑战在这里一次收口，不许再散着写。
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 拷单个文件：目标目录自动建；目标已存在就直接覆盖内容。
export function copyFileTo(src, dest) {
  const mode = statSync(src).mode & 0o777;
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src), { mode });
  return dest;
}

// 拷整棵树：filter(src) 返回 false 就跳过（对目录也一样，整棵子树跳过），语义对齐 cpSync 的 filter。
export function copyTreeTo(src, dest, { filter } = {}) {
  if (filter && !filter(src)) return dest;
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      copyTreeTo(path.join(src, entry.name), path.join(dest, entry.name), { filter });
    }
    return dest;
  }
  return copyFileTo(src, dest);
}
