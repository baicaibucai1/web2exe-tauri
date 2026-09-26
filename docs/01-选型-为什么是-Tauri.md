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
| Electron | 80 – 180 MB | 200 – 400 MB | 有（Node 侧） | ✅ | 每个应用打包一个 Chromium |
| NW.js | 100 – 200 MB | 200 – 400 MB | 有（Node 侧） | ✅ | 与 Electron 同代，生态更小 |
| nativefier | ≈ Electron | ≈ Electron | 弱 | ✅ | Electron 封装器；**2023-09 起官方归档停运** |
| pkg / Node SEA | 40 – 90 MB | 60 – 150 MB | 有（Node 侧） | ✅ | 打包的是 **Node 程序**，不是 Web 界面 —— 要自己起服务再开浏览器，体验不对；pkg 也已停维，官方替代是 Node SEA |
| PWA / 快捷方式 | 0 | — | 无 | — | 不是 exe，用户要的"双击安装"没有 |

注意"免管理员打包"这一列不要读反：**Electron / NW.js 也不需要管理员权限**。
它们的构建只要 Node（`npm i` + `electron-builder`），不碰 Visual Studio，
产物默认装到用户目录。本路线选 Tauri 的真实理由是**体积和内存**，
"不用装 2–4 GB 的 C++ 生成工具"是 Tauri 相对 MSVC 路线的省钱之处，
不是相对 Electron 的优势。

差别的根源只有一句话：**Electron 把整个浏览器内核打进你的安装包，Tauri 用系统里已有的**。

- Windows 11 内置 WebView2 Runtime；Windows 10 靠系统更新推送（2022 年起绝大多数机器有），
  但 **LTSC、精简版、离线或长期不更新的机器可能没有**
- 于是 Tauri 的安装包里只有一个几 MB 的 Rust 程序和你的前端资源

代价是：**不支持 Windows 7/8**（没有 WebView2），并且**依赖目标机器上有 WebView2**。
这一条由 NSIS 打包器兜底：`bundle.windows.webviewInstallMode` 默认是
`downloadBootstrapper`，装应用时若检测不到就联网拉 Evergreen Bootstrapper 补装
（模板里已把它显式写出来，别依赖默认值）。离线分发的场景改 `offlineInstaller`
或 `embedBootstrapper`，见 docs/02。

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
| 需要 WebView2 | Win11 内置；Win10 靠更新推送，LTSC/离线机器可能没有 → 靠安装包的 `webviewInstallMode` 补装 |
| 首编慢 | 首次编译 Rust 依赖：实测 4 分钟（16 核、依赖已在本地缓存、`lto = true`），冷缓存的机器上按 5–15 分钟预估更稳；之后增量几秒到几十秒 |
| Rust 门槛 | 用不到系统能力时可以完全不写 Rust；一旦要写，就得会一点 |

最后一条值得展开：**模板里已经把所有必要配置写好了**，如果只是"把网页装进窗口"，
可以一行 Rust 都不写。`src-tauri/src/main.rs` 保持原样即可。
