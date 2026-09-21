# 02 环境：不用管理员权限的 GNU 工具链

## 两条路线

Tauri 在 Windows 上有两种编译方式：

| | 路线 A：MSVC | 路线 B：GNU（本路线） |
|---|---|---|
| 依赖 | Visual Studio Build Tools | MSYS2 + MinGW-w64 |
| 下载量 | **2 – 4 GB** | 约 300 MB – 1 GB |
| 管理员权限 | **需要**（要写系统目录） | **不需要**（解压在用户目录） |
| 典型失败 | 缺 Windows SDK、缺 `kernel32.lib` | 符号导出上限（有解，见 docs/05 第 2 节） |
| 官方支持 | 默认路线 | 官方维护的 target，成熟可用 |

选 B 的理由就一个：**不可能为了打个包让使用者去装 Visual Studio 并要求管理员权限**。
这条路线的全部价值在于"解压 + 补 PATH"，而不是"改系统"。

模板的 `env-check.mjs` 会同时探测两条路线，并明确告诉你走哪条：

```
路线 A（MSVC）不可用 —— 缺少 C++ 生成工具（约 2-4 GB，需管理员权限）
路线 B（GNU）已就绪 —— 可用 MinGW 打包，无需 C++ 生成工具
```

## 安装顺序

四个脚本，依次跑（都有对应的 `.bat` 或 `npm run`）：

| 步骤 | 脚本 | 做什么 |
|---|---|---|
| 1 | `setup-msys2.mjs` | 下载免安装版 MSYS2，解压到用户目录 |
| 2 | `setup-mingw.mjs` | **绕开 pacman**，直接从镜像下载并解压 MinGW-w64 工具链 |
| 3 | `setup-rust.mjs` | 装 Rust（GNU 目标），走清华镜像避免源站超时 |
| 4 | `setup-gnu.mjs` | 探测 MinGW 真实路径，生成 `src-tauri/.cargo/config.toml` |

第 2 步为什么绕开 pacman：`pacman` 需要网络稳定、要签名校验、要自己处理依赖，
在"只想拿到一个 gcc"的场景里失败点太多。直接把 mingw-w64 的包解开更快也更可控。

## 第 4 步才是关键

`setup-gnu.mjs` 生成的 `src-tauri/.cargo/config.toml` 长这样：

```toml
[build]
target = "x86_64-pc-windows-gnu"

[target.x86_64-pc-windows-gnu]
linker = "C:\\Users\\<你>\\msys64\\mingw64\\bin\\gcc.exe"
ar = "C:\\Users\\<你>\\msys64\\mingw64\\bin\\ar.exe"
rustflags = [
  "-C", "link-arg=-Wl,-exclude-all-symbols",
]
```

三件事各有原因：

- `target` —— 让 cargo 默认走 GNU，不用每次手写 `--target`
- `linker` / `ar` —— 写**绝对路径**，因为 MinGW 不在持久 PATH 里
- `rustflags` —— 解决 MinGW 的符号导出上限，缺了会在链接最后一步失败（详见 docs/05 第 2 节）

关闭它：`npm run setup:gnu -- --off`。

## 为什么不用重开终端

MinGW 装在用户目录，**不在**系统 PATH 里。传统做法是让你手动加环境变量再重开窗口 ——
这一步是新手最容易卡住的地方（加了没生效、加错了位置、加了但需要重启）。

本路线的做法：**PATH 由脚本在运行时注入**。

`toolchain-path.mjs` 读上面那份 `config.toml`，取出 `gcc.exe` 所在目录，
`build-desktop.mjs` 把它拼进子进程的 `PATH`。于是：

- 装完环境，立刻就能打包，不用重开窗口
- 换机器/换路径时，只改一处配置
- 系统中 PATH 保持干净，不污染用户环境

## 验证环境

```bash
node scripts/env-check.mjs
```

它检查：Node 版本、前端依赖、项目必需文件、Rust 三件套、MSVC 与 MinGW 的可用性、
NSIS 缓存、WebView2 运行时，最后给出**能不能打包**的明确结论（并以退出码体现，
所以它同时是打包流程的第 1 步门禁）。

它还有个附带价值：顺带校验 6 个 `.bat` 的编码（纯 ASCII + CRLF + 无 BOM），
这是 docs/05 第 1 节那个坑的门禁。

**这个脚本只做检测，不安装、不修改任何东西。** 装什么、怎么装，由你按提示自己决定。
