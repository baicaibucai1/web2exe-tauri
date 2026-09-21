# 01 选型：为什么是 Tauri

## 需求

把一个**已经做好的 Web 应用**变成 Windows 上能双击运行的 `.exe`，并且：

- 安装包别太大（用户下载、内网分发都方便）
- 内存占用别太高（桌面常驻工具，不是打开就关的页面）
- 需要一点系统能力（读写本地文件、发通知、自动更新）
- 不想为了打包去装 Visual Studio（2–4 GB，还要管理员权限）

## 候选与实测

| 方案 | 安装包 | 运行内存 | 系统能力 | 免管理员打包 | 说明 |
|---|---|---|---|---|---|
| **Tauri 2** | **2.5 – 8.4 MB** | **60 – 120 MB** | 有（Rust 侧） | ✅ GNU 路线 | 本路线采用 |
| Electron | 80 – 180 MB | 200 – 400 MB | 有（Node 侧） | ❌ 需要 | 每个应用打包一个 Chromium |
| NW.js | 100 – 200 MB | 200 – 400 MB | 有（Node 侧） | ❌ 需要 | 与 Electron 同代，生态更小 |
| nativefier | ≈ Electron | ≈ Electron | 弱 | ❌ 需要 | Electron 的封装器，产出的是"网页套壳" |
| pkg / Node SEA | 40 – 90 MB | 60 – 150 MB | 有（Node 侧） | ✅ | 打包的是 **Node 程序**，不是 Web 界面 —— 要自己起服务再开浏览器，体验不对 |
| PWA / 快捷方式 | 0 | — | 无 | — | 不是 exe，用户要的"双击安装"没有 |

差别的根源只有一句话：**Electron 把整个浏览器内核打进你的安装包，Tauri 用系统里已有的**。

- Windows 10/11 自带 WebView2（Edge 的内核），Tauri 直接复用它
- 于是 Tauri 的安装包里只有一个几百 KB 的 Rust 程序和你的前端资源

代价是：**不支持 Windows 7/8**（没有 WebView2），**依赖系统装了 WebView2**
（Win10 1803+ 默认有；更老的系统需要引导安装，`bundle.resources` 里放引导程序即可）。

## 为什么不选 Electron

Electron 换成的是 **Node 原生模块能力**：`sharp`、`better-sqlite3`、
`node-ffi` 这类东西在 Electron 里开箱可用，在 Tauri 里要么走 sidecar
（额外带一个 Node 进程，体积和内存优势立刻消失），要么用 Rust 重写。

所以判断标准很干脆：

- **前端就是普通 Web 技术，系统能力只需要文件/通知/更新** → Tauri
- **重度依赖 Node 原生模块**（图像处理、数据库驱动、桌面自动化）→ Electron

本路线瞄准的是前一类。这类需求在实际项目里占大多数，而它们为 Node 原生模块
付出的 80–180 MB 体积是纯浪费。

## 为什么不自己写 Win32 / WPF / 用 CEF

- CEF（Chromium Embedded Framework）：和 Electron 同样的体积问题，还要自己维护 C++ 构建
- WPF / WinForms：要重写一遍界面，等于放弃已有的 Web 前端
- 直接调系统浏览器开本地页面：不是"应用"，没有安装、没有更新、没有独立窗口

## 已知边界

| 边界 | 说明 |
|---|---|
| 仅 Windows | 本路线里的 GNU 工具链、NSIS、`.bat` 都是 Windows 专有。Tauri 本身跨平台，换平台要换打包方式 |
| 需要 WebView2 | Win10 1803+ 自带；更老的系统要引导安装 |
| 首编慢 | 首次编译 Rust 依赖 5–15 分钟（之后增量几秒到几十秒） |
| Rust 门槛 | 用不到系统能力时可以完全不写 Rust；一旦要写，就得会一点 |

最后一条值得展开：**模板里已经把所有必要配置写好了**，如果只是"把网页装进窗口"，
可以一行 Rust 都不写。`src-tauri/src/main.rs` 保持原样即可。
