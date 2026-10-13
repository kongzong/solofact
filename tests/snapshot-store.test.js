// snapshotStore 的暂存语义 + 录入路径集成测试。
// 2026-10-13 真机事故的回归锁：插件壳用 snapshotStore（快照 + 暂存 + flush），
// 用户在 Obsidian 里新建主题录第一条，时间线显示 0 条——排查后确认是**盘上 bundle 未热更新**
// （Obsidian 运行时加载的是启动时的旧代码，commit 彼时还不刷时间线），内核路径本身是对的。
// 本测试用内存假 vault 驱动 snapshotStore 真代码，锁死三件事：
//   ① 暂存区对 list/read/exists 立即可见（writeFact 后 timelineFacts 扫得到新 md）；
//   ② 录入即刷新时间线（commit 的 writeTimeline 渲染出刚录的事实，而非 0 条）；
//   ③ flush 落盘的内容 = 最后一次渲染（建主题时的空时间线被 commit 的渲染覆盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotStore } from '../core/adapters/vault.js';
import { openSession } from '../core/record.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enums = JSON.parse(readFileSync(path.join(root, 'contract/enums-5w2h.json'), 'utf8'));
const NOW = new Date('2026-10-13T13:48:00').getTime();

// 内存假 vault：只实现 snapshotStore 用到的那几个 API（getAllLoadedFiles/cachedRead/
// getAbstractFileByPath/adapter/create/modify/createFolder/delete）。
function fakeVault() {
  const disk = new Map(); // path -> text
  const folders = new Set();
  const vault = {
    getName: () => 'fake-vault',
    getAllLoadedFiles: () => [
      ...[...disk.keys()].map((p) => ({ path: p, stat: { mtime: 1 } })),
      ...[...folders].map((p) => ({ path: p })),
    ],
    getAbstractFileByPath: (p) => (disk.has(p) ? { path: p, stat: { mtime: 1 } } : folders.has(p) ? { path: p } : null),
    cachedRead: async (f) => disk.get(f.path),
    adapter: {
      exists: async (p) => disk.has(p) || folders.has(p.split('/')[0]),
      read: async (p) => disk.get(p) ?? null,
      write: async (p, text) => disk.set(p, text),
    },
    create: async (p, text) => disk.set(p, text),
    modify: async (f, text) => disk.set(f.path, text),
    createFolder: async (p) => folders.add(p),
    delete: async (f) => {
      disk.delete(f.path);
      folders.delete(f.path);
    },
  };
  return { vault, disk };
}

test('snapshotStore 下录入即刷新时间线：全新主题第一条也不例外', async () => {
  const { vault, disk } = fakeVault();
  const store = await snapshotStore(vault, { label: 'fake' });
  const s = openSession(store, { enums, now: NOW });
  const r = s.record({
    topic: '测试主题', who: '测试人', when: '2026-10-13', time: '13:48',
    what: '第一条测试事实', where: '测试地点', how: '测试方式', howmuch: 1000,
  });
  assert.equal(r.written, true, JSON.stringify(r.fatal));
  // commit 内的 writeTimeline 渲染时必须能扫到刚写的事实 md（暂存区对 list/read 可见）
  assert.match(store.read('测试主题/时间线.md'), /1 条/, 'commit 后时间线应含刚录的事实（不是建主题时的 0 条）');
  await store.flush();
  const flushed = disk.get('测试主题/时间线.md');
  assert.match(flushed, /1 条/, 'flush 落盘的时间线也应是 1 条（暂存内容即最终内容）');
  assert.match(flushed, /第一条测试事实/, '时间线应含事实正文');
  assert.match(disk.get('测试主题/时间线.html'), /1 条事实/, 'html 时间线同步');
  // 再录一条：条数递增（每次录入都重刷，不是只在建主题时写一次）
  s.record({ topic: '测试主题', who: '我', when: '2026-10-12', what: '第二条测试事实' });
  assert.match(store.read('测试主题/时间线.md'), /2 条/, '追加第二条后时间线应变 2 条');
  await store.flush();
  assert.match(disk.get('测试主题/时间线.md'), /2 条/, 'flush 后盘上也是 2 条');
});

test('snapshotStore：既有主题录第二条，时间线从旧内容刷新', async () => {
  const { vault, disk } = fakeVault();
  let store = await snapshotStore(vault, { label: 'fake' });
  let s = openSession(store, { enums, now: NOW });
  assert.equal(s.record({ topic: 'A', who: '我', when: '2026-10-13', what: '第一条' }).written, true);
  await store.flush();
  // 重新开快照（模拟插件每次录入都 openStore 一次）：旧时间线在盘上是 1 条
  assert.match(disk.get('A/时间线.md'), /1 条/);
  store = await snapshotStore(vault, { label: 'fake' });
  s = openSession(store, { enums, now: NOW });
  assert.equal(s.record({ topic: 'A', who: '我', when: '2026-10-12', what: '第二条' }).written, true);
  assert.match(store.read('A/时间线.md'), /2 条/, '旧主题追加事实后时间线应刷新为 2 条');
  await store.flush();
  assert.match(disk.get('A/时间线.md'), /2 条/);
});
