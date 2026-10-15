// 存储适配器：内核（core/vault.js、core/scan.js）只认「库内相对路径 + 正斜杠」，不认 node:fs。
// 分成这一层不是因为 fs 难用，是因为插件壳必须走 Obsidian 的 Vault API：
// 绕开它写文件，宿主的索引、同步、其他插件都不知道这次写入——那正好毁掉「一条事实 = 一个文件」的前提。
// 所以规则实现留在 core，IO 由壳注入：CLI 用 fsAdapter，插件用 vaultAdapter。
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assertRel } from './rel.js';

// 递归列文件，返回库内相对路径（正斜杠）。目录名不返回——调用方要的是文件。
function walk(root, rel, outList) {
  const abs = rel ? path.join(root, ...rel.split('/')) : root;
  if (!existsSync(abs)) return outList;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, childRel, outList);
    else if (e.isFile()) outList.push(childRel);
  }
  return outList;
}

export function fsAdapter(root) {
  const abs = (rel) => path.join(root, ...assertRel(rel).split('/'));
  return {
    label: root,
    exists: (rel) => existsSync(abs(rel)),
    read(rel) {
      return existsSync(abs(rel)) ? readFileSync(abs(rel), 'utf8') : null;
    },
    write(rel, text) {
      const f = abs(rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, text);
    },
    // 插件壳必须有这一步：Obsidian 的 vault.create() 不会自动建父目录，
    // 而 createFolder 是宿主知道的建目录方式（fs 直接 mkdir 宿主索引不到）。
    mkdir(rel) {
      mkdirSync(abs(rel), { recursive: true });
    },
    append(rel, text) {
      const f = abs(rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, text, { flag: 'a' });
    },
    // 库根的直接子项名（文件＋目录），给 init 的「不认识的东西就不动手」护栏用
    entries(rel = '') {
      return existsSync(abs(rel)) ? readdirSync(abs(rel)) : [];
    },
    list(rel = '') {
      return walk(root, rel, []);
    },
    // 「磁盘上真实有什么」——fs 本来就读盘，和 list 同值。存在的意义是和 snapshotStore
    // 的 listReal 对齐接口：那里 list 走 Obsidian 索引（可能和磁盘不一致），listReal 走盘。
    // resetViews 删旧名 .base 孤儿必须用 listReal（2026-10-15 真机：索引没这个路径，
    // 索引版 list 列不到它，孤儿就永远删不掉）。
    listReal(rel = '') {
      return walk(root, rel, []);
    },
    removeTree(rel) {
      if (rel !== '' && !existsSync(abs(rel))) return;
      rmSync(abs(rel), { recursive: true, force: true });
    },
  };
}
