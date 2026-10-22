// solofact 的插件壳（产品本体；v1 只写不看）。
// 这个文件里只允许出现两件事：Obsidian 的界面接线，和「把活交给 core」。
// 任何校验、任何落盘顺序、任何枚举判断出现在这里，都是第二个规则实现——那是本项目唯一不许发生的事。
// 规则实现在 core/{fact,vault,scan,record}.js，IO 在 core/adapters/vault.js，一份门锁两个门。
//
// 形态：**主题 = 目录**（一堆事实的上级目录）。录入分两阶段：先选/建主题，再录纯 5W2H（必填 who/when/what）。
// 没有 type 这一级——同主题内 howmuch 天然同义；没有主题 frontmatter 字段——主题从目录名推断。
import { Modal, Notice, Plugin, Setting, SuggestModal, TFolder, debounce } from 'obsidian';
import type { App, ButtonComponent, TFile, TextComponent } from 'obsidian';
import { snapshotStore } from '../core/adapters/vault.js';
import { DIR } from '../core/vault.js';
import { openSession } from '../core/record.js';
import enums5w2h from '../contract/enums-5w2h.json';

type Issue = { code: string; message: string; field?: string };

// 契约在安装后的插件里是只读的（打进 main.js）——这就是"契约要变成库内数据"的理由，
// 现在刻意还没做：等出现"用户要自己改枚举"的真实需求再说。

// 5W2H 字段的通用标签与提示（纯展示文案，不是规则——type 已去掉，字段不再按类型变）。
// 必填三项 label 带「（必填）」后缀（2026-10-22）：一屏可选字段里，不标出来就不知道
// 哪三个不填不让存——视觉标记比"看报错再猜"便宜。模式与阶段一主题行一致。
// tags 不在了（2026-10-22 移除）：实测全库 0% 填充，5W2H 本无此字段——
// 空候选的下拉是纯噪音，还占一行。
const FIELD_META: Record<string, { label: string; hint: string }> = {
  who: { label: '谁（必填）', hint: '跟谁：腾讯·老王 / 我自己 / 市图书馆…' },
  when: { label: '何时（必填）', hint: '发生日期 YYYY-MM-DD' },
  what: { label: '发生了啥（必填）', hint: '一句事实：能指着说"就是这个"的，不写判断' },
  time: { label: '时刻', hint: 'HH:mm，不知道就留默认' },
  where: { label: '在哪', hint: '地点：客户现场 / 江边公园 / 家里…' },
  why: { label: '为何', hint: '目的或性质：推进决策 / 记录习惯 / 健康管理…' },
  how: { label: '方式', hint: '怎么发生的：会议 / 微信 / 付款 / 运动…' },
  howmuch: { label: '多少', hint: '一个数：资金可负（负=出）/ 体重 / 里程 / 读数…单位写进正文' },
};

const AUDIT_DELAY_MS = 2000;
// 这些路径变了才值得重跑体检；_体检.md 是我们自己的产物，算进去会自激。
// 主题=目录：任何 <主题>/事实/ 或 <主题>/_真源/ 下的变动都算。
const WATCHED = [/\/事实\/[^/]+\.md$/, /\/_真源\/facts\.ndjson$/];

export default class SolofactPlugin extends Plugin {
  private status!: HTMLElement;
  private auditing = false;
  private dirtyStatus = false;
  // 防抖必须是**一个成员实例**：每次调用都新建 debounce() 的话，每个事件都拿到自己的计时器，
  // 2 秒后各跑一次体检——重建会连发几十个 modify，那就等于没有防抖
  private runDebounced: () => void = () => {};
  // 会话级候选累积（2026-10-15，A4）：刚写入的文件要等 metadataCache 索引才进候选，
  // 连记时下拉会缺刚记的值。壳自己记一份本会话见过的值，和缓存扫描合并——
  // 纯展示层缓存，不是规则（规则只有一份，在 core）。
  private historyExtra = new Map<string, Map<string, Set<string>>>();
  // 注：2026-10-22 曾在此存过「上次成功提交的 who」（插件级 data.json）——
  // 随「唯一才缺省」规则作废，机制整条删除（见 renderFactStage 的预填规则与 SPEC §4）。
  // 理由：字段里预先填着值，人会"扫一眼就过"而不是想"这次是谁"；最坏结果是
  // 假事实进了 append-only 真源。而"复用谁"这件事候选下拉本来就管着。

  onload() {
    this.runDebounced = debounce(() => void this.runAudit(false), AUDIT_DELAY_MS, true);

    this.status = this.addStatusBarItem();
    this.status.setText('solofact —');
    this.status.setAttr('title', `solofact：点这里看 ${DIR.report}`);
    this.registerDomEvent(this.status, 'click', () => void this.openFile(DIR.report));

    this.addRibbonIcon('square-pen', 'solofact：记一条事实', () => this.openRecord());

    this.addCommand({ id: 'solofact-record', name: '记一条事实', callback: () => this.openRecord() });
    this.addCommand({ id: 'solofact-audit', name: '跑体检（写 _体检.md）', callback: () => void this.runAudit(true) });
    this.addCommand({ id: 'solofact-rebuild', name: '从真源重建（会抹掉手改的 Markdown）', callback: () => this.confirmRebuild() });
    this.addCommand({ id: 'solofact-open-views', name: '打开某个主题的事实视图（.base）', callback: () => this.openTopicViews() });
    // 删除（2026-10-15）：对当前打开的事实笔记生效。手删 md 不管用——真源里那行还在，
    // 下次重建会把它复活；这是唯一的产品化删除路径（core 的真源压缩，壳先预览后确认）。
    this.addCommand({ id: 'solofact-forget', name: '删除这条事实（从真源移除，不可逆）', callback: () => void this.forgetActiveFact() });
    // 复制（2026-10-15）：以旧稿为底稿录一条新事实（when 照旧，用户自己改）。入口必须在插件——
    // Obsidian 自带复制是字节级复制文件、真源不知情：E_DUPLICATE_ID、时间线看不见、重建清掉。
    this.addCommand({ id: 'solofact-duplicate', name: '复制这条事实（以它为底稿录新的）', callback: () => void this.duplicateActiveFact() });
    // 编辑（2026-10-15）：用户想要的是"改这条"，形态上不提供原地改——真源只追加，改旧行就是篡改历史。
    // 内部实现 = 复制 + 删除：录一条改好的新事实，再删掉旧稿。顺序是硬的（先录后删）：
    // 任何一步失败，最坏态都是"库里两条"（用户看得见、删一条就好），反过来则是"一条都没了"。
    this.addCommand({ id: 'solofact-edit', name: '编辑这条事实（改内容，另存为新事实并删旧稿）', callback: () => void this.editActiveFact() });

    // 常驻体检：手改 Markdown 后没人再跑 体检，错误就静默——solocrm 那类失败的具体机制，这里堵掉
    const seen = (f: { path: string }) => this.onVaultChange(f.path);
    const v = this.app.vault;
    this.registerEvent(v.on('create', seen));
    this.registerEvent(v.on('modify', seen));
    this.registerEvent(v.on('delete', seen));
    // 改名只发 rename，不发 create/delete——事实文件一改名，wikilink 就断了，这正是体检要抓的。
    // onMaybeTopicRename 用 void + 自身 try/catch：它在同步链末尾，自己 throw 会污染整个事件回调；
    // 而且它是唯一弹 UI 的，异常必须变成 Notice，不能静默。
    // folder 事件打日志（诊断留档，2026-10-15 真机复现"改名无弹窗"时加的）：用户在 devtools
    // 一眼能看到事件到没到；子文件事件不打（folder 改名会逐个发，一百个文件就是一百行噪音）。
    this.registerEvent(
      v.on('rename', (f, oldPath) => {
        seen(f);
        this.onVaultChange(oldPath);
        if (f instanceof TFolder) console.log(`[solofact] folder rename: ${oldPath} -> ${f.path}`);
        void this.onMaybeTopicRename(f.path, oldPath);
        void this.onBaseRename(f.path);
      })
    );
    this.app.workspace.onLayoutReady(() => this.scheduleAudit());
  }

  onunload() {
    // 状态栏元素由宿主在 unload 时回收，这里不自己删
  }

  private onVaultChange(path: string) {
    if (!WATCHED.some((re) => re.test(path))) return;
    this.scheduleAudit();
  }

  private scheduleAudit() {
    this.runDebounced();
  }

  // 现有主题目录名：扫 <主题>/_真源/facts.ndjson 反推（同步，metadataCache 之外的直接 vault 扫描）。
  // 给录入表单的主题候选、以及"打开视图"命令用。
  topicsOf(): string[] {
    const out = new Set<string>();
    for (const f of this.app.vault.getFiles()) {
      const m = f.path.match(/^([^/]+)\/_真源\/facts\.ndjson$/);
      if (m) out.add(m[1]);
    }
    return [...out].sort();
  }

  // 录入成功后调用：把刚写的事实字段值记进会话级候选（A4）。
  rememberHistory(topic: string, fact: Record<string, unknown>) {
    let byField = this.historyExtra.get(topic);
    if (!byField) this.historyExtra.set(topic, (byField = new Map()));
    for (const field of ['who', 'time', 'where', 'why', 'how', 'howmuch']) {
      const v = fact[field];
      if (v == null || v === '') continue;
      let set = byField.get(field);
      if (!set) byField.set(field, (set = new Set()));
      for (const one of Array.isArray(v) ? v : [v]) {
        const s = String(one).trim();
        if (s) set.add(s);
      }
    }
  }

  // 会话级候选读取（A4）：historyOf 合并它，补上 metadataCache 还没索引到的刚录值。
  extraHistoryOf(field: string, topic: string): string[] {
    return [...(this.historyExtra.get(topic)?.get(field) ?? [])];
  }

  private openRecord() {
    new RecordModal(this.app, this).open();
  }

  private async openStore(bodies = false) {
    // 只取快照。主题目录的物理布局由 core 的 ensureTopic 在 record 时按需建，审计/重建不需要预建。
    // bodies=false（录入默认）：时间线从真源渲染后，录入链路不再需要 事实/*.md 的正文，
    // 全量预读整个库是白工——库越大录入越慢，而慢会劝退"坚持记"。体检/重建要逐条读回契约，才传 true。
    return snapshotStore(this.app.vault, { label: this.app.vault.getName(), bodies });
  }

  // 录入：表单值 → core 的同一份 record()。致命错误不写一个字节，由表单标回具体输入框。
  // 三段各自带阶段名：真机上出过"点记下来没反应"，异常在 await 链里被吞掉，界面一个字都没说。
  // 壳不许静默——静默正是这个项目要消灭的那类错误，所以宁可把"哪一步炸了"贴到脸上。
  async record(input: Record<string, unknown>): Promise<{ ok: boolean; topic: string; fact: Record<string, unknown>; fatal: Issue[]; warn: Issue[] }> {
    let store: Awaited<ReturnType<typeof snapshotStore>>;
    try {
      store = await this.openStore();
    } catch (e) {
      throw staged('读取库快照', e);
    }    let result: { written: boolean; topic: string; fact: Record<string, unknown>; fatal: Issue[]; warn: Issue[] };
    try {
      result = openSession(store, { enums: enums5w2h, now: Date.now() }).record(input);
    } catch (e) {
      throw staged('契约内核', e);
    }
    let flush: { configWrites: { path: string; ok: boolean; error?: string }[] };
    try {
      flush = await store.flush();
    } catch (e) {
      throw staged('写回宿主', e);
    }
    this.reportConfig(flush, store);
    this.scheduleAudit();
    return { ok: result.written, topic: result.topic, fact: result.fact, fatal: result.fatal, warn: result.warn };
  }

  async runAudit(announce: boolean) {
    if (this.auditing) {
      this.dirtyStatus = true;
      return;
    }
    this.auditing = true;
    try {
      do {
        this.dirtyStatus = false;
        const store = await this.openStore(true);
        const now = Date.now();
        const r = openSession(store, { enums: enums5w2h, now }).auditAndReport('事实库');
        const flush = await store.flush();
        this.reportConfig(flush, store);
        // 今日已记放状态栏第一项（2026-10-22）："坚持记"最需要的反馈是今天记没记、记了几条。
        // rows 扫的是 事实/*.md，录入 2 秒后的防抖体检自动带上新记的那条，无需另开 IO。
        // （cast 只是告诉 TS"fact 上有 when"——JS 内核的推断类型太窄，这不是第二份规则）
        const todayCount = r.rows.filter((x) => x.fact && (x.fact as { when?: string }).when === localDayText(now)).length;
        this.status.setText(`今日 ${todayCount}｜主题 ${r.topics.length}｜事实 ${r.rows.length}｜致命 ${r.fatal.length}｜告警 ${r.warn.length}`);
        this.status.setAttr('title', `solofact：点这里看 ${DIR.report}`);
        this.status.removeClass('solofact-clean');
        if (!r.fatal.length) this.status.addClass('solofact-clean');
        if (announce) {
          new Notice(`体检完成：主题 ${r.topics.length}｜事实 ${r.rows.length}｜致命 ${r.fatal.length}｜告警 ${r.warn.length}。报告在 ${DIR.report}`, 6000);
        }
      } while (this.dirtyStatus);
    } catch (e) {
      // 体检跑不起来必须让人看见：静默的体检等于没有体检
      const err = staged('体检', e);
      this.status.setText('solofact 体检失败');
      // Notice 只活 8 秒，真机上没人来得及看；错误原文必须留在悬停提示和控制台里
      this.status.setAttr('title', `solofact 体检失败：${err.message}（点这里看 ${DIR.report}）`);
      new Notice(`体检失败：${err.message}`, 8000);
    } finally {
      this.auditing = false;
    }
  }

  // 重建确认框一点就关，异常在那里没人能看见——和录入同一个理由：不许静默
  async rebuildFromTruth() {
    try {
      const store = await this.openStore(true);
      const r = openSession(store, { enums: enums5w2h, now: Date.now() }).rebuild();
      const flush = await store.flush();
      this.reportConfig(flush, store);
      new Notice(`已重建 ${r.topics.length} 个主题、${r.written} 个事实文件｜致命 ${r.fatal.length}｜告警 ${r.warn.length}`, 8000);
      this.scheduleAudit();
    } catch (e) {
      const err = staged('重建', e);
      this.status.setText('solofact 重建失败');
      new Notice(`${err.message}`, 12000);
    }
  }

  private confirmRebuild() {
    new ConfirmModal(
      this.app,
      '从真源重建',
      '每个主题的 Markdown、视图、属性类型注册表都会按它自己的 _真源/facts.ndjson 重新生成。你手工改过的那些读模型会被抹掉——这是设计：真源才是事实，读模型坏了不修，重建。',
      '确认重建',
      () => this.rebuildFromTruth()
    ).open();
  }

  // 视图现在按主题分（<主题>/<主题>.base），没有单一入口——列出全部主题让用户选，
  // 不再"按字母序打开第一个"（2026-10-15：主题多了以后第一个基本不是你想看的）。
  private openTopicViews() {
    const topics = this.topicsOf();
    if (!topics.length) {
      new Notice('还没有任何主题——先记一条事实，主题目录和 .base 就建起来了', 5000);
      return;
    }
    new TopicSuggestModal(this.app, topics, (topic) => void this.openFile(`${topic}/${topic}.base`)).open();
  }

  // 删除这条事实（2026-10-15）：对当前打开的事实笔记生效。壳只做接线——
  // 预览（core dryRun）、确认、执行（core remove 真源压缩+删 md+刷时间线）、刷新体检。
  private async forgetActiveFact() {
    try {
      const file = this.app.workspace.getActiveFile();
      const m = file?.path.match(/^([^/]+)\/事实\/(f-\d{8}-\d{4}-[0-9a-f]{4})\.md$/);
      if (!m) {
        new Notice('先打开一条事实笔记（<主题>/事实/f-*.md），再运行「删除这条事实」', 6000);
        return;
      }
      const [, topic, id] = m;
      const store = await this.openStore();
      const preview = openSession(store, { enums: enums5w2h, now: Date.now() }).remove({ topic, id, dryRun: true });
      if (!preview.fact) {
        new Notice(`没找到这条事实：${preview.fatal.map((f) => f.code).join(' ')}`, 6000);
        return;
      }
      const f = preview.fact;
      new ConfirmModal(
        this.app,
        '删除这条事实',
        `将从「${topic}」的真源里移除，不可逆（恢复靠库自己的 git）：\n\n${String(f.when ?? '')} ${String(f.who ?? '')} — ${String(f.content ?? f.what ?? '')}\n\n事实 md 会一并删除，时间线随之刷新。`,
        '确认删除',
        async () => {
          await this.removeFact(topic, id);
          new Notice(`✓ 已从「${topic}」删除 ${id}`, 5000);
        }
      ).open();
    } catch (e) {
      new Notice(staged('删除', e).message, 10000);
    }
  }

  // 真删一条事实（core 的真源压缩 + 删 md + 刷时间线），失败抛错由调用方贴到脸上。
  // 抽成方法是为了让"删除命令"和"编辑的收尾"共用同一条路径——删除只能有一个实现，
  // 两个调用点各写一遍就是规则分叉的起点。调用方负责预览/确认：这里是执行，不含交互。
  async removeFact(topic: string, id: string) {
    const store = await this.openStore();
    const r = openSession(store, { enums: enums5w2h, now: Date.now() }).remove({ topic, id });
    if (!r.removed) throw new Error(r.fatal.map((i) => `${i.code} — ${i.message}`).join('；'));
    const flush = await store.flush();
    this.reportConfig(flush, store);
    this.scheduleAudit();
  }

  // 复制这条事实（2026-10-15）：读当前打开的事实笔记 → duplicateDraft 生成草稿
  // （core 保证剥 id/time/recorded、when 照旧）→ 打开表单直接进阶段二（主题从路径
  // 解析后单设进草稿）。写入仍走 record() 正门：新 id 自动生成，真源/md/时间线/
  // 视图四层一致——这就是"插件复制"和"Obsidian 自带复制"的全部区别。
  //
  // 底稿**从真源按 (主题, id) 取**，不读 md（2026-10-15 真机教训后改）：真源才是事实，
  // md 是读模型。用户手改 md 后它可能缺字段，拿它当底稿会被校验拒掉，而最需要编辑的
  // 偏偏就是被改坏的那条——等于把纠正路径堵死，还和"手改 md 不算数"自相矛盾。
  // 复制和编辑共用这一份：底稿怎么来只能有一个实现。
  private async draftFromTruth(topic: string, id: string) {
    const draft = openSession(await this.openStore(), { enums: enums5w2h, now: Date.now() }).duplicateDraftFromTruth(topic, id);
    if (!draft) {
      new Notice(
        `真源里没有这条事实（${topic} / ${id}）——它可能是孤儿文件（手改过 id 或文件名）。跑一次「从真源重建」，或跑体检看看`,
        9000
      );
      return null;
    }
    return draft;
  }

  private async duplicateActiveFact() {
    try {
      const file = this.app.workspace.getActiveFile();
      const m = file?.path.match(/^([^/]+)\/事实\/(f-\d{8}-\d{4}-[0-9a-f]{4})\.md$/);
      if (!file || !m) {
        new Notice('先打开一条事实笔记（<主题>/事实/f-*.md），再运行「复制这条事实」', 6000);
        return;
      }
      const [, topic, id] = m;
      const draft = await this.draftFromTruth(topic, id);
      if (!draft) return;
      new RecordModal(this.app, this, { ...draft, topic }).open();
    } catch (e) {
      new Notice(staged('复制', e).message, 10000);
    }
  }

  // 编辑这条事实（2026-10-15）：和复制同一个底稿来源（draftFromTruth → 真源），
  // 差别只在提交之后——编辑要顺手把旧稿删掉（editing 传给表单，保存路径负责收尾）。
  // 表单里已经明说"另存为新事实 + 删旧稿、id 会变"，所以这里不再弹确认框：
  // 表单本身就是核对界面，再确认一次是把噪音当安全。
  private async editActiveFact() {
    try {
      const file = this.app.workspace.getActiveFile();
      const m = file?.path.match(/^([^/]+)\/事实\/(f-\d{8}-\d{4}-[0-9a-f]{4})\.md$/);
      if (!file || !m) {
        new Notice('先打开一条事实笔记（<主题>/事实/f-*.md），再运行「编辑这条事实」', 6000);
        return;
      }
      const [, topic, id] = m;
      const draft = await this.draftFromTruth(topic, id);
      if (!draft) return;
      new RecordModal(this.app, this, { ...draft, topic }, { topic, id }).open();
    } catch (e) {
      new Notice(staged('编辑', e).message, 10000);
    }
  }

  // 主题=目录：用户在宿主里重命名/搬家主题目录，<主题>.base 里写死的 file.inFolder("旧名/事实")
  // 不会跟着变——视图静默变空，而静默正是这个项目要消灭的东西。检测到主题目录改名就说明白，
  // 并给一键修复（重建：按新目录名重生成 .base/时间线，真源不动）。
  private async onMaybeTopicRename(newPath: string, oldPath: string) {
    // 主题目录的判据：新路径下直接带着 _真源/facts.ndjson，旧路径下没有了。
    // 主题内部的文件改名（旧/新 top-level 相同）天然不匹配；_真源/事实 目录自身被改名也不匹配
    // （它们的下一级才是 facts.ndjson，不是 _真源/facts.ndjson）——那种破坏重建也修不了，交给体检报。
    //
    // 用 adapter.exists（实时文件系统）而不是 getAbstractFileByPath（vault index）——2026-10-15
    // 真机复现：用户重启后改名主题目录仍无弹窗。根因是 folder rename 事件触发时 index 还在过渡态
    // （子文件的 rename 通知是随后才逐个发的），索引查新路径假阴性 → 判据第一关就 return →
    // 弹窗静默不弹，而这个功能的存在意义就是消灭"静默"。adapter.exists 直接问磁盘，绕开时序。
    // 已知边界：Obsidian 外的改名（文件管理器/终端）根本不发 rename 事件，那条路靠体检+重建兜底。
    const truthAt = (p: string) => this.app.vault.adapter.exists(`${p}/_真源/facts.ndjson`);
    try {
      const [hasNew, hasOld] = await Promise.all([truthAt(newPath), truthAt(oldPath)]);
      if (!hasNew || hasOld) return;
      new ConfirmModal(
        this.app,
        '主题目录被重命名了',
        `「${oldPath}」变成了「${newPath}」。该主题的 .base 里写死了旧目录名，不修复的话视图会静默变空。\n\n从真源重建会按新目录名重新生成 .base 和时间线（只重生成读模型，真源一个字节不动）。`,
        '重建修复',
        () => this.rebuildFromTruth()
      ).open();
    } catch (e) {
      new Notice(staged('检测主题改名', e).message, 10000);
    }
  }

  // 视图文件被改名——和目录改名是两种病：
  //   目录改名：base 里写死的 file.inFolder("旧名/事实") 不再命中 → **视图静默变空**（最要命的那种）
  //   base 改名：内容照常工作（查的是目录不是文件名），坏的是约定——插件按 <主题>/<主题>.base
  //              找它，找不到就等于这个主题没有视图入口；重建会把异名那份删掉重新生成正主。
  // 以前这两件事都静默（体检也报"全库干净"），现在体检有 W_BASE_NAME / W_BASE_MISSING 兜底，
  // 这里再当场补一句。给"改回原名"而不是"重建"：内容没坏，只是文件名错了，动真源是小题大做。
  private async onBaseRename(newPath: string) {
    const m = /^([^/]+)\/([^/]+)\.base$/.exec(newPath);
    if (!m) return;
    const [, topic, name] = m;
    if (name === topic) return;
    try {
      // 只管主题目录下的 .base：非主题的孤立 base（用户自己攒的）不打扰。
      if (!(await this.app.vault.adapter.exists(`${topic}/_真源/facts.ndjson`))) return;
      const file = this.app.vault.getAbstractFileByPath(newPath);
      if (!file) return;
      new ConfirmModal(
        this.app,
        '视图文件名必须是主题名',
        `主题「${topic}」的视图叫 \`${topic}.base\` 才算数（= 目录名），现在是 \`${name}.base\`。\n\n` +
          `不改回来会这样：插件的「打开某个主题的视图」按 "${topic}/${topic}.base" 找它——找不到；` +
          `下次记一条事实还会再补一份正主，目录里就有两个入口；跑「从真源重建」则会按主题名重生成正主、删掉这份。\n\n` +
          `好在内容没问题（视图里查的是目录名，不含文件名），把文件名改回去就完好如初，真源一个字节都不动。`,
        `改回 ${topic}.base`,
        async () => {
          // 必须用 vault.rename + 完整新路径，不能用 fileManager 那个只收文件名的改名 API：后者
          // 会把文件挪到"新文件的默认位置"（实际就是库根目录）而不是留在原文件夹——2026-10-15
          // 真机：点了「改回」，名字改对了，文件却跑到库根去了，主题目录里照样没有视图入口。
          // vault.rename 的目标已存在（正主也在）时宿主会抛——那就说明是"两份并存"，交给体检报。
          await this.app.vault.rename(file, `${topic}/${topic}.base`);
          new Notice(`已改回 ${topic}/${topic}.base`, 6000);
        }
      ).open();
    } catch (e) {
      new Notice(staged('检测视图改名', e).message, 10000);
    }
  }

  private async openFile(rel: string) {
    try {
      const af = this.app.vault.getAbstractFileByPath(rel);
      if (!af) {
        new Notice(`${rel} 还不存在——先记一条事实，库就建起来了`, 5000);
        return;
      }
      await this.app.workspace.getLeaf(true).openFile(af as TFile);
    } catch (e) {
      new Notice(staged('打开文件', e).message, 8000);
    }
  }

  // "能否由插件写 .obsidian/types.json"的实测出口：宿主如果不让写，
  // 兜底动作（在属性面板把 when/recorded 点成日期、howmuch 点成数字）是实测可行的，必须说给用户听。
  private reportConfig(flush: { configWrites: { path: string; ok: boolean; error?: string }[] }, store: { probe: { readError: string | null } }) {
    const blocked = flush.configWrites.filter((c) => !c.ok);
    if (blocked.length) {
      new Notice(
        `宿主不让插件写 ${blocked[0].path}（${blocked[0].error ?? '未知原因'}）。请在属性面板里把 when/recorded 点成「日期」、howmuch 点成「数字」，否则日期分组和数值汇总会静默失效。`,
        12000
      );
    }
    if (store.probe.readError) {
      // 未初始化的库里读 .obsidian 会失败（2026-10-22 人话化）：以前只报"读配置目录失败"，
      // 新用户完全不知道下一步干嘛。demo vault 是解压即用的参照物，CLI init 是另一条路。
      new Notice(
        `读不了库的配置目录：${store.probe.readError}。这通常说明库还没初始化——新用户建议直接用 demo vault（解压即用）；老库可在库里跑一次 CLI「solofact init」再录。`,
        12000
      );
    }
  }
}

class RecordModal extends Modal {
  private draft: Record<string, unknown> = {};
  private settings: Record<string, Setting> = {};
  private fieldHints: Record<string, string> = {};
  private errorEl!: HTMLElement;
  private okBtn!: ButtonComponent;
  private keepBtn!: ButtonComponent;
  private cancelBtn!: ButtonComponent;
  private submitting = false;
  // 两阶段（2026-10-13 用户定调）：阶段一选/建主题，阶段二录事实。
  // 主题在阶段一定下后不再变（要变就"换主题"回阶段一）——阶段二的候选全部按它取，
  // 没有"主题随时可改、候选随时重挂"的中间态，表单因此少一整段逻辑。
  private stage: 'topic' | 'fact' = 'topic';
  private topic = '';

  // initial 是「复制这条事实」的预填草稿（2026-10-15）：带了主题就直接进阶段二，
  // 用户落在填满的表单上只改要改的。注意 TS 字段初始化器在构造体之前跑——
  // 这里的赋值晚于 `draft = {}`，initial 生效；反过来写会被初始化器盖掉。
  // editing（2026-10-15）：编辑模式的收尾凭据——旧稿的坐标 {topic, id}，保存成功后删它。
  // 刻意不塞进 initial（那是纯事实字段的草稿）：旧 id 一旦混进草稿就是 E_DUPLICATE_ID，
  // duplicateDraft 已从源头剥掉它，这里也不该再有一个"草稿里带着 id"的通道。
  constructor(
    app: App,
    private plugin: SolofactPlugin,
    private initial?: Record<string, unknown>,
    private editing?: { topic: string; id: string }
  ) {
    super(app);
    if (initial) this.draft = { ...initial };
  }

  onOpen() {
    this.contentEl.addClass('solofact-record');
    // who 不在这里预填（2026-10-22 用户拍板「唯一才缺省」）：预填只在阶段二做，
    // 因为规则是**本主题**层面的（见 renderFactStage）。复制/编辑入口带 initial，
    // 底稿里的 who 是旧稿的，任何预填都会悄悄改掉要复制的内容。
    // 键盘流（2026-10-22）：Ctrl/Cmd+Enter = 提交 / 阶段一下一步。what 是 textarea，
    // 裸 Enter 必须留给换行，所以这里只劫持组合键；阶段一的裸 Enter 挂在主题框自己的
    // keydown 上（要避开 datalist"选中第一项"的默认语义，见 comboMatchesSuggestion）。
    this.contentEl.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' || (!ev.metaKey && !ev.ctrlKey)) return;
      ev.preventDefault();
      if (this.stage === 'topic') this.advance();
      else void this.submit(false);
    });
    // 草稿带主题 = 复制入口：跳过阶段一（主题已锁，行内「换主题」仍可回退重选）
    if (String(this.draft.topic ?? '').trim()) {
      this.topic = String(this.draft.topic);
      this.renderFactStage();
    } else {
      this.renderTopicStage();
    }
  }

  // ── 阶段一：选主题 ────────────────────────────────────────────
  // 现有主题列出来选，也能直接输个新名字——新目录由 core 的 ensureTopic 在写入时就地建。
  // 主题名合不合法永远是 core 的事（提交时 E_BAD_TOPIC 标红主题行）；这里只把"非空"当推进条件。
  private renderTopicStage() {
    this.stage = 'topic';
    this.setTitle('记一条事实 · 选主题');
    const el = this.contentEl;
    el.empty();
    const d = this.draft;
    // errorEl 先建：下面主题框 setValue 会同步触发 onChange→clearErrors，建晚了就踩空
    this.errorEl = el.createDiv({ cls: 'solofact-errors' });

    this.settings.topic = this.add(el, '主题（必填）', '选一个现有主题，或输个新主题名——新目录就地建出来', 'topic', (s) =>
      s.addText((t) => {
        t.setPlaceholder('潮汕6日游');
        this.attachCombo(t.inputEl, this.plugin.topicsOf());
        if (d.topic) t.setValue(String(d.topic));
        t.onChange((v) => {
          d.topic = v;
          this.clearErrors();
          this.okBtn?.setDisabled(!v.trim());
        });
        // 回车 = 下一步（2026-10-22）。datalist 弹出时浏览器 Enter 的默认动作是选中第一项：
        // 输入值与某个候选完全相等才拦截（主题已定，前进无损失），否则放行让浏览器选。
        t.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
          if (ev.key !== 'Enter' || ev.shiftKey || ev.metaKey || ev.ctrlKey) return;
          if (!comboMatchesSuggestion(t.inputEl)) return;
          ev.preventDefault();
          this.advance();
        });
      })
    );

    new Setting(el)
      .addButton((b) => {
        this.cancelBtn = b.setButtonText('取消').onClick(() => this.close());
      })
      .addButton((b) => {
        this.okBtn = b.setButtonText('下一步：记事实').setCta().onClick(() => this.advance());
      });
    this.okBtn.setDisabled(!String(d.topic ?? '').trim());
    el.createEl('p', {
      text: '回车进入下一步 · Ctrl/Cmd+Enter 也可以',
      attr: { style: 'color:var(--text-muted);font-size:0.8em;margin:6px 0 0;' },
    });
  }

  // 阶段一→二：主题定了，才谈得上"同主题历史候选"。
  private advance() {
    const topic = String(this.draft.topic ?? '').trim();
    if (!topic) return; // 空主题时按钮是禁用的，这里只是兜底
    this.topic = topic;
    this.renderFactStage();
  }

  // ── 阶段二：录事实 ────────────────────────────────────────────
  // 主题行锁起来（附"换主题"回去），其后纯 5W2H：必填 who/when/what，其余可选自由填。
  // 输入框里不放占位提示——字段描述就在行内（setDesc）；候选只挂同主题历史（词汇内聚）。
  private renderFactStage() {
    this.stage = 'fact';
    this.setTitle(this.editing ? `编辑这条事实 · ${this.topic}` : `记一条事实 · ${this.topic}`);
    const el = this.contentEl;
    el.empty();
    const d = this.draft;
    const topic = this.topic;
    this.errorEl = el.createDiv({ cls: 'solofact-errors' });

    // 编辑模式把机制写在脸上：不是"改旧行"，是"另存新行 + 删旧行"。用户得知道 id 会变
    // （别处若链接过这条会断），也得知道取消是零副作用的——这两件事不知道，编辑就不敢点。
    if (this.editing) {
      el.createEl('p', {
        text: '编辑 = 以改好的内容另存为新事实，再删掉旧稿（真源只追加，旧内容不会被改写）。底稿取自真源——你若手改过这条的 Markdown，这里显示的是真源里那条，以你改完保存的为准。保存后 id 会变，别处若有指向旧稿的链接要更新；取消则原封不动。',
        attr: { style: 'color:var(--text-muted);font-size:0.9em;margin:0 0 10px;line-height:1.5;' },
      });
    }

    // 主题行：锁定显示 + 换主题。settings.topic 指着它——提交时 E_BAD_TOPIC 之类标红这一行。
    this.settings.topic = this.add(el, '主题', topic, 'topic', (s) =>
      s.addButton((b) => b.setButtonText('换主题').onClick(() => this.renderTopicStage()))
    );

    // 必填三项：who / when / what。候选按当前主题取；来过的值留着（换主题再回来不丢）。
    this.settings.who = this.add(el, FIELD_META.who.label, FIELD_META.who.hint, 'who', (s) =>
      s.addText((t) => {
        const whoHistory = this.historyOf('who', topic);
        this.attachCombo(t.inputEl, whoHistory);
        // **「唯一才缺省」**（2026-10-22 用户拍板）：本主题至今只出现过一个 who 时预填它；
        // 出现 2 个以上取值就**不预填**——"复用谁"由候选下拉承担（拉：用户主动选），
        // 缺省是推（系统替他填），推错的代价是**假事实进了 append-only 真源**，
        // 而字段里已经填着东西会让人"扫一眼就过"（确认偏误），不再想"这次是谁"。
        // 规则收益：单人库（谁恒为"我自己"）零摩擦且不可能填错；多方库不给错记的机会。
        // 新主题录第一条 → 之后变"唯一" → 从第二条起自动缺省（自举，不需要额外机制）。
        // 只兜 null：用户动过这个框（含清空成 ''）是明确意图，不替他回填。
        if (d.who == null && whoHistory.length === 1) d.who = whoHistory[0];
        if (d.who != null) t.setValue(String(d.who));
        t.onChange((v) => (d.who = v));
      })
    );
    this.settings.when = this.add(el, FIELD_META.when.label, FIELD_META.when.hint, 'when', (s) =>
      s.addText((t) => {
        t.inputEl.type = 'date';
        if (d.when == null) d.when = localDayText();
        t.setValue(String(d.when));
        t.onChange((v) => (d.when = v));
      })
    );
    this.settings.what = this.add(el, FIELD_META.what.label, FIELD_META.what.hint, 'what', (s) =>
      s.addTextArea((t) => {
        t.inputEl.rows = 4;
        if (d.what != null) t.setValue(String(d.what));
        t.onChange((v) => (d.what = v));
      })
    );
    // showErrors 里 E_EMPTY_BODY 的 field 是 'content'（正文），让它也指向这一行
    this.settings.content = this.settings.what;
    this.fieldHints.content = this.fieldHints.what;

    // 可选维度：想到了才填，不填不报错。候选同样只来自当前主题。
    // （2026-10-22 折叠区当日回退，用户拍板「5W2H 字段个个都挺重要」：折叠等于把录入提示
    //  藏了，还每次多一次展开点击——省下的视觉成本转嫁成交互税。全部平铺，一屏看全；
    //  「必填只有 3 项」靠行内字段说明传达，不靠藏字段。）
    this.settings.time = this.add(el, FIELD_META.time.label, FIELD_META.time.hint, 'time', (s) =>
      s.addText((t) => {
        this.attachCombo(t.inputEl, this.historyOf('time', topic));
        if (d.time == null) d.time = localHHMMText();
        t.setValue(String(d.time));
        t.onChange((v) => (d.time = v));
      })
    );
    this.settings.where = this.add(el, FIELD_META.where.label, FIELD_META.where.hint, 'where', (s) =>
      s.addText((t) => {
        this.attachCombo(t.inputEl, this.historyOf('where', topic));
        if (d.where != null) t.setValue(String(d.where));
        t.onChange((v) => (d.where = v));
      })
    );
    this.settings.why = this.add(el, FIELD_META.why.label, FIELD_META.why.hint, 'why', (s) =>
      s.addText((t) => {
        this.attachCombo(t.inputEl, this.historyOf('why', topic));
        if (d.why != null) t.setValue(String(d.why));
        t.onChange((v) => (d.why = v));
      })
    );
    this.settings.how = this.add(el, FIELD_META.how.label, FIELD_META.how.hint, 'how', (s) =>
      s.addText((t) => {
        this.attachCombo(t.inputEl, this.historyOf('how', topic));
        if (d.how != null) t.setValue(String(d.how));
        t.onChange((v) => (d.how = v));
      })
    );
    this.settings.howmuch = this.add(el, FIELD_META.howmuch.label, FIELD_META.howmuch.hint, 'howmuch', (s) =>
      s.addText((t) => {
        t.inputEl.type = 'number';
        this.attachCombo(t.inputEl, this.historyOf('howmuch', topic));
        if (d.howmuch != null) t.setValue(String(d.howmuch));
        t.onChange((v) => (d.howmuch = v));
      })
    );

    // 按钮条：取消 → （连记）→ 主按钮。顺序即视觉顺序，所以连记那颗只能整颗不建。
    const bar = new Setting(el).addButton((b) => {
      this.cancelBtn = b.setButtonText('取消').onClick(() => this.close());
    });
    // 「记下来并继续」在编辑模式下**必须不调用 addButton** 而不是在回调里 return：
    // addButton 先建 DOM 再执行回调，回调 return 只让它没有文字——按钮照样躺在界面上
    // （2026-10-15 真机：编辑表单右下角多出一颗空壳按钮，就是这么来的）。
    if (!this.editing) {
      // 连记（A1）：记账/CRM 一天多笔，不用每笔重走两阶段。
      // 编辑模式不给这颗：一次编辑对应一条事实，"保存完再存一份改稿"没有语义。
      bar.addButton((b) => {
        this.keepBtn = b.setButtonText('记下来并继续').onClick(() => void this.submit(true));
      });
    }
    bar.addButton((b) => {
      this.okBtn = b.setButtonText(this.editing ? '保存修改' : '记下来').setCta().onClick(() => void this.submit(false));
    });
    el.createEl('p', {
      text: '快捷键：Ctrl/Cmd+Enter 提交',
      attr: { style: 'color:var(--text-muted);font-size:0.8em;margin:6px 0 0;' },
    });
  }

  // 一行就是一个输入框：name 是字段名，hint 是它的说明（清空错误时还原回去），key 是 settings 的索引。
  private add(el: HTMLElement, name: string, hint: string, key: string, build: (s: Setting) => Setting): Setting {
    const s = new Setting(el).setName(name);
    s.setDesc(hint);
    this.fieldHints[key] = hint;
    return build(s);
  }

  // 输选框：历史候选来自库里已有的同名字段值，也能随手键入新值——自由录入与聚合复用统一在这一个框里。
  private attachCombo(input: HTMLInputElement, history: string[]) {
    const old = input.getAttribute('list');
    if (old) {
      this.contentEl.querySelector(`datalist#${old}`)?.remove();
      input.removeAttribute('list');
    }
    if (!history.length) return;
    const listId = `solofact-combo-${Math.random().toString(36).slice(2, 8)}`;
    const dl = this.contentEl.createEl('datalist', { attr: { id: listId } });
    for (const v of history) dl.createEl('option', { value: v });
    input.setAttr('list', listId);
  }

  // 历史候选：读 事实/*.md 的 frontmatter 里某个字段，按出现频次排序（2026-10-15，A2——
  // 常联系的人/常去的地点排在前面，聚合复用率才高；字母序把高频值埋了）。
  // 用宿主已索引的 metadataCache，同步可取。topic 给定时只取该主题目录下的历史——
  // 每个主题的 who/where/why/how/多少 词汇内聚，不跨主题混。顺带接受数字值和标签数组。
  // 会话级累积（plugin.rememberHistory 写入）合并进来：刚录的文件还没进索引，别让候选缺了它。
  private historyOf(field: string, topic?: string): string[] {
    const counts = new Map<string, number>();
    const bump = (v: unknown) => {
      for (const one of Array.isArray(v) ? v : [v]) {
        const s = String(one ?? '').trim();
        if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    };
    const prefix = topic ? `${topic}/事实/` : null;
    for (const f of this.app.vault.getFiles()) {
      if (!f.path.endsWith('.md')) continue;
      if (prefix) {
        if (!f.path.startsWith(prefix)) continue;
      } else if (!/\/事实\/[^/]+\.md$/.test(f.path)) {
        continue;
      }
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm) bump(fm[field]);
    }
    if (topic) {
      for (const v of this.plugin.extraHistoryOf(field, topic)) {
        if (!counts.has(v)) counts.set(v, 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([v]) => v);
  }

  // 一次点击只许跑一次写入，而且必须让按钮显示"写入中…"：
  // 之前"点了没反应"就是异常被 void 掉＋按钮从不给反馈，两层叠加的结果。
  // keepOpen（2026-10-15，A1）：记完不关窗，清掉叙事/数值、时刻重置，场景字段留着，接着记。
  private async submit(keepOpen = false) {
    if (this.submitting) return;
    this.submitting = true;
    this.setBusy(true);
    try {
      const input: Record<string, unknown> = { ...this.draft };
      // tags 在壳里拆成数组再交给 core：契约的 normalize 只认数组，字符串会连逗号一起
      // 被引号包住变成一个标签（"a, b"），那既不是聚合也不是录入自由，是脏数据。
      if (typeof input.tags === 'string') {
        input.tags = input.tags
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const result = await this.plugin.record(input);
      if (!result.ok) {
        this.showErrors(result.fatal);
        return;
      }
      this.clearErrors();
      this.plugin.rememberHistory(result.topic, result.fact);
      const id = String(result.fact.id);
      for (const w of result.warn) new Notice(`⚠ ${w.code} — ${w.message}（已写入，告警不阻断；体检会一直报到它消失）`, 7000);
      if (keepOpen && !this.editing) {
        // 重渲染阶段二：候选刷新（含刚记的值，A4）、输入框归零、焦点回到正文
        this.draft.what = '';
        this.draft.howmuch = '';
        this.draft.tags = input.tags;
        this.draft.time = localHHMMText();
        this.renderFactStage();
        this.settings.what.settingEl.querySelector('textarea')?.focus();
        new Notice(`✓ 已记 ${id}，继续记下一条`, 3000);
        return;
      }
      // 编辑收尾：副本已经落盘，这会儿才删旧稿。顺序是硬的（先录后删）——
      // 任何一步失败，最坏都是"库里两条都在"（看得见、删一条就好）；
      // 反过来先删后录，一次失败就是这条事实彻底没了，那才叫不可恢复。
      if (this.editing) {
        const old = this.editing;
        try {
          await this.plugin.removeFact(old.topic, old.id);
          new Notice(`✓ 已保存为 ${result.topic}/事实/${id}.md，旧稿 ${old.id} 已删除（id 变了，别处若有链接要更新）`, 6000);
        } catch (e) {
          // 副本在、旧稿也在——不是数据丢失，但必须说清楚：不说的话用户以为编辑没生效，库里却躺着两条
          new Notice(
            `⚠ 改好的事实已保存为 ${id}，但删旧稿失败：${String((e as Error)?.message ?? e)}。库里现在两条都在（旧稿 ${old.id} 未删），请对旧稿运行「删除这条事实」收尾。`,
            15000
          );
        }
        this.close();
        return;
      }
      new Notice(`✓ ${result.topic}/事实/${id}.md`, 4000);
      this.close();
    } catch (e) {
      // 崩溃（不是契约拒绝）也绝不静默：窗口留着，错误标红，控制台留栈
      this.showFatalCrash(String((e as Error)?.message ?? e));
    } finally {
      this.submitting = false;
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean) {
    const okLabel = this.editing ? '保存修改' : '记下来';
    this.okBtn?.setDisabled(busy);
    this.cancelBtn?.setDisabled(busy);
    this.keepBtn?.setDisabled(busy);
    this.okBtn?.setButtonText(busy ? (this.editing ? '保存中…' : '写入中…') : okLabel);
    this.keepBtn?.setButtonText(busy ? '写入中…' : '记下来并继续');
  }

  private showFatalCrash(message: string) {
    this.clearErrors();
    this.errorEl.createDiv({
      text: `✗ 写入没完成：${message}。这不是契约拒绝，是插件自己出错了——按 Ctrl/Cmd+Shift+I 打开控制台看 solofact 那条堆栈。`,
      attr: { style: 'color:var(--text-error);font-weight:600;' },
    });
  }

  private showErrors(issues: Issue[]) {
    this.clearErrors();
    this.errorEl.createDiv({
      text: `✗ 没写进去：${issues.length} 条致命错误。改字段，不是改枚举。`,
      attr: { style: 'color:var(--text-error);font-weight:600;' },
    });
    for (const i of issues) {
      const s = i.field ? this.settings[i.field] : undefined;
      if (s) {
        s.descEl.setText(`${i.code} — ${i.message}`);
        s.descEl.style.color = 'var(--text-error)';
        s.descEl.style.fontWeight = '600';
        markRowBad(s.settingEl);
      } else {
        this.errorEl.createDiv({
          text: `${i.code} — ${i.message}`,
          attr: { style: 'color:var(--text-error);font-weight:600;' },
        });
      }
    }
  }

  private clearErrors() {
    this.errorEl.empty();
    for (const [key, s] of Object.entries(this.settings)) {
      s.descEl.style.removeProperty('color');
      s.descEl.style.removeProperty('font-weight');
      unmarkRow(s.settingEl);
      const hint = this.fieldHints[key];
      if (hint != null && s.descEl.getText() !== hint) s.descEl.setText(hint);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private okLabel: string,
    private onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.title);
    this.contentEl.createEl('p', { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.okLabel)
          .setDestructive()
          .setCta()
          .onClick(() => void this.confirmAndClose())
      );
  }

  // 注入的回调可能是长任务：等它跑完再关，异常一律接住——"一点就关、错误跟着窗口一起消失"是不可接受的
  private async confirmAndClose() {
    try {
      await this.onConfirm();
    } catch (e) {
      new Notice(staged('确认的动作', e).message, 12000);
    } finally {
      this.close();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 主题选择器：列出现有主题，过滤 + 回车打开对应 <主题>.base。
// 宿主原生 SuggestModal，零自绘——和"插件只写不看"一致：这里只是个打开文件的岔路口。
class TopicSuggestModal extends SuggestModal<string> {
  private all: string[];
  private onPick: (topic: string) => void;

  constructor(app: App, topics: string[], onPick: (topic: string) => void) {
    super(app);
    this.all = topics;
    this.onPick = onPick;
    // 不设 setPlaceholder：插件静态守卫锁着"输入框不塞占位提示"，选择器面板也不算例外——
    // 空查询时本来就列出全部主题，不需要那行灰字。
  }

  getSuggestions(query: string): string[] {
    const q = query.trim();
    return q ? this.all.filter((t) => t.includes(q)) : this.all;
  }

  renderSuggestion(topic: string, el: HTMLElement) {
    el.setText(topic);
  }

  onChooseSuggestion(topic: string) {
    this.onPick(topic);
  }
}

// input[list] 的 datalist 弹出时，浏览器 Enter 的默认动作是"选中高亮项"。没有标准 API
// 查询弹没弹，用启发式：输入值与某个候选完全相等 → 已选定（Enter 前进无损失）；
// 否则不动，让浏览器完成选择——用户下一个 Enter 值已匹配，自然前进。
function comboMatchesSuggestion(input: HTMLInputElement): boolean {
  const listId = input.getAttribute('list');
  if (!listId) return true;
  const dl = input.ownerDocument.getElementById(listId);
  if (!dl) return true;
  const v = input.value.trim();
  return [...dl.querySelectorAll('option')].some((o) => o.value === v);
}

// 标红不依赖任何注入的 <style> 或 CSS class：直接给输入框（Setting 行）设内联样式。
// 原因：启动时往 document.head 注入 <style> 在某些 Obsidian 环境会导致宿主加载期崩溃——
// 内联 style 零依赖、零注入，绝对不会因为「样式注入」而把宿主拖垮。
function markRowBad(el: HTMLElement) {
  el.style.borderLeft = '3px solid var(--text-error)';
  el.style.backgroundColor = 'rgba(var(--background-modifier-error-rgb), 0.16)';
  el.style.borderRadius = '4px';
}
function unmarkRow(el: HTMLElement) {
  el.style.removeProperty('border-left');
  el.style.removeProperty('background-color');
  el.style.removeProperty('border-radius');
}

// 本地日期/时刻：和 core/record.js 同一套格式，这里只是给输入框预填
function pad(n: number) {
  return String(n).padStart(2, '0');
}
function localDayText(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localHHMMText(ms = Date.now()) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 真机上出过"点记下来没反应"：异常在 await 链里被 void 掉，界面一个字都不说。
// 壳不许静默——静默就是这个项目要消灭的那类错误，所以失败必须带阶段名贴到脸上。
function staged(stage: string, e: unknown): Error {
  console.error(`solofact ${stage}`, e);
  return new Error(`${stage}失败：${String((e as Error)?.message ?? e)}`);
}
