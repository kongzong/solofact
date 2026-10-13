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

手动分发三个文件即可。仓库已就位（`github.com/kongzong/solofact`），下一步启用 BRAT 自动更新：

### 插件 → BRAT（发布者操作，每个版本一次）

**必须走 GitHub Release，不能跟踪分支**——`main.js` 是 esbuild 生成物，`.gitignore` 明确挡住不进仓库（协作者 clone 后自己 `npm run plugin` 生成）。BRAT 的「跟踪 main 分支」模式会因为仓库里没有 `main.js` 而装不上。

```bash
# 1. 发布流程照旧（三包 + 版本同步 + 质量门）
npm run release

# 2. 解出 release 要用的两个资产
unzip -o dist/solofact-plugin-<ver>.zip -d dist/release-assets
#    → dist/release-assets/solofact/main.js
#    → dist/release-assets/solofact/manifest.json
```

然后在 GitHub 网页操作：仓库 → **Releases → Draft a new release**

| 项 | 值 |
|---|---|
| Tag | `<ver>`（如 `0.3.0`）——**必须与 manifest.json 的 version 一致**，BRAT 按 tag 识别版本 |
| 附件 | 上传上面解出的 `main.js` 和 `manifest.json` 两个文件（不要带目录，就平铺的两个文件） |
| vault zip | 可选：作为第二个附件挂上，新用户从 release 页直接下载 |

### 插件 → BRAT（用户操作，装一次终身可更新）

用户在他的 Obsidian 里：

1. 装 BRAT 插件（社区市场搜 BRAT，或从 BRAT 自己仓库装）
2. BRAT 设置 → **Add beta plugin** → 填 `kongzong/solofact`
3. 装好即当前 release 的版本。**你每发一个新 release，用户在 BRAT 面板点一下更新**，不用再收 zip

### CLI → npm publish（可选，与 BRAT 独立）

`package.json` 已配 `files: [cli, core, contract]`（skill 与 vault 不进 npm 包），去掉 `"private": true` 后：

```bash
npm publish
# 用户：npm i -g solofact && solofact 主题 --vault <库>
```

npm 包更新不影响 BRAT 用户，反之亦然——「同步发布、独立更新」。

### 官方商店是最后一站

BRAT 稳定运行几个版本、无重大回归后，才准备 Obsidian 官方社区插件提交（需要：release 资产齐备、README 商店页文案、图标、桌面+移动双端验证记录）。商店前不建议提前做——审核周期长，形态还在迭代。

## 分步手动（release 挂了时）

```bash
npm run sync-version   # 或 node scripts/sync-version.mjs --check 单独校验
npm run pack:plugin
npm run pack:demo
npm run pack:agent
```
