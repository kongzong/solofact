// 回归：每个主题的 <主题>.base 必须带「摘要」公式列——what 是长叙述，表格放不全，
// 用 formula 取前 40 字 + 省略号做一眼看全的预览（不依赖 Bases 行高设置，跨版本稳）。
// 主题=目录：base 只索引本主题的 事实/，且没有 type/主题 列、没有 per-type 汇总看板。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBase } from '../core/vault.js';

const TOPIC = '潮汕6日游';

test('主题 .base 含 摘要 公式（what 截断预览），且四个表格视图都引用它', () => {
  const base = buildBase(TOPIC);
  assert.match(base, /formulas:/, '必须有顶层 formulas 段');
  assert.match(base, /summary: 'if\(what\.length > 40, what\.slice\(0, 40\) \+ "…", what\)'/, '摘要公式须超 40 字截断加省略号');
  assert.match(base, /formula\.summary:\s*\n\s*displayName: 摘要/, 'properties 里注册 摘要 中文名');
  // 四张表格视图（全部事实 / 时间线 / 正值记录 / 负值记录）各引用一次 order 里的 formula.summary
  const refs = (base.match(/^\s*- formula\.summary$/gm) || []).length;
  assert.equal(refs, 4, `四张表格视图都应引用 formula.summary，实际 ${refs}`);
});

test('howmuch 拆正值/负值两张表（资金主题 进/出 各一本账）', () => {
  // 2026-10-13 用户反馈：单张「带多少的」正负混排看不出进出，拆开。
  const base = buildBase(TOPIC);
  assert.doesNotMatch(base, /name: 带多少的/, '旧的混合表已拆成正负两张');
  assert.match(base, /name: 正值记录[\s\S]*?- howmuch > 0/, '正值记录表必须用 howmuch > 0 过滤');
  assert.match(base, /name: 负值记录[\s\S]*?- howmuch < 0/, '负值记录表必须用 howmuch < 0 过滤');
});

test('主题 .base 只索引本主题目录，且不含 type/主题 维度', () => {
  const base = buildBase(TOPIC);
  assert.match(base, new RegExp(`file\\.inFolder\\("${TOPIC}/事实"\\)`), '过滤器必须指向本主题的 事实/ 目录');
  assert.doesNotMatch(base, /\n  主题:/, '主题=目录，frontmatter 不再有 主题 字段，base 不该有它');
  assert.doesNotMatch(base, /\n  type:/, 'type 这一级已去掉，base 不该有 type 属性列（视图的 "- type: table" 是 Bases 视图类型，不在此列）');
  assert.doesNotMatch(base, /汇总/, '没有 per-type 汇总看板了');
});
