// 时间线的性能基准：直接写真源造假数据，量一次「时间线刷新」各步骤的成本。
// 用法：node scripts/bench-timeline.mjs [条数]   （npm run bench -- 3000）
//
// 为什么不用"逐条录入"来造数据：那条路径每次都会顺带重写整个主题的时间线，累积下来测的是
// 自己的 O(N) 退化，不是我们要量的东西。这里把 N 条**直接写进真源**，然后单独计时每一步：
// 读真源 / 渲染 md / 渲染 html / 以及"如果按月分段、单段会有多大"。
//
// 结论要盯的两个数：**渲染耗时**（Node 侧）和**产物体积**（宿主侧）——真正的瓶颈从来是
// 后者：Obsidian 打开一个 1MB 的 callout 列表会卡到不可用，而那边的计算只要零点几秒。
//
// 因为那个结论，时间线已经改成按月分段（2026-10-15 的形态变更）：这里最后一行的
//「按月分段后·单段规模」就是改造后的对照值——它几乎不随 N 增长，也就是每次录入的成本。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsAdapter } from '../core/store.js';
import { readTruth, renderTimeline, renderTimelineHtml } from '../core/vault.js';

const N = Number(process.argv[2] || 10000);
const topic = '公司记账';
const dir = mkdtempSync(path.join(os.tmpdir(), 'solofact-perf-'));
const pad = (n) => String(n).padStart(2, '0');

mkdirSync(path.join(dir, topic, '_真源'), { recursive: true });
const lines = [];
for (let i = 0; i < N; i++) {
  const when = 2019 + (i % 7) + '-' + pad((i % 12) + 1) + '-' + pad((i % 28) + 1);
  lines.push(
    JSON.stringify({
      id: 'f-' + String(i).padStart(6, '0') + '-abcd',
      who: ['甲', '乙', '丙', '丁'][i % 4],
      when,
      time: '10:00',
      what: '第 ' + i + ' 条：去客户那边谈了下季度的续约，中间顺便聊了他们新上的系统要不要接入',
      howmuch: -9,
      recorded: '2026-10-15T12:00:00.000Z',
    })
  );
}
writeFileSync(path.join(dir, topic, '_真源', 'facts.ndjson'), lines.join('\n') + '\n');

const store = fsAdapter(dir);
console.log('=== ' + N + ' 条 · 时间线「一次刷新」的成本分解 ===');
let t = Date.now();
const truth = readTruth(store, topic);
console.log('readTruth 读真源        ' + (Date.now() - t) + ' ms（' + truth.length + ' 行）');

t = Date.now();
const md = renderTimeline(truth.map((f) => ({ ...f, date: f.when })));
console.log('renderTimeline 计算     ' + (Date.now() - t) + ' ms → md ' + (md.length / 1024).toFixed(0) + 'KB / ' + md.split('\n').length + ' 行');

t = Date.now();
const html = renderTimelineHtml(truth.map((f) => ({ ...f, date: f.when })));
console.log('renderTimelineHtml 计算 ' + (Date.now() - t) + ' ms → html ' + (html.length / 1024).toFixed(0) + 'KB');

// 如果按月分段：当月（最新那一段）的规模
const cur = truth.filter((f) => String(f.when).startsWith('2025-12'));
const mdSeg = renderTimeline(cur.map((f) => ({ ...f, date: f.when })));
console.log('按月分段后·单段规模     ' + cur.length + ' 条 → md ' + (mdSeg.length / 1024).toFixed(1) + 'KB');
rmSync(dir, { recursive: true, force: true });
