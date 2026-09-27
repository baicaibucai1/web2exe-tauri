# 参与贡献

先说清楚这个仓库的产物是什么：一条**已经在真实项目里跑通的 Windows 打包路线** +
可复制模板 + 约 20 个 Node 构建脚本。所以改动的验收标准不是"能跑"，
而是"产出的安装包仍然装上能用、发版仍然不会挑错文件"。

## 环境要求

| 需要 | 版本 | 说明 |
|---|---|---|
| Windows 10 1803+ | — | 路线只在 Windows 验证过 |
| Node.js | **20+** | `package.json` 里有 `engines`；Vite 7 的要求 |
| 文档与脚本类改动 | 不需要 Rust | 下面一半的门禁只要 Node |
| 完整打包 | Rust(GNU) + MinGW-w64 | 见 docs/02 |

```bash
cd template && npm install
```

## 改完必须跑的门禁

```bash
npm run bat:check     # .bat 必须纯 ASCII + CRLF + 无 BOM（docs/05 第 1 节）
npm run docs:check    # 「见 docs/05 第 N 节」这类引用不能断链
npm run typecheck     # 前端类型
npm run webview2:check # 预置 DLL 与 Cargo.lock 锁定的版本是否一致
```

改了构建脚本或模板配置，再加这两条（都要真的编译一次，约 2–4 分钟）：

```bash
npm run pack          # 产出 setup.exe + .sig；内部会跑 check-installer 作为门禁
npm run smoke         # 真装一遍：装 → 启动 → 断言 WebView2 起来 → 卸载 → 回收
```

`smoke` 会往 `%LOCALAPPDATA%` 里安装再卸载，结束时自己清干净；
它只在本机 identifier 数据目录**已存在**时拒绝运行（那种情况说明有别的东西共用该路径）。
想留着窗口手点：`npm run smoke -- --keep`。

**为什么需要 smoke**：`check-installer` 全 PASS 只证明"文件在包里"，
而这条路线卖的是"双击装完能用"。它已经抓到过两条真事（见 docs/05 最后一节）。

## 约定

**`.bat` 只写 ASCII。** cmd.exe 按字节偏移定位批处理的行，多字节字符会让偏移漂移，
迟早有一行被切在半个字符中间。所有中文提示一律由 `scripts/*.mjs` 打印
（Node 写 UTF-8 字节，配合 `.bat` 里的 `chcp 65001` 正常显示）。
`bat-lint.mjs` 是这条约定的门禁，别绕。

**脚本保持 `.mjs`，不改 TypeScript。** "复制目录就走、不需要额外构建步骤"是这个模板的
卖点之一；要类型安全，用 JSDoc + `tsc --checkJs`，别引入编译步骤。

**同一件判断只写一处。** MinGW 的定位曾经是三份互相漂移的清单
（见 docs/05 第 12 节），现在统一在 `scripts/mingw-locate.mjs`。
产品名/版本/密钥密码统一从 `scripts/project.mjs` 读 `tauri.conf.json`。
新增探测逻辑请扩这两个模块，不要在调用方再写一份。

**"从产物目录挑文件"必须带身份条件。** 目录是追加写的、`readdirSync` 是字典序 ——
按顺序或后缀挑会挑到历史版本（docs/05 第 11 节）。版本号、mtime、哈希都行。

**写"实测"就要带版本和日期。** 本项目已经证伪过自己一条"实测"断言
（`-exclude-all-symbols` 并非必需，docs/05 第 2 节）。新增此类结论时，
把 `rustc -vV` / `ld --version` / CLI 版本与日期一起记下来，并更新
[VERSIONS.md](VERSIONS.md)。没有环境标注的数字视为未验证。

**改 docs/05 的节号要顺带改所有指回去的地方**，然后跑 `npm run docs:check`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN=1` | 授权 `setup:msys2` / `setup:mingw` 这种无校验下载（见 SECURITY.md） |
| `WEB2EXE_UPDATER_PASSWORD` | 更新私钥的密码；不设 = 空密码 = 私钥明文落盘 |
| `WEB2EXE_NO_SIGN=1` 或 `pack.mjs --no-sign` | 只出安装包，不产签名与 `update.json`（CI 用它） |
| `WEB2EXE_NO_GNU=1` | 跳过 GNU 工具链配置，按 MSVC 路线处理 |

## 提交信息风格

沿用仓库现有习惯：`fix:` / `feat:` / `docs:` + 中文标题，正文写**根因**和**实测结果**，
而不是罗列改了哪些文件。一个 commit 一个主题；按文件边界分组，保证每个 commit 都能独立构建。

CI 上跑的是 PR 级门禁（`.github/workflows/checks.yml` 的 `static` job）；
完整构建 + 冒烟挂在 schedule 上（要装约 1 GB 工具链），且**不带签名密钥**。
