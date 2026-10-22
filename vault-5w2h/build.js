// 5W2H demo vault 生成器（**主题=目录** 形态）。
// 跑法：node vault-5w2h/build.js
// 走真实写入路径（core/record.js 的 openSession），每个主题产出一个自包含目录：
//   <主题>/_真源/facts.ndjson   append-only 真源
//   <主题>/事实/f-*.md          读模型（一条事实一个文件）
//   <主题>/<主题>.base          Bases 视图
//   <主题>/时间线.md / .html    可视化时间线
// 外加根级 .obsidian/types.json（属性类型，全局共享）、_体检.md（跨主题汇总）
// 和 _开始这里.md（2026-10-22 加：新用户解压 vault zip 后的第一触点——demo 数据是别人的，
// 60 秒导览负责让他把它变成自己的。没有这张纸，用户打开库面对 5 个陌生主题，第一个念头是"这啥"）。
// 架构不变：真源才是事实，Markdown/视图都是可随时重建的读模型。
import { rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsAdapter } from '../core/store.js';
import { openSession } from '../core/record.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const enums = JSON.parse(readFileSync(path.join(here, '../contract/enums-5w2h.json'), 'utf8'));

// 事实 = 5W2H。必填 who/when/what；可选 time/where/why/how/howmuch。没有 type、没有 主题 字段——
// 主题就是目录（一级公民）。同一主题的 howmuch 天然同一量纲：记账类是元、体重是 kg、旅行是元。
// 资金类主题的符号约定（2026-10-13 起）：负=出（支出/花费），正=进（收款/回款）——Sum 即净流量。
const seed = [
  // 一人公司CRM业务：客户接触，叙事为主，金额是项目额/回款（元）
  { topic: '一人公司CRM业务', who: '腾讯·老王', when: '2026-09-01', time: '10:00', what: '首次对接，聊了他们 CRM 替换的痛点：销售不愿记、管理层看不到', how: '会议', where: '客户现场', why: '推进决策' },
  { topic: '一人公司CRM业务', who: '明泰·明总', when: '2026-09-03', time: '14:00', what: '明总问报价，给了 30 万预算区间', how: '预算', why: '对齐需求', howmuch: 300000 },
  { topic: '一人公司CRM业务', who: '星河·李工', when: '2026-09-05', time: '09:15', what: '李工反馈 API 文档看不懂，约二次讲解', how: '邮件', why: '对齐需求' },
  { topic: '一人公司CRM业务', who: '内部·产品组', when: '2026-09-15', time: '10:00', what: '周会同步客户共性问题：都嫌录入麻烦、字段太多', how: '会议', where: '公司', why: '对齐需求' },
  { topic: '一人公司CRM业务', who: '腾讯·老王', when: '2026-10-06', time: '16:30', what: '合同细节敲定，金额 26 万，走集采', how: '合同', where: '客户现场', why: '推进决策', howmuch: 260000 },
  { topic: '一人公司CRM业务', who: '明泰·明总', when: '2026-10-08', time: '16:00', what: '明总付了首款 14 万', how: '付款', why: '催款', howmuch: 140000 },
  { topic: '一人公司CRM业务', who: '星河·李工', when: '2026-10-12', time: '09:00', what: '李工介绍同行朋友，潜在新客户，记一下', how: '微信', why: '关系维护' },

  // 公司记账：公司现金流（元）。收款为正、付款为负
  { topic: '公司记账', who: '我自己', when: '2026-09-10', time: '14:00', what: '阿杰 UI 外包初稿预付', how: '付款', why: '项目支出', howmuch: -8000 },
  { topic: '公司记账', who: '我自己', when: '2026-09-22', time: '11:00', what: '云服务器季度续费', how: '付款', why: '运营支出', howmuch: -1200 },
  { topic: '公司记账', who: '我自己', when: '2026-09-28', time: '15:00', what: '出差差旅报销', how: '付款', why: '运营支出', howmuch: -2300 },
  { topic: '公司记账', who: '我自己', when: '2026-10-08', time: '16:30', what: '收到明泰项目首款', how: '收款', why: '项目回款', howmuch: 140000 },
  { topic: '公司记账', who: '我自己', when: '2026-10-12', time: '14:30', what: '阿杰尾款结清，合作完', how: '付款', why: '项目支出', howmuch: -8000 },

  // 家庭记账：个人现金流（元）。消费为负、报销到账为正
  { topic: '家庭记账', who: '我自己', when: '2026-09-20', time: '18:00', what: '超市采买一周食材', how: '刷卡', why: '生活', howmuch: -386 },
  { topic: '家庭记账', who: '我自己', when: '2026-09-28', time: '20:00', what: '娃的绘画班月费', how: '微信', why: '教育', howmuch: -600 },
  { topic: '家庭记账', who: '我自己', when: '2026-10-02', time: '12:00', what: '国庆家庭聚餐', how: '刷卡', why: '生活', howmuch: -420 },
  { topic: '家庭记账', who: '我自己', when: '2026-10-05', time: '09:00', what: '国庆回老家高铁往返', how: '付款', why: '出行', howmuch: -1180 },
  { topic: '家庭记账', who: '我自己', when: '2026-10-09', time: '10:00', what: '出差报销到账', how: '收款', why: '报销', howmuch: 2300 },
  { topic: '家庭记账', who: '我自己', when: '2026-10-11', time: '19:00', what: '健身房季卡', how: '刷卡', why: '健康', howmuch: -900 },

  // 潮汕6日游：旅行花费（元，花出去的记负）
  { topic: '潮汕6日游', who: '我自己', when: '2026-10-10', time: '08:30', what: 'D1 高铁抵达汕头', how: '高铁', where: '汕头', why: '旅行', howmuch: -620 },
  { topic: '潮汕6日游', who: '我自己', when: '2026-10-10', time: '12:30', what: 'D1 小公园开埠区逛吃', how: '餐饮', where: '汕头', why: '旅行', howmuch: -180 },
  { topic: '潮汕6日游', who: '我自己', when: '2026-10-11', time: '21:00', what: 'D2 南澳岛环岛，住一晚', how: '住宿', where: '南澳岛', why: '旅行', howmuch: -480 },
  { topic: '潮汕6日游', who: '我自己', when: '2026-10-12', time: '18:30', what: 'D3 牛肉火锅收尾', how: '餐饮', where: '潮州', why: '旅行', howmuch: -260 },
  { topic: '潮汕6日游', who: '我自己', when: '2026-10-12', time: '20:00', what: '特产打包带回', how: '购物', where: '潮州', why: '旅行', howmuch: -350 },

  // 体重检测：体重（kg）
  { topic: '体重检测', who: '我自己', when: '2026-10-10', time: '07:00', what: '晨起称重', how: '测量', where: '家里', why: '健康管理', howmuch: 72.5 },
  { topic: '体重检测', who: '我自己', when: '2026-10-11', time: '07:00', what: '晨起称重', how: '测量', where: '家里', why: '健康管理', howmuch: 72.1 },
  { topic: '体重检测', who: '我自己', when: '2026-10-12', time: '07:00', what: '晨起称重，这周练得勤', how: '测量', where: '家里', why: '健康管理', howmuch: 71.8 },
];

const topicNames = [...new Set(seed.map((f) => f.topic))];
// 清掉上一轮产物：**所有**现存主题目录（按"有 _真源/facts.ndjson"判定，不只按种子名——
// 2026-10-13 实测教训：只按种子名清，用户试录的孤儿主题会在重建后存活，体检主题数对不上）
// + 旧的单库根级文件（事实/ _真源/ 事实.base 时间线* _体检.md）
for (const e of readdirSync(here, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  if (existsSync(path.join(here, e.name, '_真源', 'facts.ndjson'))) {
    rmSync(path.join(here, e.name), { recursive: true, force: true });
  }
}
for (const f of ['事实', '_真源', '事实.base', '时间线.md', '时间线.html', '_体检.md', '_开始这里.md']) {
  rmSync(path.join(here, f), { recursive: true, force: true });
}

// 首触导览：解压即读的第一张纸。三条铁律和 vault README 的"记错了怎么办"段呼应，
// 但那里是手册、这里是 60 秒——用户第一次打开库时不会去翻 README。
const START_HERE = `# 从这里开始

欢迎来到 solofact——**一条事实 = 一个文件**的 Obsidian 事实层。这个库里现在是**演示数据**，花 60 秒做完下面三件事，它就是你的了。

## 1 · 先看效果（30 秒）

文件树里任选一个主题目录进去（比如 \`一人公司CRM业务/\`），点开 \`一人公司CRM业务.base\`：八个视图——全部事实 / 按谁聚合 / 按在哪 / 按方式 / 按为何 / 时间线 / 正值记录 / 负值记录。再点开同目录的 \`时间线.md\`，看按月分段的时间线（每月一份小文件，记几年也打得开）。

## 2 · 删掉演示数据（10 秒）

把文件树里这五个演示主题目录**整个删掉**：一人公司CRM业务、公司记账、家庭记账、潮汕6日游、体重检测。删目录就是删主题，干脆——真源、视图、时间线都在目录里，一起走。

## 3 · 记你的第一条（20 秒）

点左侧边栏的**笔形图标**（或 Ctrl/Cmd+P 搜「记一条事实」）：

- **阶段一**：输入主题名（比如「我的副业」）→ 回车进入下一步
- **阶段二**：只填**谁 / 何时 / 发生了啥**三项就能存——time/where/why/how/howmuch 平铺在下面，可选，想到了再填
- **快捷键**：Ctrl/Cmd+Enter 随时提交；一天多笔用「记下来并继续」，录完不关窗

存盘后，该主题的真源、\`.base\` 视图、时间线自动生成。状态栏（右下角）会显示「**今日 N**｜主题…｜事实…」——今天记没记、记了几条，一眼可见。

## 三条铁律（违了会静默出问题）

1. **别用 Obsidian 自带的复制**（Ctrl/Cmd+D 复制事实文件）——真源不知情，副本会被体检报错、被重建清掉。以旧稿为底稿录新的，用插件命令「**复制这条事实**」；改内容用「**编辑这条事实**」。
2. **别直接改 \`事实/*.md\` 的内容**——Markdown 是读模型，真源是 \`<主题>/_真源/facts.ndjson\`，手改会被「从真源重建」静默抹掉。
3. **更新插件别整体覆盖库**——只把 \`solofact/\`（main.js + manifest.json）两个文件覆盖进 \`<你的库>/.obsidian/plugins/solofact/\`，你的数据一个字节不碰。

## 它在哪

- 体检报告：库根 \`_体检.md\`（点状态栏也能打开）
- 每主题的视图：\`<主题>/<主题>.base\`
- 每主题的时间线：\`<主题>/时间线.md\`（索引页，按月点进去）

> 这张纸本身就是演示库的一部分，删不删随你，不影响插件工作。
`;

const store = fsAdapter(here);
const s = openSession(store, { enums, now: Date.now() });
let ok = 0;
for (const f of seed) {
  const { topic, ...rest } = f;
  const r = s.record({ topic, ...rest });
  if (r.written) ok++;
  else console.error(`✗ 拒绝 ${topic}/${r.fact.id}:`, r.fatal.map((i) => `${i.code} ${i.message}`).join('；'));
}
const audit = s.auditAndReport('demo 事实库');
// 首触导览写在重建之后：和 _体检.md 一样是库根生成物，每次重建都刷新一份
store.write('_开始这里.md', START_HERE);
// 录完必须再重建一遍：record 的 ensureTopic 只在主题创建时写一次 .base/时间线（那时还是空的），
// 不重建的话 demo 里的时间线永远显示"0 条"、.base 也不是最终形态——2026-10-13 实测踩到
const rb = s.rebuild();
console.log(`5W2H demo（主题=目录）：${ok} 条事实 / ${topicNames.length} 个主题（录后已重建）`);
console.log(`  ${topicNames.map((t) => `${t} ${seed.filter((f) => f.topic === t).length}`).join('、')}`);
console.log(`  重建：${rb.written} 个事实文件｜致命 ${rb.fatal.length}｜告警 ${rb.warn.length}`);
console.log(`  体检：致命 ${audit.fatal.length}｜告警 ${audit.warn.length}`);
if (audit.fatal.length || rb.fatal.length) process.exitCode = 1;
