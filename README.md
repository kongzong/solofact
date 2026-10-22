# solofact

**Obsidian 上的事实层：一条事实 = 一个文件，按主题分库。**

它源自一个 CRM 实验的死因复盘——工具不差，但没人坚持记。solofact 把录入摩擦压到最低（必填只有三个字段），把「记」和「看」彻底分开：插件只负责写，查看全部交给 Obsidian 原生的 Bases 与 Dataview 生态。

- **真源是 append-only 的 ndjson**，Markdown 是随时可重建的读模型——数据不会因为改视图而损坏
- **规则只有一份**：契约（`contract/`）+ 纯函数核（`core/`），CLI 和插件两个壳都只是它的调用者
- **插件「只写不看」**：不渲染表格、不做仪表盘，宿主 Obsidian 才是查看层

当前版本 **0.4.0** · 测试全绿 · [发布流程](RELEASE.md) · [演示库说明](vault-5w2h/README.md)

---

## 形态速览：主题 = 目录

主题不是事实里的一个字段，而是**一堆事实的上级目录**：

```
我的库/
├── 一人公司CRM业务/          ← 一个主题 = 一个自包含目录
│   ├── _真源/facts.ndjson     append-only 真源（每条一行 JSON）
│   ├── 事实/f-20261013-….md   一条事实一个文件
│   ├── 一人公司CRM业务.base   该主题的 Bases 视图（八个看板）
│   └── 时间线.md / .html      该主题的可视化时间线
├── 公司记账/ …
├── _体检.md                   ← 库根：跨主题汇总诊断（全库共享一份）
└── .obsidian/
```

由此推出三个设计后果：

1. **没有 `type` 这一级**——同主题内 `howmuch` 天然同一量纲（记账都是元、体重都是 kg），类型模板和单位校验失去存在理由；
2. **必填只有 who / when / what**——where/why/how/howmuch 可选，枚举候选从**该主题**的历史里抽（词汇内聚，不跨主题混）；
3. **`howmuch` 是有符号数**——资金主题约定 负=出、正=进，核心只校验「是不是数字」，符号语义靠主题内约定传播。

完整的字段表、视图清单、主题教学范例见 **[vault-5w2h/README.md](vault-5w2h/README.md)**。

## 三种用法

| 你是谁 | 拿什么 | 怎么开始 |
|---|---|---|
| **Obsidian 用户**（第一触点） | 演示库 zip | 下载 [release 附件 `solofact-vault-*.zip`](https://github.com/kongzong/solofact/releases/latest) → 解压 → Obsidian「以文件夹打开库」。插件已装好、5 个样例主题、八视图直接看，顺手就能录第一条自己的事实 |
| **已有自己库的 Obsidian 用户** | 插件本体 | 装 [BRAT](https://github.com/TfTHacker/obsidian-brat-plugin) → Add beta plugin → 填 `kongzong/solofact`。三步图文流程见下方「已有自己的库？三步装上插件」 |
| **想让 AI agent 替你记录的人** | skill 包 | 下载 release 附件 `solofact-skill-*.tar.gz` → 解压 → `cp -r solofact ~/.workbuddy/skills/`。之后对你的 agent 说「记一条事实」即可，SKILL.md 会教它用 CLI 走同一套校验 |
| **开发者** | 整个仓库 | `git clone` 后 `npm i && npm test`。欢迎读 `core/`——纯函数、无框架、无运行时依赖 |

## 快速开始

**Obsidian 用户**（零安装零决策）：下载 vault zip → 解压 → 拖进 Obsidian。若被「受限模式」拦住，去 设置 → 安全模式 放行即可。开始记录后记住一条：**想以旧事实为底稿录新的，用插件命令「复制这条事实」，别用 Obsidian 自带的复制**——后者是字节级复制文件、真源不知情，造出来的副本会被体检报错、被重建清掉（vault 里 README 有完整说明）。

**agent 用户**：

```bash
tar xzf solofact-skill-0.4.0.tar.gz
cp -r solofact ~/.workbuddy/skills/     # 项目级安装则放到 <项目>/.workbuddy/skills/
# 对你的 agent 说：「记一条：今天给了阿杰 UI 尾款 8000 元，记到公司记账」
```

**开发者**：

```bash
git clone https://github.com/kongzong/solofact.git && cd solofact
npm i            # 只装 devDeps（esbuild + typescript），运行时零依赖
npm test         # 内核 + CLI 子进程 + 插件静态守卫
npm run plugin   # 构建插件 bundle 进 vault-5w2h
```

## 已有自己的库？三步装上插件（BRAT）

走演示库 zip 的用户不用看这段——插件已经打在库里了。这条是给**已经有自己的 Obsidian 库**的人：插件还没进官方商店，借 BRAT（Beta Reviewers Auto-update Tester，社区里专门装测试版插件的工具）安装，装一次，以后发版更新很省事。

1. **装 BRAT**：设置 → 第三方插件 → 浏览社区市场，搜 `BRAT` → 安装并启用。若社区插件被「受限模式」拦住，去 设置 → 安全模式 关闭它即可。
2. **加 solofact**：BRAT 设置 → **Add beta plugin** → 填 `kongzong/solofact` → 确认。BRAT 会从 GitHub Release 拉取 `main.js` 和 `manifest.json`（商店标准的两个文件），装完即当前发布版，不需要 clone 源码。
3. **录第一条**：点左侧边栏的笔形图标，或 `Ctrl/Cmd + P` 搜「记一条事实」。填 who / when / what 三个必填项，其余想填就填。存盘后，该主题的 `.base` 视图和时间线自动生成。

**更新**：每次 solofact 发新 release，打开 BRAT 面板点一下更新（BRAT 设置里可开启「启动时自动更新」，连这一步也省掉）。注意 Obsidian **不热更新**插件——装完或更新后，重启 Obsidian（或命令面板「重载应用」）才生效。

**不丢数据**：solofact 的真源（`_真源/facts.ndjson`）在你的库里，不在插件里。卸载或换装插件，数据原封不动——工具与数据分离是硬边界。样例主题整个删掉，库就是你的了。

## 仓库结构

```
contract/     规则契约（字段、必填、id 格式）——改规则先改这里
core/         纯函数核：validate / record(落盘) / scan(体检) / vault(视图)
  adapters/   存储适配：真实文件系统 + 插件壳的暂存 store（同语义两实现）
cli/          写入路径 CLI（agent 的录入口）：六个写入命令 + 只读「主题」命令
plugin/       Obsidian 插件壳（main.ts，两阶段录入表单）
skill/        agent 技能指令（SKILL.md，配 CLI 使用）
scripts/      发布工具链：版本同步 + 三个 pack + release 编排
tests/        测试（含插件静态守卫：锁「一内核两壳」架构）
vault-5w2h/   演示库（可再生：node vault-5w2h/build.js）
```

## 架构护栏（贡献前必读）

- **规则只有一份**：校验只在 `core/fact.js`，两个壳不许自带规则；
- **落盘顺序锁死**：真源 → Markdown，致命错误一个字节都不写；
- **壳不许越界**：`tests/plugin.test.js` 是静态守卫，插件引内核以外的东西会直接红；
- **CLI 不许加命令**：skill 是写给 agent 的契约，命令面变了 skill 必须同版更新。

## 状态与路线

- **0.4.0**（当前）：删除/编辑/复制三命令（复制走真源底稿，编辑=另存新稿+删旧稿）；时间线按月分段（录入 O(1)）；`.base` 文件名=目录名的严格规矩（体检+弹窗双保险）；表单可选字段折叠 + 键盘流 + 状态栏「今日已记」
- **未做**：Obsidian 官方商店提交（等 BRAT 稳定运行几个版本）、npm publish（package.json 已配好 `files`，随时可发）

[RELEASE.md](RELEASE.md) 有完整的发布/更新流程。

## License

[MIT](LICENSE)
