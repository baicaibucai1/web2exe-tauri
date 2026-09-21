# web2exe-tauri

把**已有的 Web 应用**（静态站、Vite / React / Vue 的构建产物、单页 HTML）打包成
Windows 桌面应用与安装包的完整路线，附带可直接复制的模板。

这里沉淀的不是"一个能跑的 demo"，而是**一条已经在真实项目里跑通的路线**：
环境怎么装、坑在哪、每个坑的实测数据是什么、为什么这么选而不是那么选。

---

## 这条路线解决什么

| | 做法 | 代价 |
|---|---|---|
| **不用管理员权限** | 编译器解压在用户目录，工具链靠脚本补 PATH | 需要脚本代劳 PATH（用户不用管） |
| **不用 Visual Studio** | 走 GNU 工具链（MSYS2 + MinGW-w64） | 需处理 MinGW 的符号导出上限，见 docs/05 |
| **安装包小** | Tauri 复用系统自带的 WebView2，不打包浏览器内核 | 依赖系统 WebView2（Win10/11 已自带） |
| **自动更新可用** | Tauri updater + 签名密钥 + 静态 update.json | 必须保管好私钥，丢了无法推送更新 |
| **对使用者友好** | 全程双击 `.bat`，不需要开命令行 | `.bat` 必须纯 ASCII（这是个真坑，见下） |

实测产物（同一份前端，两种外壳对比）：

| 外壳 | 安装包 | 运行内存 |
|---|---|---|
| Tauri 2（本路线） | 2.5 – 8.4 MB | 约 60 – 120 MB |
| Electron | 80 – 180 MB | 约 200 – 400 MB |

差别的来源只有一个：Electron 打包一整个 Chromium，Tauri 用系统里已有的 WebView2。

---

## 快速开始

### 前置条件

| 需要什么 | 怎么来 | 大小 |
|---|---|---|
| Windows 10 1803+ | 系统自带 WebView2，不用装 | — |
| Node.js 18+ | 官网安装包，一路下一步 | ~30 MB |
| Rust（GNU 工具链） | 双击 `安装Rust环境.bat`，它会问你要 GNU 还是 MSVC，**选 GNU** | ~400 MB |
| MinGW-w64 | 双击 `安装MinGW环境.bat` 看步骤（下载 MSYS2 后 `pacman -S mingw-w64-x86_64-gcc`） | ~100 MB |

全部装在用户目录，**不需要管理员权限**。装完不需要重开终端 —— 打包脚本会自己补 PATH。

不装 Visual Studio 是这条路线的主要收益之一（省 2–4 GB 和一个管理员密码），
代价见 [docs/02](docs/02-环境-不用管理员权限的GNU工具链.md)。

### 三步

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
| `启动桌面版.bat` | 在真实 Tauri 窗口里跑一遍 | 首次编译 Rust 依赖 5–15 分钟 |
| `打包桌面版.bat` | 产出安装包 + 更新签名 + update.json | 3–5 分钟（依赖已编好） |

**首次打包前必须先生成一次签名密钥**（自动更新强制要求）：

```bash
node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key
# 会询问密码，直接回车用空密码 —— 打包脚本按空密码处理
```

生成的两份文件里，`.tauri-key` 是私钥，**绝不能提交到仓库**（模板的 `.gitignore` 已经挡住了）；
`.tauri-key.pub` 是公钥，内容要粘进 `tauri.conf.json` 的 `plugins.updater.pubkey`。

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
│   ├── toolchain-path.mjs  读 .cargo/config.toml，算出要补哪些 PATH
│   ├── check-installer.mjs 装完能不能用：读 installer.nsi 逐文件核对
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
| [04 自动更新：签名与 update.json](docs/04-自动更新-签名与-update.json.md) | 密钥、署名、清单、分发，以及"签名密码不能靠 cmd 设置"这类细节 |
| [05 踩坑记录](docs/05-踩坑记录.md) | 每个坑的现象、根因、实测数据、最终解法 |

---

## 适用范围与边界

**适用**：把一个 Web 界面装进桌面窗口 + 需要系统能力（文件、通知、自动更新）+ 体积要小。

**不适用**：

- 目标是 macOS / Linux —— 这条路线只在 Windows 上验证过（Tauri 本身跨平台，
  但本文里的 GNU 工具链、NSIS、`.bat`、MinGW 符号坑都是 Windows 专有内容）
- 需要打包 Node 原生模块（`sharp`、`better-sqlite3` 等）——那类需求 Electron 更直接，
  Tauri 要走 sidecar 或换用 Rust 实现
- 需要兼容 Windows 7 / 8 —— WebView2 不支持

---

## 许可

MIT。模板里的 `WebView2Loader.dll` 是微软的运行时文件，随 Microsoft 许可分发。
