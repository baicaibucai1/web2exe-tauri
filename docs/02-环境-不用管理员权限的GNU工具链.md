# 02 环境：不用管理员权限的 GNU 工具链

## 两条路线

Tauri 在 Windows 上有两种编译方式：

| | 路线 A：MSVC | 路线 B：GNU（本路线） |
|---|---|---|
| 依赖 | Visual Studio Build Tools | MSYS2 + MinGW-w64 |
| 下载量 | **2 – 4 GB** | 约 300 MB – 1 GB |
| 管理员权限 | **需要**（要写系统目录） | **不需要**（解压在用户目录） |
| 典型失败 | 缺 Windows SDK、缺 `kernel32.lib` | 找不到 `windres`（PATH 没补）、符号导出上限（cdylib 形态才会撞） |
| 包完整性校验 | Visual Studio 安装器自带 | **取决于装法，见下面第 1、2 步** |
| 官方支持 | 默认路线 | 官方维护的 target，成熟可用 |

选 B 的理由：**不想为了打个包让使用者装 2–4 GB 的 C++ 生成工具并要管理员密码**。
这条路线的全部价值在于"解压 + 补 PATH"，而不是"改系统"。

> 别把这条理由推广成"Electron 要管理员"：打 Electron 包同样不需要提权（只要 Node）。
> A/B 之争只关于 **Rust 用哪个链接器**，与选不选 Tauri 无关。

模板的 `env-check.mjs` 会同时探测两条路线，并明确告诉你走哪条：

```
路线 A（MSVC）不可用 —— 缺少 C++ 生成工具（约 2-4 GB，需管理员权限）
路线 B（GNU）已就绪 —— 可用 MinGW 打包，无需 C++ 生成工具
```

## 安装顺序

四个脚本，依次跑（都有对应的 `.bat` 或 `npm run`）：

| 步骤 | 脚本 | 做什么 | 包签名校验 |
|---|---|---|---|
| 1 | `setup-msys2.mjs` | 下载免安装版 MSYS2，解压到用户目录 | ❌ 无，需显式授权 |
| 2 | `setup-mingw.mjs` | 直接从镜像下载并解压 MinGW-w64 工具链 | ❌ 无，需显式授权 |
| 3 | `setup-rust.mjs` | 装 Rust（GNU 目标），等价于双击「安装Rust环境.bat」 | ✅ 按官方 `.sha256` 校验 |
| 4 | `setup-gnu.mjs` | 探测 MinGW 真实路径，生成 `src-tauri/.cargo/config.toml` | — |

## 第 1、2 步绕开了 pacman，这是有代价的

当初绕开 pacman 的真实原因是：`pacman` 必须先初始化 GnuPG 密钥环才能验包签名，
而密钥环初始化在那台机器上反复卡住 —— 直接把 `.pkg.tar.zst` 解开更快。
但代价必须说清楚：

**这条路上的下载没有任何完整性校验，而解压完就会执行里面的 `gcc.exe`。**
镜像被替换、DNS 被污染、缓存目录被塞文件时，进入构建链的是别人的二进制，
之后每一个安装包都建立在它之上 —— 这比"装了个软件"严重，因为它污染的是产物本身。

所以脚本要求显式授权，不默认放行：

```bat
set WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN=1
npm run setup:msys2
npm run setup:mingw
```

能接受管理员权限时，更推荐官方安装程序 + pacman（它会验包签名）：

```
1. 下载 https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/x86_64/ 里最新日期的 exe 装上
2. 在「MSYS2 MINGW64」终端里：pacman -S mingw-w64-x86_64-gcc
```

pacman 卡住时该修的是卡住本身，而不是关掉校验：

```bash
pacman-key --init              # 卡住常因熵源不足，先在终端里多敲几下再等
pacman-key --populate msys2    # 导入签名密钥环
```

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

三件事的必要程度**不同**，别再一起当成"缺一不可"：

- `target` —— **必需**。缺了它 cargo 会用 rustup 的默认 toolchain；默认若是 msvc，
  前面所有 crate 都编得过，直到最后链接才报 `could not open 'kernel32.lib'`
  —— 一次十几分钟的静默空转，详见 docs/05 第 15 节
- `linker` / `ar` —— **必需**，写绝对路径，因为 MinGW 不在持久 PATH 里
- `rustflags` —— **是保险，不是必需**。实测（binutils 2.47 + Rust 1.98，2026-09-26）
  去掉它同样链接成功：本模板是 bin 型应用，产出的 exe 连导出表都没有。
  会撞 65535 上限的是 cdylib/DLL 形态或更老的工具链组合，留着它成本为零。
  更正记录见 docs/05 第 2 节

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

**这个脚本不安装、不改系统状态**，只在本目录写一份「环境自检报告.txt」。
装什么、怎么装，由你按提示自己决定。

## 目标机器上的 WebView2（分发前必看）

开发机上有没有 WebView2 都不影响打包，但**决定了用户装完能不能打开**。事实是：

- Windows 11：内置 Evergreen Runtime
- Windows 10：2022 年起随系统更新推送，**多数**机器有；LTSC、精简镜像、
  长期离线或关掉更新的机器可能没有
- Windows 7/8：没有，也不会有 —— 这类需求本路线不支持

不要靠"用户机器应该自带"，让安装包自己补 —— NSIS 有内置机制，模板里已显式写出：

```json
"bundle": {
  "windows": {
    "webviewInstallMode": { "type": "downloadBootstrapper" }
  }
}
```

| type | 行为 | 适用 |
|---|---|---|
| `downloadBootstrapper`（默认） | 装应用时联网拉 Runtime | 绝大多数场景 |
| `embedBootstrapper` | 把几 KB 的引导程序打进包，仍需联网下 Runtime | 想要"包里自带引导"的说法 |
| `offlineInstaller` | 把约 1.5 GB 的完整安装包打进你的包 | 内网/离线分发 —— 体积优势就没了 |
| `manualInstall` | 什么都不做 | 你自己控制安装顺序 |

`silent: true` 会让补装静默进行，但**可能触发 UAC**，与本路线"不要管理员密码"的
目标冲突，所以默认不开。
