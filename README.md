<p align="center">
  <img src="public/icons/wordmark.svg" alt="Kesonode" width="320">
</p>

<p align="center">
  <strong>把浏览器同步到你自己的存储：没有中间商、不用注册账号、不收集数据。</strong>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a> ·
  <a href="LICENSE">MPL-2.0</a> ·
  <a href="插件版本/安装说明.md">中文安装说明</a> ·
  <a href="https://github.com/KesonLai114/Kesonode/releases">下载安装包</a>
</p>

> **Fork 说明**：Kesonode 是
> [Konode](https://github.com/konabe-studio/konode)（Kōnabe Studio，MPL-2.0）的独立分支。
> 上面的链接仅是许可证要求的来源归属，不是本项目的主页。同步文件名、默认文件夹名、存储键、
> 数据格式与扩展 ID 都刻意保持不变，让已有数据继续可用，详见[兼容模式](#兼容模式重要)。
> **本分支没有上架任何扩展商店，也没有自己的服务器、账号体系或问题追踪器；如有疑问请联系维护者。**

<p align="center">
  <img src="docs/hero.png" alt="Kesonode 中文主视觉示意图：书签、打开的标签页、历史记录、扩展列表四类同步，写入 Google Drive、GitHub 或 WebDAV，可选端到端加密" width="100%">
</p>

---

Kesonode 让**书签、打开的标签页、历史记录、已安装扩展列表**在你的浏览器之间保持同步，
但不经过任何公司的服务器，而是直接写进**你自己已有的存储**：Google Drive、一个 GitHub
仓库，或任意 WebDAV 服务。

没有 Kesonode 账号要注册，也没有 Kesonode 服务器要信任。数据从浏览器直达你选的位置，
凭据只留在本机。需要的话可以打开端到端加密，让存储服务商也读不到内容。

## 这个分支与上游有什么不同

| 项目 | 本分支的实际情况 |
|------|------------------|
| **分发方式** | 只通过本仓库的 [Release](https://github.com/KesonLai114/Kesonode/releases) 和源码里的 [`插件版本/`](插件版本/) 目录提供本地安装包；**没有商店版本**，浏览器里需要「加载已解压的扩展程序」 |
| **构建变体** | 发布的包是不含内置 Google OAuth 密钥的 `source` 构建：GitHub、WebDAV 开箱即用；要用 Google Drive 需自己创建 OAuth 客户端（`drive.file` 权限） |
| **三种兼容模式** | 上游兼容 / 自有文件名 / 完全独立，决定数据写到哪个文件夹、用哪种文件名前缀；默认模式沿用上游，保证旧数据可读 |
| **设置导入 / 导出** | 「设置 → 工具与诊断 → 导入/导出」可把后端账号、加密口令、Drive 授权导出成 JSON 并在新安装里恢复；导入时会选择「作为新设备导入」（推荐，重新生成设备 ID 与默认设备名）或「恢复本机身份」（同一台设备重装时用）。备份格式带版本号与迁移链 |
| **冲突与设备信息** | 手动解决冲突前可看到双方差异；设备列表显示最近上传时间、浏览器引擎与不活跃标记；被阻止的批量删除会列出具体书签 |
| **链接与文案** | 界面、日志、图标与文档统一为 Kesonode；指向上游商店、评分、反馈和站点的链接已移除（集中在一个空的 `FORK_LINKS` 常量里，等有自己的地址再填） |
| **协议契约** | **冻结不变**：`konode_*` 文件前缀、`Konode` 文件夹名、SyncPacket v1.0、SHA-256 校验、AES-256-GCM / PBKDF2 参数、扩展 ID 与 OAuth 配置。改这些会破坏已有数据 |

上游的新功能与修复会持续对照、移植；只搬代码逻辑，不搬上游的品牌、商店、赞助与作者信息。
本分支独有的改动记录在 [CHANGELOG.md](CHANGELOG.md) 顶部的「Kesonode fork」段落。

## 能同步什么

| 数据 | 说明 |
|------|------|
| **书签** | 双向同步并保留文件夹结构，重命名、移动、排序与删除都会传递；可把指定书签或整个文件夹排除在同步之外 |
| **打开的标签页 / 会话** | 保存当前标签组、随时恢复其他设备的会话，标签组的名称与颜色可选保留；恢复时只打开本机还没有的标签页 |
| **历史记录** | 去重合并的浏览记录列表（Firefox 可保留原始访问时间；Chrome 的 API 无法设置访问时间，恢复的条目显示为同步时刻） |
| **已安装扩展列表** | 同步清单，并一眼看出当前设备缺了哪些扩展；此权限只读，Kesonode 不会安装或移除任何扩展 |

两个设备不一致时由你决定怎么合并：最新更改优先、始终保留本机、始终使用远端，
或从弹窗里手动处理 —— 手动模式下可以先到「设置 → 同步记录」查看双方具体差异再选择。

还有几个用得上的安全设计：每个同步包都带 SHA-256 校验；书签删除用墓碑机制传递且有
批量删除保护（异常删除会被拦下并保存还原点）；还原点可随时手动创建。

**和浏览器自带的书签同步同时开启**：书签 API 只告诉扩展「有书签新增/改动/删除」，不会说明是谁改的，
所以 Chrome Sync 推来的改动和用户自己改的完全无法区分。两套系统一起跑不会互相覆盖数据，但同一变更
会走两遍，还会把原本分开的两组设备桥接起来（删除也一样）；最稳妥的仍是书签只用一套同步。

为此本机加了**变更护栏**：每轮同步把本机书签树与上一轮比较，若连续多轮大幅变动且始终稳定不下来
（或单轮变动超过 500 条），就暂停**本机文件的发布**。其它设备的改动照常拉取合并，本机不删也不
回滚任何书签；只要有一轮不再变化就自动恢复，所以一次删掉整个文件夹、或导入书签备份，都不会被
延迟。触发时自动保存还原点，并在「设置 → 同步记录」说明原因。护栏只属于本机工作状态，不改变同步包
格式、文件名和文件夹名，每台设备各自独立运行。

## 数据存在哪里

| 后端 | 认证方式 | 说明 |
|------|----------|------|
| **Google Drive** | 一次性登录 | 权限限定 `drive.file`，只碰自己创建的文件；本地包需自建 OAuth 客户端 |
| **GitHub** | 细粒度个人访问令牌 | 指向你自己的单个仓库，建议使用私有仓库 |
| **WebDAV** | 用户名 + 密码 | 内置 Nextcloud / ownCloud / pCloud / Koofr / Fastmail / 坚果云预设，坚果云在国内可用；「WebDAV（其他）」支持群晖、kDrive 及任何标准服务 |

所有后端都只是普通文件存储，没有推送通知能力，所以设备之间靠定时拉取发现彼此的变化。

## 隐私与安全

- **没有 Kesonode 服务器**。数据只发往你配置的后端，不会发给第三方，也没有遥测。
  例外只有一个：下面这条**默认关闭**的 AI 助手功能，数据发往你自己填写的服务商。
- **可选端到端加密**：AES-256-GCM + PBKDF2-SHA256（60 万轮），安装向导里显式选择，默认关闭。
  加密文件放在别人能读到的存储上，口令可被离线猜测，因此要求至少 12 个字符，建议使用生成的密钥。
- **凭据只留在本机**：访问令牌、GitHub Token、WebDAV 密码与加密口令只存在浏览器的
  `storage.local` 里，从不上传。该存储不加密落盘，建议使用细粒度 GitHub Token 和
  WebDAV 应用专用密码。
- **按需申请权限**：`history`、`tabs`、`management` 只在你打开对应数据类型时申请。
- **完整性校验**：每个同步包带 SHA-256 校验和，下载后先验再导入。
- **可选 AI 助手（默认关闭）**：在「设置 → AI 助手」填入你自己的 API 地址、密钥与模型后，
  可以用自然语言找书签、获取整理建议、解释同步回执与冲突。提问时只发送**精简后的书签清单**
  —— 标题、域名、文件夹路径（提问最多 120 条，整理建议最多 400 条）；完整网址、历史记录、
  标签页、同步存储与凭据都不会发送。解释同步回执或冲突时只发送计数、数据类型与状态位，
  不含任何标题或网址样本。请求只发往你填写的地址，Kesonode 没有服务器、也拿不到密钥或回答。
  API Key 只存本机，不参与同步，也**不会随设置导出**。整理建议只生成清单：勾选后还会展示
  一份列出每条「从哪个文件夹 → 到哪个文件夹」与每组「保留哪条 / 删除哪些」的最终确认清单，
  再次确认并先建立还原点后才会改动书签。归档目标只能是现有文件夹，同名文件夹取第一个匹配，
  不会新建文件夹。详见 [PRIVACY.md](PRIVACY.md#optional-ai-assistant)。

> 换句话说：不开启 AI 助手时，上面「不会发给第三方」的承诺没有任何例外；开启后，唯一的
> 新增数据接收方是你自己选择并付费的模型服务商。

## 兼容模式（重要）

「设置 → 云端与加密 → 兼容性」决定这台设备把数据写到哪里。**同一个同步组里的所有设备必须选同一个模式**，
文件夹就是设备互相找到对方的地方。

| 模式 | 文件夹（WebDAV/GitHub · Google Drive） | 文件 |
|------|----------------------------------------|------|
| **上游兼容**（默认） | `konode` · `Konode` | 读写 `konode_*` |
| **自有文件名** | `konode` · `Konode` | 写 `kesonode_*`，两种前缀都读 |
| **完全独立** | `kesonode` · `Kesonode` | 只读写 `kesonode_*` |

上游文件夹名属于冻结的线上数据，不是产品文案，所以默认模式仍会创建一个叫 `konode` 的文件夹。
**切换模式不会搬移已有文件**：新文件夹一开始是空的，本设备会重新上传自己的数据；在
「完全独立」模式下，上游 Konode 设备看不到这台设备的数据。无论哪种模式，协议参数、存储键
与扩展 ID 都不变。

开启 E2EE 时，载荷在设备端加密，校验和仍对明文计算，因此内容相同的设备可以互相匹配，
又不会向后端泄露内容。

## 什么时候会同步

只有三件事会触发同步：

- **本机书签发生变化** —— 约 1 秒后上传，另有 30 秒兜底；仅书签，且需要开启「更改时同步」（默认开启，位于「设置 → 本机与同步」）。
- **定时拉取** —— 默认每 60 秒一次，覆盖所有已开启的数据类型，也是设备得知其他设备变化的途径；可在「设置 → 本机与同步 → 同步间隔」调到 30–600 秒，或用「自动同步」关掉。
- **在弹窗里点「立即同步」**。

启动浏览器本身不会同步，只会重新排定定时器。历史记录、标签页和扩展列表没有即时通道，
靠定时拉取传递。浏览器对扩展后台定时器的最快限制就是 30 秒，这是平台下限而不是保守设置。

## 界面语言

界面跟随浏览器语言。已完整翻译：**英语、匈牙利语、德语、西班牙语、意大利语、俄语、
简体中文、繁体中文**（弹窗、设置向导、设置页全部覆盖，日期与数字按浏览器区域格式化）。
日语、爱沙尼亚语、阿拉伯语尚未完成，没有随包发布（阿拉伯语还需要 RTL 排版）。

文案在 `public/_locales/<lang>/messages.json`，直接改本仓库的文件即可 —— 本分支**不使用**
上游的 Weblate 平台。文档方面：本页是中文主文档，英文版见 [README.en.md](README.en.md)，
[安装说明](插件版本/安装说明.md) 为中文；`GETTING_STARTED.md`、`TROUBLESHOOTING.md`、
`PRIVACY.md` 目前仍是英文（沿用上游文档）。

## 安装

1. 打开 [Releases](https://github.com/KesonLai114/Kesonode/releases)，下载对应版本的
   `kesonode-chrome-<版本>.zip`（Chrome / Edge / Brave 等）或
   `kesonode-firefox-<版本>.zip`（Firefox）；源码里的 [`插件版本/`](插件版本/) 也按版本存放了同样的包。
2. **先解压**，浏览器加载的是文件夹而不是 zip；解压后会得到**一个叫 `Kesonode` 的文件夹**
   （不带版本号），里面直接有 `manifest.json`。以后每次升级都用同一个文件夹。
3. 按每个版本目录里附带的**中文《安装说明》**操作：Chromium 在 `chrome://extensions`
   开启开发者模式后「加载已解压的扩展程序」，Firefox 在 `about:debugging` 里「临时载入附加组件」。

几个要紧的提醒：

- **升级：Chromium 一个按钮完成**。下载新版本 zip（不用解压）→ 选项页 → 高级 →
  软件更新 → 点「一键升级」，**第一个弹窗就是选这个 zip**。插件校验版本与内容；
  **第一次**使用时同一个按钮会变成「选择文件夹并完成升级」，再点一下选中加载插件的
  那个 `Kesonode` 文件夹（直接含 `manifest.json` 的那一层）并授权写入，之后自动写入
  新版、清掉旧版残留文件并重启。首次设置之后，每次升级只需选一次 zip。旧版本留在
  `.kesonode-backup/` 下。「检查更新」、目录管理和脚本下载收在「高级选项」里。
- **Firefox 没有这个接口**（浏览器不允许扩展写本地文件夹）：同一位置的主按钮直接是
  「下载升级脚本」，跑一次即可把新版本装进同一个 `Kesonode` 目录。
- **升级 1.5.1 → 1.5.2**：1.5.2 的包没有固定扩展 ID，请把新版文件**覆盖到当前正在加载的同一个文件夹**
  再点刷新，不要新建文件夹直接加载，否则扩展 ID 变化会导致设置读不到。稳妥做法是先到
  「设置 → 工具与诊断 → 导入/导出」导出配置，必要时再导入。用
  `npm run package:source:pinned` 自建的包带固定 ID，可避免这个迁移步骤。
- **手动覆盖解压不行**：解压只会新增文件、不会删除旧的，`chunks/` 文件名带内容哈希，
  新旧构建混在一起会出现 `Unexpected token 'export'`、弹窗或设置页空白。用上面的一键
  升级或升级脚本，它们会清掉旧文件。
- **Firefox 临时加载在浏览器重启后会失效**，需要重新载入一次；本分支没有上架商店，因此没有签名版。
- 导出的配置是**明文**（含令牌与口令），只保存在本机，不要上传或分享。
- 如果已经装过旧包，保留原安装即可；再装一份会被当成一台新设备加入同步组。

完整上手见 [GETTING_STARTED.md](GETTING_STARTED.md)（英文），异常排查见
[TROUBLESHOOTING.md](TROUBLESHOOTING.md)（英文）。

## 从源码构建

```bash
npm ci
npm run check                  # type-check + lint + 测试
npm run version:patch          # 发新版本时手动 +1；同步 manifest、扩展名、lock
npm run package:source:pinned  # → web-ext-artifacts/source/ 下两个带固定扩展 ID 的 zip
```

- **版本号只在 `package.json` 里改，且必须显式 `version:patch`**（也有
  `version:minor` / `version:major`）。`sync-version` 现在是幂等的，不再每次构建自动 +1；
  以前 `build`、`build:firefox`、`package:source` 各调用一次会让同一个版本连跳三次。
- **用 `package:source:pinned` 一条命令产出两个包**，不要分别跑 `npm run build` 和
  `npm run build:firefox` 再打包，否则两个目标可能来自不同版本。
- 打包前会自动校验：`package.json`、`public/manifest.json`、`dist*/manifest.json` 三处版本
  必须一致（zip 文件名取 `package.json`，包内 manifest 直接复制 `dist/`，不一致就会产出
  「文件名 1.5.5、内容 1.5.4」的包）；同时检查各 HTML 引用的 module/chunk 与 background
  脚本是否齐全、是否声明为 ES module。任何一项不符都会拒绝打包并给出重建命令。
- **Chromium**：打开 `chrome://extensions` → 开启开发者模式 → 「加载已解压的扩展程序」→ 选 `dist/`。
  每次重新构建后要点扩展卡片上的 ↻ 刷新（MV3 不会自动替换运行中的 service worker）。
- **Firefox**：打开 `about:debugging` → 「此 Firefox」→ 「临时载入附加组件」→ 选 `dist-firefox/manifest.json`。
- 自己构建 Google Drive 后端需要自己的 Google OAuth 客户端（`drive.file` 权限）；
  GitHub 与 WebDAV 只需填自己的凭据。

### 发布新版本（维护者）

打包只是发版的一半：**GitHub Release 只有在推送 `v*` 标签后才会出现**（`.github/workflows/release.yml`
由标签触发）。过去版本号打进 zip、提交进 `插件版本/`、推到 main，却漏了打标签，结果 Releases
页面停在旧版本、每次都要手动补。现在这一步由脚本收口：

```bash
npm run version:patch          # 1) 显式 +1（如已在目标版本可跳过）
npm run package:source:pinned  # 2) 产出两个带固定 ID 的 zip
#    把两个 zip + 安装说明.md 放进 插件版本/vX.Y.Z/ 并提交
npm run release                # 3) 打标签 + 推标签 + 建 Release（可重复执行）
npm run release:dry            #    预览第 3 步会做什么，不改任何东西
```

`npm run release` 读取 `package.json` 的版本，校验 `插件版本/vX.Y.Z/` 下两个 zip 齐全、工作树干净，
然后用**已提交的那两个 zip**（与历史发布物逐字节一致、已核对固定 ID、无内置密钥）打 `vX.Y.Z`
标签、推送，并用 `gh release create` 创建 Release。它是**幂等**的：标签已存在且指向当前提交就复用，
Release 已存在就不动它的附件，所以重跑安全。正文会从 `CHANGELOG.md` 对应版本段落自动生成；也可
`npm run release -- --notes-file path.md` 手写。建好后到 GitHub 上按需补一句「哪个包给哪个浏览器」
和升级说明。需要本机已登录 `gh auth login`（repo 权限）。

> 推标签也会触发 `release.yml`，它会重新构建 pinned 包；其建 Release 步骤同样是幂等的，两条路径不会冲突。

`npm run checksum` 会对构建出的 `dist/` 计算确定性的 SHA-256 指纹，用于验证可复现构建。
注意：带 Google OAuth 密钥的构建与不带密钥的 source 构建指纹不同；Release 说明目前还不附带该指纹。

## 工作原理

每台设备、每类数据各写一个 JSON 文件（`SyncPacket`）到后端的同步文件夹。每次同步拉取其他
设备的文件、做非破坏性合并，再把结果写回。书签用墓碑机制让删除在设备间传递而不复活旧条目，
并有安全阈值防止损坏的删除日志清空整棵树。

## 不支持什么

- **密码同步**：浏览器扩展读不到浏览器原生密码库，这是平台的安全边界。密码请用
  [Bitwarden](https://bitwarden.com)、[Proton Pass](https://proton.me/pass) 或自建
  [Vaultwarden](https://github.com/dani-garcia/vaultwarden)。
- **手机端**：Firefox for Android 上可同步标签页与扩展列表，平台不向扩展提供书签、历史记录
  和 Google 登录（详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md#firefox-for-android)）。

## 已实现与后续计划

- **已实现**：四类数据同步 · 三种后端与 WebDAV 预设（含坚果云）· 多设备合并 · 逐项冲突处理 ·
  可选 E2EE · Drive OAuth PKCE 刷新 · 跨浏览器扩展匹配 · 书签排除同步 · 会话标签组 ·
  三种兼容模式 · 设置导入/导出 · 冲突差异展示 · 设备活跃状态 · 还原点与删除保护 · 多语言界面。
- **后续**：阅读清单 · 更多后端（Dropbox、S3 兼容、OneDrive）· 更快的历史同步 · 更多语言 · RTL 排版 · 超大书签树的增量 diff。

完整规划见 [ROADMAP.md](ROADMAP.md)。

## 反馈与排查

先查 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。本分支目前没有独立的 issue tracker、
商店页面或支持邮箱；界面里原本指向上游这些地址的链接已清空，等有自己的地址再统一填写。

## 赞助

如果这个软件对你有用，欢迎赞助作者一点心意，用于本软件的后续维护与功能迭代。赞助纯属自愿，
无论是否赞助，软件的全部功能都不受影响。

两张收款码分别为微信支付和支付宝，请按需扫码：

<table align="center">
  <tr>
    <td align="center">
      <img src="docs/sponsors/wechat.png" alt="微信赞赏码" width="220"><br>
      <strong>微信支付</strong> <sub>WeChat Pay</sub>
    </td>
    <td align="center">
      <img src="docs/sponsors/alipay.png" alt="支付宝收款码" width="220"><br>
      <strong>支付宝</strong> <sub>Alipay</sub>
    </td>
  </tr>
</table>

## 许可

[MPL-2.0](LICENSE)。上游归属见本页顶部的 Fork 说明，许可证原文逐字保留在 `LICENSE` 中。

---

<p align="center"><sub>Kesonode 与 Google、GitHub、Mozilla 及任何存储服务商均无关联。</sub></p>
