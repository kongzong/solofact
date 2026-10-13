// 库内路径的合法性：只有这一条规则，而且它不在 fs 那一层里。
// 单独一个文件的原因是实测的：assertRel 原本住在 core/store.js，而 core/store.js  import node:fs——
// 谁想复用这句校验，就把整个文件系统那扇门拖进了 bundle（Obsidian 里 require('node:fs') 直接加载失败）。
// 所以纯规则留在这里，fs 壳反过来 import 它。
export function assertRel(rel) {
  if (typeof rel !== 'string') throw new Error(`路径必须是字符串，收到 ${rel}`);
  // who 名／主题名／id 都来自用户输入，拼成 `../../x` 就能跳出库目录：
  // fs 壳会真的写到外面去，Obsidian 壳会自己抛错——两边行为不一致本身就是 bug，所以在进适配器之前先拦掉
  if (rel.split('/').some((p) => p === '..' || p === '.')) throw new Error(`库内路径越界：${rel}`);
  return rel.split('/').filter((p) => p !== '').join('/');
}
