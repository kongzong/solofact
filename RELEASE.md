# solofact 发布流程

三类产物，一个版本号，一次发布。**规则只有一份**在这里同样成立：版本真源只有 `package.json` 的 `version`，manifest 和 SKILL.md 由脚本同步，不许手改。

## 发布（一条命令）

```bash
npm run release
```

它依序做：版本同步（package.json → `plugin/manifest.json` + `skill/SKILL.md` frontmatter）→ 三处版本一致性断言 → 三个包 → git 卫生检查。任何一步失败即中止，`dist/` 不留半成品。

## 产物与分发对象

| 产物 | 发给谁 | 怎么用 |
|---|---|---|
| `dist/solofact-vault-<ver>.zip` | **新用户（第一触点）** | 解压 → Obsidian「以文件夹打开库」。插件已装、5 主题样例、`.base` 八视图直接看；样例主题整个删掉即可变成他的真库 |
| `dist/solofact-plugin-<ver>.zip` | 老用户（更新插件） | 解压得 `solofact/`，整个覆盖进 `<他的库>/.obsidian/plugins/solofact/`，重启 Obsidian。**数据一个字节不碰** |
| `dist/solofact-skill-<ver>.tar.gz` | agent 用户 | 解压得 `solofact/`（SKILL.md 在根，符合 skill 规范），`cp -r solofact ~/.workbuddy/skills/solofact` 即装；项目级装到 `<项目>/.workbuddy/skills/` |

**vault zip 是门面**，按"用户第一眼看到的产品"标准维护（README 的上手指引）。CLI+skill 是第二曲线，等插件侧有人用起来再推。

## 更新机制（两个包，各自独立）

「同步发布、独立更新」：三个包同版本号一次出（core 行为一致），但用户的更新动作各走各的，互不等待。

- **vault 用户的库会从 demo 变成他的真库——永远不能整体覆盖更新**。更新单元是里面的插件文件：解压新版 vault zip（或插件更新包），只取 `.obsidian/plugins/solofact/{main.js,manifest.json}` 覆盖进他的库。
- **skill 包不含用户数据**（数据与工具分离是硬边界），覆盖更新零风险：重新下载，`cp -r` 覆盖 `skills/solofact/`。
- **版本错配是唯一要防的风险**：插件 0.3 而 CLI 0.4，两套 core 行为不同，agent 录一条可能插件体检报错。缓解：版本号单一源头（机制上让"只发一个包"变难）+ README/SKILL.md 注明保持同版本。

## 质量门

`pack:demo` 内置：build.js 重建（自带致命门）→ 最新插件打进 vault → 跑真实 CLI 体检验「致命 0」→ 才打包。发布物带致命错误比晚发一天严重。

重建会清掉 vault 里所有非种子主题——**开发期试录的私密数据不会进发布物**（隐私防线，顺带的）。

## 当前阶段（未进官方商店）

手动分发三个文件即可。等有 GitHub 之后的升级路径：

- 插件 → **BRAT**：用户装 BRAT 填仓库地址，push 后他点一下更新（需 release 附 main.js+manifest）
- CLI → `npm publish`（package.json 已配 `files: [cli, core, contract]`，skill 与 vault 不进 npm 包）
- 两者都就位后，才考虑 Obsidian 官方社区插件提交

## 分步手动（release 挂了时）

```bash
npm run sync-version   # 或 node scripts/sync-version.mjs --check 单独校验
npm run pack:plugin
npm run pack:demo
npm run pack:agent
```
