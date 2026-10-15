// 插件壳的存储适配器（docs/spec-v0.1.md §9 第 1 项的另一半）。
//
// 为什么是"快照 + 回写"而不是直接同步读写：Obsidian 的 Vault API 取内容只有 Promise
// （d.ts:10281 read / :10290 cachedRead），而 core 的写入序列是同步的。把 core 改成 async
// 会让 CLI、契约、29 条测试全跟着抖，所以改成在壳里做一次快照：core 看到的仍是同一个同步 store。
//
// 代价必须说清楚：快照到回写之间如果别人（同步盘、另一个编辑器）改了 事实/，回写会覆盖它。
// 桌面单人用可以接受；真被覆盖了跑一次"从真源重建"就补齐——因为真源才是事实，Markdown 是读模型。
//
// 两条写入门（这是插件唯一没法从 CLI 抄的地方）：
// - 库内文件走 vault.create/modify/delete，宿主的索引、链接、同步才知道这次写入；
// - `.obsidian/` 不在 Vault 文件索引里（宿主把配置目录另算），只能走 vault.adapter。
import { DIR } from '../vault.js';
import { assertRel } from '../rel.js';

// 需要正文的路径：内核只会读这几处，其余路径的 read 视为编程错误。
// 主题=目录：事实 <topic>/事实/*.md、真源 <topic>/_真源/facts.ndjson、视图 <topic>/<topic>.base，外加根级体检报告。
const FACT_RE = new RegExp(`^[^/]+/${DIR.facts}/[^/]+\\.md$`);
const TRUTH_RE = new RegExp(`^[^/]+/${DIR.truth}/facts\\.ndjson$`);
const BASE_RE = /^[^/]+\/[^/]+\.base$/;
// 配置目录里内核真正会碰的文件——目前只有属性类型注册表（根级共享）。
const CONFIG_FILES = [DIR.types];

function needsContent(p) {
  return FACT_RE.test(p) || TRUTH_RE.test(p) || BASE_RE.test(p) || p === DIR.report;
}

function isConfigPath(p) {
  return p.split('/')[0] === '.obsidian';
}

function parentDirs(rel) {
  const parts = rel.split('/');
  parts.pop();
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

// 同步的库内索引（路径来自 vault.getFiles()，正文按需预加载），加上一份"改了什么"的账。
// open() 是唯一的异步入口：先把索引和正文取齐，之后的 exists/read/list 才敢是同步的。
//
// bodies=false 是录入路径专用（2026-10-15）：时间线改从真源渲染后，record 链路上已经没有
// 任何地方需要读 事实/*.md 的正文了（ensureTopic 只问 exists、真源/ base 才是要读的）。
// 全量预读在几百条时无感，几千条时每次录入都在把整个库拖进内存——录入变慢会直接劝退
// "坚持记"，所以读面按操作收窄：record 传 false，audit/rebuild 传 true（体检要逐条读回契约）。
// 选项不析构（opts?.x）：checkJs:false 下 TS 对带默认值的析构参数推断会丢属性，
// 调用方的对象字面量会被误判成 excess property——壳的 typecheck 要过，别跟推断较劲。
async function snapshotStore(vault, opts) {
  const label = opts?.label;
  const bodies = opts?.bodies !== false;
  const adapter = vault.adapter;
  const content = new Map();
  const files = new Set();
  const dirs = new Set();
  const dirty = new Set();
  const deletedFiles = new Set();
  const deletedDirs = new Set();
  const madeDirs = new Set();
  // §9 那条未验证项的实测记录：打开时能不能读配置目录，回写时能不能写。壳拿它决定要不要提示用户手点属性类型。
  const configProbe = { readError: null, writeErrors: [] };

  // Obsidian 的 Vault 没有 getFolders()：目录树只能从 getAllLoadedFiles() 拿。
  // 用 .stat 区分文件和目录（TFolder 没有 stat），和 flush 里是同一个判据。
  for (const af of vault.getAllLoadedFiles()) {
    if (af.path === '' || af.path === '.') continue;
    if (af.stat) files.add(af.path);
    else dirs.add(af.path);
  }

  // 配置目录对 Vault API 不可见，只能单独问一次 adapter。这一问失败不等于库坏了，
  // 只等于"属性类型注册表写不进去"，所以记下错误继续跑，让壳去提示兜底动作。
  for (const p of CONFIG_FILES) {
    try {
      if (await adapter.exists(p)) {
        files.add(p);
        dirs.add(p.split('/')[0]);
        content.set(p, await adapter.read(p));
      }
    } catch (e) {
      configProbe.readError = String(e?.message ?? e);
    }
  }

  // 「磁盘上真实有什么」的第二份账（2026-10-15）：vault index（files 上面那份）在主题目录
  // 改名后会有一段时间和磁盘不一致——索引里没有旧名 <旧主题>.base，list/exists 全看不到它，
  // resetViews 的删孤儿循环形同虚设，盘上就永远留一个 inFolder 写死旧目录名的空视图入口。
  // adapter.list() 直接问磁盘（Obsidian DataAdapter 的官方能力），open 时扫一次存下来。
  // 只枚举路径不读内容，O(全库) 一次的成本，换 rebuild 这条路径的「以磁盘真相为准」。
  const realFiles = new Set();
  try {
    const listed = await adapter.list('/');
    for (const p of listed?.files ?? []) realFiles.add(String(p).replace(/^\/+/, ''));
  } catch (e) {
    configProbe.readError = configProbe.readError ?? String(e?.message ?? e);
  }

  for (const p of [...files].filter((p) => needsContent(p) && (bodies || !FACT_RE.test(p)))) {
    const f = vault.getAbstractFileByPath(p);
    content.set(p, f ? await vault.cachedRead(f) : await adapter.read(p));
  }

  return {
    label: label ?? vault.getName?.() ?? 'obsidian',
    // 越界路径的拦截和 fsAdapter 用同一个 assertRel：两道门（契约的 E_BAD_NAME ＋ 这里的 rel 校验）
    // 都必须存在，否则插件壳就成了唯一能写出库外路径的那扇门
    exists: (rel) => exists(assertRel(rel)),
    read: (rel) => read(assertRel(rel)),
    write: (rel, text) => write(assertRel(rel), text),
    mkdir: (rel) => mkdir(assertRel(rel)),
    append: (rel, text) => append(assertRel(rel), text),
    entries: (rel = '') => entries(assertRel(rel)),
    list: (rel = '') => list(assertRel(rel)),
    // 磁盘真实文件列表（open 时 adapter.list 扫的），删除语义和 list 一致（暂存删除立即可见）。
    // 给 resetViews 删旧名 .base 孤儿用——索引版 list 在目录改名后列不到旧名文件。
    listReal: (rel = '') => {
      const prefix = rel ? `${rel}/` : '';
      return [...realFiles].filter((p) => p.startsWith(prefix) && !deletedFiles.has(p)).sort();
    },
    removeTree: (rel) => removeTree(assertRel(rel)),
    flush,
    // 打开快照时取到的正文路径集合：内核读了没预加载的文件会在这里炸，而不是静默返回 null
    loaded: () => [...content.keys()],
    probe: configProbe,
  };

  function exists(rel) {
    const p = String(rel);
    if (deletedFiles.has(p) || deletedDirs.has(p)) return false;
    return files.has(p) || dirs.has(p);
  }

  function read(rel) {
    const p = String(rel);
    if (!exists(p)) return null;
    if (!content.has(p)) {
      // 静默返回 null 会被内核当成"这个文件不存在"，那是最坏的一类假象——宁可炸在这里
      throw new Error(`快照里没有 ${p} 的正文：内核读了不该读的文件（把它加进 core/adapters/vault.js 的预加载清单）`);
    }
    return content.get(p);
  }

  function write(rel, text) {
    const p = rel;
    content.set(p, text);
    files.add(p);
    deletedFiles.delete(p);
    dirty.add(p);
    for (const d of parentDirs(p)) {
      dirs.add(d);
      deletedDirs.delete(d);
    }
  }

  // 重建走的是 removeTree(事实/) → ensureLayout → 逐个写回，所以 mkdir 必须能撤销删除标记，
  // 否则 exists(事实/) 在回写前就返回 false，scanVault 会当这是"没 init 的库"直接拒绝
  function mkdir(rel) {
    const p = rel;
    if (p !== '.obsidian') madeDirs.add(p);
    dirs.add(p);
    deletedDirs.delete(p);
    for (const d of parentDirs(p)) {
      dirs.add(d);
      deletedDirs.delete(d);
    }
  }

  function append(rel, text) {
    write(rel, (read(rel) ?? '') + text);
  }

  function entries(rel = '') {
    const prefix = rel ? `${rel}/` : '';
    const out = new Set();
    for (const p of files) if (p.startsWith(prefix) && !deletedFiles.has(p)) out.add(p.slice(prefix.length).split('/')[0]);
    for (const p of dirs) if (p.startsWith(prefix) && !deletedDirs.has(p)) out.add(p.slice(prefix.length).split('/')[0]);
    return [...out].sort();
  }

  function list(rel = '') {
    const prefix = rel ? `${rel}/` : '';
    return [...files].filter((p) => p.startsWith(prefix) && !deletedFiles.has(p)).sort();
  }

  function removeTree(rel) {
    const p = String(rel);
    if (p === '' || p === '.' || p === '/') throw new Error('removeTree 不许对整个库下手——插件壳里这条路径一律拒绝');
    for (const f of [...files]) if (f === p || f.startsWith(`${p}/`)) {
      files.delete(f);
      content.delete(f);
      dirty.delete(f);
      deletedFiles.add(f);
    }
    // 索引外的真实文件也要标记：目录改名后的旧名 <旧主题>.base 就是这样——files（索引）里
    // 没有它，上面那个循环扫不到，不补这一笔 removeTree 对它就是空操作（2026-10-15 真机）。
    if (realFiles.has(p) && !deletedFiles.has(p)) deletedFiles.add(p);
    for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) {
      dirs.delete(d);
      madeDirs.delete(d);
      deletedDirs.add(d);
    }
    deletedDirs.add(p);
  }

  // 顺序即语义：先删，再建目录，最后写内容。反过来的话 removeTree 紧接着的 ensureLayout 会被删掉。
  // 返回 {wrote, removed, configWrites}：configWrites 非空说明宿主不让写 .obsidian/，
  // 那不是崩溃，是 §9 那条未验证项的答案——由壳决定怎么告诉用户（兜底动作已在验收第 3 条实测过）。
  async function flush() {
    let wrote = 0;
    let removed = 0;
    const configWrites = [];
    for (const p of [...deletedFiles]) {
      const f = vault.getAbstractFileByPath(p);
      if (f) {
        await vault.delete(f);
        removed++;
      } else if (await adapter.exists(p)) {
        // 索引里没有这条路径（主题目录改名后的旧名 <旧主题>.base 就是这一类），但磁盘上真实
        // 存在——vault.delete 拿着 null 无从下手，静默跳过就永远留一个空视图入口在 Bases
        // 面板里（2026-10-15 真机复现）。直接问 adapter 删掉它。
        await adapter.remove(p);
        removed++;
      }
      deletedFiles.delete(p);
    }
    for (const p of [...deletedDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const d = vault.getAbstractFileByPath(p);
      if (d) {
        await vault.delete(d, true);
        removed++;
      }
      deletedDirs.delete(p);
    }
    for (const p of [...madeDirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
      if (!vault.getAbstractFileByPath(p)) await vault.createFolder(p);
      madeDirs.delete(p);
    }
    for (const p of [...dirty]) {
      const text = content.get(p);
      if (isConfigPath(p)) {
        try {
          await adapter.write(p, text);
          configWrites.push({ path: p, ok: true });
        } catch (e) {
          configWrites.push({ path: p, ok: false, error: String(e?.message ?? e) });
        }
      } else {
        // TFolder 没有 .stat，TFile 有——用它区分文件和目录，比 import obsidian 的类更干净（core 不许认 obsidian）
        const af = vault.getAbstractFileByPath(p);
        if (af && af.stat) await vault.modify(af, text);
        else {
          for (const d of parentDirs(p)) if (!vault.getAbstractFileByPath(d)) await vault.createFolder(d);
          await vault.create(p, text);
        }
      }
      dirty.delete(p);
      wrote++;
    }
    return { wrote, removed, configWrites };
  }
}

export { snapshotStore, needsContent, isConfigPath, CONFIG_FILES };
