// solofact 的插件壳（产品本体；v1 只写不看）。
// 这个文件里只允许出现两件事：Obsidian 的界面接线，和「把活交给 core」。
// 任何校验、任何落盘顺序、任何枚举判断出现在这里，都是第二个规则实现——那是本项目唯一不许发生的事。
// 规则实现在 core/{fact,vault,scan,record}.js，IO 在 core/adapters/vault.js，一份门锁两个门。
//
// 形态：**主题 = 目录**（一堆事实的上级目录）。录入分两阶段：先选/建主题，再录纯 5W2H（必填 who/when/what）。
// 没有 type 这一级——同主题内 howmuch 天然同义；没有主题 frontmatter 字段——主题从目录名推断。
import { Modal, Notice, Plugin, Setting, debounce } from 'obsidian';
import type { App, ButtonComponent, TFile, TextComponent } from 'obsidian';
import { snapshotStore } from '../core/adapters/vault.js';
import { DIR } from '../core/vault.js';
import { openSession } from '../core/record.js';
import enums5w2h from '../contract/enums-5w2h.json';

type Issue = { code: string; message: string; field?: string };

// 契约在安装后的插件里是只读的（打进 main.js）——这就是"契约要变成库内数据"的理由，
// 现在刻意还没做：等出现"用户要自己改枚举"的真实需求再说。

// 5W2H 字段的通用标签与提示（纯展示文案，不是规则——type 已去掉，字段不再按类型变）。
const FIELD_META: Record<string, { label: string; hint: string }> = {
  who: { label: '谁', hint: '跟谁：腾讯·老王 / 我自己 / 市图书馆…' },
  when: { label: '何时', hint: '发生日期 YYYY-MM-DD' },
  what: { label: '发生了啥', hint: '一句事实：能指着说"就是这个"的，不写判断' },
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
    this.addCommand({ id: 'solofact-open-views', name: '打开某个主题的事实视图（.base）', callback: () => void this.openFirstTopicView() });

    // 常驻体检：手改 Markdown 后没人再跑 体检，错误就静默——solocrm 那类失败的具体机制，这里堵掉
    const seen = (f: { path: string }) => this.onVaultChange(f.path);
    const v = this.app.vault;
    this.registerEvent(v.on('create', seen));
    this.registerEvent(v.on('modify', seen));
    this.registerEvent(v.on('delete', seen));
    // 改名只发 rename，不发 create/delete——事实文件一改名，wikilink 就断了，这正是体检要抓的
    this.registerEvent(v.on('rename', (f, oldPath) => (seen(f), this.onVaultChange(oldPath))));
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

  private openRecord() {
    new RecordModal(this.app, this).open();
  }

  private async openStore() {
    // 只取快照。主题目录的物理布局由 core 的 ensureTopic 在 record 时按需建，审计/重建不需要预建。
    return snapshotStore(this.app.vault, { label: this.app.vault.getName() });
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
    }
    let result: { written: boolean; topic: string; fact: Record<string, unknown>; fatal: Issue[]; warn: Issue[] };
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
        const store = await this.openStore();
        const r = openSession(store, { enums: enums5w2h, now: Date.now() }).auditAndReport('事实库');
        const flush = await store.flush();
        this.reportConfig(flush, store);
        this.status.setText(`主题 ${r.topics.length} · 事实 ${r.rows.length} · 致命 ${r.fatal.length} · 告警 ${r.warn.length}`);
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
      const store = await this.openStore();
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

  // 视图现在按主题分（<主题>/<主题>.base），没有单一入口——打开按字母序第一个主题的 .base，没有则提示。
  private async openFirstTopicView() {
    try {
      const topics = this.topicsOf();
      if (!topics.length) {
        new Notice('还没有任何主题——先记一条事实，主题目录和 .base 就建起来了', 5000);
        return;
      }
      await this.openFile(`${topics[0]}/${topics[0]}.base`);
    } catch (e) {
      new Notice(staged('打开视图', e).message, 8000);
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
      new Notice(`读配置目录失败：${store.probe.readError}`, 8000);
    }
  }
}

class RecordModal extends Modal {
  private draft: Record<string, unknown> = {};
  private settings: Record<string, Setting> = {};
  private fieldHints: Record<string, string> = {};
  private errorEl!: HTMLElement;
  private okBtn!: ButtonComponent;
  private cancelBtn!: ButtonComponent;
  private submitting = false;
  // 两阶段（2026-10-13 用户定调）：阶段一选/建主题，阶段二录事实。
  // 主题在阶段一定下后不再变（要变就"换主题"回阶段一）——阶段二的候选全部按它取，
  // 没有"主题随时可改、候选随时重挂"的中间态，表单因此少一整段逻辑。
  private stage: 'topic' | 'fact' = 'topic';
  private topic = '';

  constructor(app: App, private plugin: SolofactPlugin) {
    super(app);
  }

  onOpen() {
    this.contentEl.addClass('solofact-record');
    this.renderTopicStage();
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
    this.setTitle(`记一条事实 · ${this.topic}`);
    const el = this.contentEl;
    el.empty();
    const d = this.draft;
    const topic = this.topic;
    this.errorEl = el.createDiv({ cls: 'solofact-errors' });

    // 主题行：锁定显示 + 换主题。settings.topic 指着它——提交时 E_BAD_TOPIC 之类标红这一行。
    this.settings.topic = this.add(el, '主题', topic, 'topic', (s) =>
      s.addButton((b) => b.setButtonText('换主题').onClick(() => this.renderTopicStage()))
    );

    // 必填三项：who / when / what。候选按当前主题取；来过的值留着（换主题再回来不丢）。
    this.settings.who = this.add(el, FIELD_META.who.label, FIELD_META.who.hint, 'who', (s) =>
      s.addText((t) => {
        this.attachCombo(t.inputEl, this.historyOf('who', topic));
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

    new Setting(el)
      .addButton((b) => {
        this.cancelBtn = b.setButtonText('取消').onClick(() => this.close());
      })
      .addButton((b) => {
        this.okBtn = b.setButtonText('记下来').setCta().onClick(() => void this.submit());
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

  // 历史候选：读 事实/*.md 的 frontmatter 里某个字段，去重。用宿主已索引的 metadataCache，同步可取。
  // topic 给定时只取该主题目录下的历史——每个主题的 who/where/why/how/多少 词汇内聚，不跨主题混。
  // 顺带接受数字值（howmuch 在 frontmatter 是 number）。
  private historyOf(field: string, topic?: string): string[] {
    const out = new Set<string>();
    const prefix = topic ? `${topic}/事实/` : null;
    for (const f of this.app.vault.getFiles()) {
      if (!f.path.endsWith('.md')) continue;
      if (prefix) {
        if (!f.path.startsWith(prefix)) continue;
      } else if (!/\/事实\/[^/]+\.md$/.test(f.path)) {
        continue;
      }
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm) continue;
      const val = fm[field];
      if (val == null) continue;
      const s = String(val).trim();
      if (s) out.add(s);
    }
    return [...out].sort();
  }

  // 一次点击只许跑一次写入，而且必须让按钮显示"写入中…"：
  // 之前"点了没反应"就是异常被 void 掉＋按钮从不给反馈，两层叠加的结果
  private async submit() {
    if (this.submitting) return;
    this.submitting = true;
    this.setBusy(true);
    try {
      const result = await this.plugin.record(this.draft);
      if (!result.ok) {
        this.showErrors(result.fatal);
        return;
      }
      this.clearErrors();
      const id = String(result.fact.id);
      for (const w of result.warn) new Notice(`⚠ ${w.code} — ${w.message}（已写入，告警不阻断；体检会一直报到它消失）`, 7000);
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
    this.okBtn?.setDisabled(busy);
    this.cancelBtn?.setDisabled(busy);
    this.okBtn?.setButtonText(busy ? '写入中…' : '记下来');
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
