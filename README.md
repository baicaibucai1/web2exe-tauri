# web2exe-tauri

把**已有的 Web 应用**（静态站、Vite / React / Vue 的构建产物、单页 HTML）打包成
Windows 桌面应用与安装包的完整路线，附带可直接复制的模板。

这里沉淀的不是"一个能跑的 demo"，而是**一条已经在真实项目里跑通的路线**：
环境怎么装、坑在哪、每个坑的实测数据是什么、为什么这么选而不是那么选。

---

## 这条路线解决什么

| | 做法 | 代价 |
|---|---|---|
| **不用管理员权限** | 编译器解压在用户目录，工具链靠脚本补 PATH | 免管理员的那两个装法**不做包签名校验**，需显式授权（见 docs/02） |
| **不用 Visual Studio** | 走 GNU 工具链（MSYS2 + MinGW-w64） | 需处理 MinGW 的几个特有坑，见 docs/05 |
| **安装包小** | Tauri 复用系统自带的 WebView2，不打包浏览器内核 | 目标机器要有 WebView2（Win11 内置，Win10 靠更新；缺失时由安装包联网补装） |
| **自动更新可用** | Tauri updater + 签名密钥 + 静态 update.json | 私钥是整条链的单点，必须加密保存并单独备份（docs/04） |
| **对使用者友好** | 打包与启动全程双击 `.bat` | `.bat` 必须纯 ASCII（这是个真坑，见下） |

> 说"不用管理员"时要限定清楚：**构建**不需要管理员（工具链在用户目录、
> `installMode: currentUser` 的安装包也装进用户目录）。
> 「安装MinGW环境.bat」给出的是 **MSYS2 官方安装程序**那条路，它需要提权 ——
> 免管理员的自动装法是 `npm run setup:msys2 && npm run setup:mingw`（见 docs/02）。

实测产物（同一份前端，两种外壳对比）：

| 外壳 | 安装包 | 运行内存 |
|---|---|---|
| Tauri 2（本路线） | 1.8 – 8.4 MB | 约 60 – 120 MB |
| Electron | 80 – 180 MB | 约 200 – 400 MB |

差别的来源只有一个：Electron 打包一整个 Chromium，Tauri 用系统里已有的 WebView2。

**这两组数字怎么来的，请这样读**：Tauri 一侧 1.8 MB 是 2026-09-26 在本仓库模板
（占位页面、`opt-level = "s"` + `lto = true` + `strip`、NSIS lzma）上实测得到的安装包大小，
真实应用的体积主要随前端产物走，所以给到 8.4 MB 的量级；
Electron 一侧是社区常见区间，**本项目没有做过对照实测**。
内存数字同理：WebView2 是多进程的，任务管理器里只看主进程会低估实际占用，
要比较就按"主进程 + 所有 msedgewebview2.exe 子进程"的工作集总和来量。

---

## 快速开始

### 前置条件

| 需要什么 | 怎么来 | 大小 |
|---|---|---|
| Windows 10 1803+ | 有 WebView2 就能跑（Win11 内置；Win10 多数机器随更新有，缺失时安装包会联网补装） | — |
| Node.js 20+ | 官网安装包，一路下一步（Vite 7 要求 Node 20 以上，`package.json` 里已写 `engines`） | ~30 MB |
| Rust（GNU 工具链） | 双击 `安装Rust环境.bat`，它会问你要 GNU 还是 MSVC，**选 GNU**（会先按官方 `.sha256` 校验再执行） | ~400 MB |
| MinGW-w64 | 免管理员：`npm run setup:msys2` + `npm run setup:mingw`（需 `WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN=1`）；或 `安装MinGW环境.bat` 里的官方安装程序 + `pacman -S mingw-w64-x86_64-gcc`（要提权，但验包签名） | ~100 MB – 1 GB |

Rust 与 MinGW 都落在用户目录，**构建过程不需要管理员权限**；装完不需要重开终端 ——
打包脚本会自己补 PATH。上面 MinGW 那一行的两条路不是等价的：免管理员那条
绕开了 pacman 的包签名校验，代价与授权方式见 [docs/02](docs/02-环境-不用管理员权限的GNU工具链.md)。

不装 Visual Studio 是这条路线的主要收益之一（省 2–4 GB 和一个管理员密码），
其余取舍见 [docs/02](docs/02-环境-不用管理员权限的GNU工具链.md)。

### 从零到能跑

```bash
# 1. 复制模板到你自己的项目目录
cp -r template my-app && cd my-app

# 2. 装前端依赖
npm install
```

然后改两个地方，就跑起来了：

1. `src-tauri/tauri.conf.json` —— `productName`（应用名）、`identifier`（反向域名，全项目唯一）、窗口尺寸
2. `src/` —— 换成你自己的前端；或者保持不动，只把 `build.frontendDist` 指向你自己的构建产物目录

接着双击这三个文件（顺序就是验证顺序）：

| 文件 | 作用 | 耗时 |
|---|---|---|
| `启动开发版.bat` | 浏览器里看页面，改代码即时刷新 | 秒级 |
| `启动桌面版.bat` | 在真实 Tauri 窗口里跑一遍 | 首次编译 Rust 依赖，量级几分钟到十几分钟 |
| `打包桌面版.bat` | 产出安装包 + 更新签名 + update.json | 实测 4 分 07 秒（依赖已缓存、16 核、`lto = true`；冷缓存的机器按 5–15 分钟预估更稳） |

打包绿灯之后，还有最后一步别省：

```bash
npm run smoke        # 静默安装 → 启动 → 断言 WebView2 起来 → 卸载 → 回收
```

`打包桌面版.bat` 成功和 `check-installer` 全 PASS 都只证明**文件在包里**；
`smoke-test.mjs` 是唯一跑到"用户双击真的能打开"那一步的检查（本机实测 11/11），
它顺手挖出的两条真实行为记在 [docs/05](docs/05-踩坑记录.md) 最后一节。
会真的装进 `%LOCALAPPDATA%`，结束时自己卸干净；想留着手点就加 `--keep`。

首次打包时脚本会问你一句「现在生成一对签名密钥吗」—— 答 Y 即可，
它会生成 `.tauri-key`（私钥）并把 `.tauri-key.pub` 自动写进 `tauri.conf.json`。
这一步不能省：Tauri 的自动更新强制签名，没有密钥就没有可更新的安装包。

**默认生成的是空密码私钥，等同明文** —— 谁读到那个文件，谁就能签一份
会被所有已安装用户自动装上的更新。要加密保存：

```bash
# 生成与之后每次打包都用同一个值（脚本自动读，不需要交互输入）
set WEB2EXE_UPDATER_PASSWORD=你的密码
```

也可以手动生成（多台机器共享同一对密钥时）：

```bash
node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key
```

`.tauri-key` 是私钥，**绝不能提交到仓库**（模板的 `.gitignore` 已经挡住了），
并且要单独备份。详见 [docs/04](docs/04-自动更新-签名与-update.json.md) 的
「私钥安全」一节 —— 它区分「私钥丢了」和「私钥泄露」两种后果，发版前请读完。

---

## 目录结构

```
template/
├── src-tauri/              桌面外壳（Rust）
│   ├── Cargo.toml          依赖与体积优化配置
│   ├── tauri.conf.json     ★ 应用名、窗口、打包、更新，都在这
│   ├── capabilities/       权限清单：默认什么都不给，用哪个放行哪个
│   ├── src/main.rs         入口（注册 updater / process 插件）
│   ├── icons/              图标（由 gen-icons.mjs 生成，可换）
│   └── WebView2Loader.dll  GNU 目标必需，缺了装完启动报错
├── src/                    前端（模板占位页，可整个替换）
├── scripts/                构建与环境脚本（这条路线的主体）
│   ├── env-check.mjs       ★ 环境自检：缺什么、装什么、走哪条路
│   ├── pack.mjs            ★ 打包主流程（5 步）
│   ├── build-desktop.mjs   ★ 真正调 cargo/tauri 的那一层
│   ├── launchers.mjs       其余 .bat 的实现
│   ├── setup-*.mjs         装 MSYS2 / MinGW / Rust 并配 GNU 目标
│   ├── mingw-locate.mjs    MinGW 定位的单一来源（三个脚本共用）
│   ├── toolchain-download.mjs  下载：能校验就校验，不能校验就要显式授权
│   ├── toolchain-path.mjs  读 .cargo/config.toml，算出要补哪些 PATH
│   ├── check-installer.mjs 装完能不能用：读 installer.nsi 逐文件核对
│   ├── smoke-test.mjs      真装一遍：装 → 启动 → 断言 WebView2 → 卸载 → 回收
│   ├── doc-lint.mjs        文档交叉引用检查（「见 docs/05 第 N 节」不能断链）
│   ├── gen-icons.mjs       零依赖生成整套图标（PNG + ICO）
│   ├── sync-webview2-loader.mjs  从 Rust 依赖里把 DLL 捞出来
│   └── project.mjs         产品名/版本的单一来源（读 tauri.conf.json）
└── *.bat                   面向双击的入口，全部是纯 ASCII 薄壳
```

`.bat` 之所以只是薄壳（几行 `node scripts/xxx.mjs`），是因为 **cmd.exe 的批处理解析器
无法可靠处理含多字节字符的 .bat**：它按字节偏移重新定位文件，中文会让偏移逐渐错位，
最后把某一行切在半个字符中间。实测数据见 [docs/05](docs/05-踩坑记录.md#1-bat-必须纯-ascii)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [01 选型：为什么是 Tauri](docs/01-选型-为什么是-Tauri.md) | 与 Electron / NW.js / pkg / nativefier 的对比，以及各自的适用边界 |
| [02 环境：不用管理员权限的 GNU 工具链](docs/02-环境-不用管理员权限的GNU工具链.md) | 两条路线的取舍，MSYS2 + MinGW 的装法，为什么能省掉 VS |
| [03 打包：五步流程](docs/03-打包-五步流程.md) | `pack.mjs` 每一步在做什么、失败时看哪里 |
| [04 自动更新：签名与 update.json](docs/04-自动更新-签名与-update.json.md) | 密钥、署名、清单、分发，以及**私钥安全**（空密码=明文、丢了与泄露是两件事） |
| [05 踩坑记录](docs/05-踩坑记录.md) | 每个坑的现象、根因、实测数据、最终解法 |

---

## 适用范围与边界

**适用**：把一个 Web 界面装进桌面窗口 + 需要系统能力（文件、通知、自动更新）+ 体积要小。

**不适用**：

- 目标是 macOS / Linux —— 这条路线只在 Windows 上验证过（Tauri 本身跨平台，
  但本文里的 GNU 工具链、NSIS、`.bat`、MinGW 的坑都是 Windows 专有内容）
- 需要打包 Node 原生模块（`sharp`、`better-sqlite3` 等）——那类需求 Electron 更直接，
  Tauri 要走 sidecar 或换用 Rust 实现
- 需要兼容 Windows 7 / 8 —— WebView2 不支持

**它也不替你解决这两件事**（属于路线的固有代价，不是脚本 bug）：

- **构建链的信任问题**：免管理员的 MinGW 装法绕开了 pacman 的包签名校验，
  脚本要求显式授权，但授权不等于校验。对供应链有硬要求（签名构建、受控镜像源）
  的场景，请走 MSYS2 官方安装程序 + pacman，或干脆用 MSVC 路线。
- **自动更新的密钥治理**：单个私钥文件被读到就等于整条更新链失守，
  而模板面向的是"个人开发者一台机器"。多产品/多人员协作发布时，
  你需要的是 KMS 或 HSM 里的签名能力，这套脚本不提供那一级保障。

---

## 许可

MIT。模板里的 `WebView2Loader.dll` 是微软的运行时文件，随 Microsoft 许可分发。
