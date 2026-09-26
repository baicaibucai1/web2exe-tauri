# template

把这个目录整个复制出去，就是你的桌面应用工程。

```bash
cp -r template ../my-app
cd ../my-app
npm install
```

## 只需要改两个地方

**1. `src-tauri/tauri.conf.json`**

```jsonc
{
  "productName": "你的应用名",          // 安装包名、任务栏标题
  "identifier": "com.yourname.myapp",   // 反向域名，全项目唯一
  "app": { "windows": [{ "title": "你的应用名", "width": 1120, "height": 760 }] }
}
```

`productName` 建议用 ASCII —— 中文名会让安装包文件名含中文，
拼进更新 URL 时要额外编码（详见本路线仓库的 `docs/05` 第 10 节）。

**2. `src/`**

换成你自己的前端即可。两种做法：

- **整个替换**：把 `src/` 删掉，换成你的 Vite 工程。只需保证
  `vite.config.ts` 里 `server.port = 1420` 且 `build.outDir = "dist"`
- **只接产物**：保持 `src/` 不动，把 `tauri.conf.json` 的
  `build.frontendDist` 指向你自己的构建产物目录

`src/App.tsx` 是占位页，它存在的意义是"打包后能一眼看出前端跑起来了"，
而不是白屏让人以为打包坏了。可以放心删。

## 签名密钥：交给打包脚本

第一次双击 `打包桌面版.bat` 时它会问一句「现在生成一对签名密钥吗」，答 Y 就行：
它会生成 `.tauri-key`（私钥）与 `.tauri-key.pub`（公钥），
并**自动把公钥写进** `tauri.conf.json` 的 `plugins.updater.pubkey`。

公私钥必须成对。公钥还是模板占位符的话，打包会在**全部编译完成之后**
（原作者机器上实测 42 分钟，取决于依赖量）才报 `failed to decode pubkey` —— 所以这件事必须在编译前查掉。

**默认生成的是空密码私钥，也就是不加密、等同明文。** 请把它当成一把能对所有
已安装用户下指令的钥匙来对待：

```bash
# 想让私钥加密：生成与以后每次打包都用同一个值，脚本会自动读、不需要交互输入
set WEB2EXE_UPDATER_PASSWORD=你的密码
```

想手动生成（比如多台机器共享同一对密钥）：

```bash
node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key
```

> **暂时不想要自动更新**？把 `tauri.conf.json` 里的
> `bundle.createUpdaterArtifacts` 改成 `false`，就可以跳过密钥直接打包。

`.tauri-key` 是私钥，**绝不能提交到仓库**（本目录的 `.gitignore` 已经挡住了），
并且要单独备份。"私钥丢了"和"私钥被人读到"是两种完全不同的后果，
详见仓库的 `docs/04` 的「私钥安全」一节。

## 三个 .bat

| 文件 | 用途 |
|---|---|
| `启动开发版.bat` | 浏览器里跑前端，改代码即时刷新。日常开发用这个 |
| `启动桌面版.bat` | 在真实 Tauri 窗口里跑（debug 构建）。提交前用它验一遍 |
| `打包桌面版.bat` | 产出安装包 + 签名 + update.json |

其余三个（`安装Rust环境.bat` 等）是环境安装引导，只在第一次需要。

**这些 .bat 必须是纯 ASCII** —— 原因见本路线仓库的 `docs/05` 第 1 节。
所以窗口标题写在 .bat 里、中文提示由 `scripts/*.mjs` 打印。
想改窗口标题就改 .bat 里的 `title Web2Exe - Dev` 那一行，**保持纯英文**。

## 图标

`src-tauri/icons/` 里现在是 `gen-icons.mjs` 生成的**占位图标**
（青绿圆角方块 + 白色对勾）。换成你自己的：

- 改配色/形状 → 编辑 `scripts/gen-icons.mjs` 后跑 `npm run icons`
- 用设计稿 → 直接覆盖同名文件（Tauri 只强制要 `32x32.png`、
  `128x128.png`、`icon.ico` 这三个，其余是 Windows 商店用的）

## 排错顺序

```bash
node scripts/env-check.mjs        # 1. 环境有什么问题，它会直说
node scripts/build-status.mjs     # 2. 编译到哪一步了、产物在哪
node scripts/check-installer.mjs --verbose   # 3. 包里到底装了什么
node scripts/smoke-test.mjs       # 4. 真装一遍：能不能打开
```

打包失败时先看第 1 条；觉得"装完应该有问题"看第 3、4 条 ——
第 3 条只保证文件在包里，第 4 条才证明起得来（它会自己卸载干净，
加 `--keep` 可以留着窗口手点）。

仓库根还有一条文档链接检查（改 `docs/` 里的节号后跑它）：

```bash
node scripts/doc-lint.mjs         # 或 npm run docs:check
```

## 关于 src-tauri/.cargo/config.toml

这个文件**不在仓库里**，因为它记录的是本机 MinGW 的绝对路径。
`打包桌面版.bat` 发现它不存在时会自动跑 `setup-gnu.mjs` 生成，
所以正常情况下你不用管它。

它做三件事，必要程度不一样：

| 内容 | 必需？ | 少了会怎样 |
|---|---|---|
| `[build] target = "x86_64-pc-windows-gnu"` | **必需** | cargo 走 rustup 默认 toolchain；若是 msvc，会先白编译十几分钟再报 `could not open 'kernel32.lib'` |
| `linker` / `ar` 绝对路径 | **必需** | MinGW 不在持久 PATH 里，链接阶段找不到工具 |
| `-C link-arg=-Wl,-exclude-all-symbols` | 保险 | 实测去掉也编得过 —— 见下 |

那行 `rustflags` 约束的是 PE **导出表**（序号上限 65535），而桌面应用是 `bin`，
链接出的 exe 没有导出表，所以对本模板是空操作；留着它的成本为零，
收益是你哪天改成 cdylib 形态（或继承了别人的 `crate-type = ["cdylib", "rlib"]`）
时不会撞上那个真实存在的错误。完整实测记录见仓库 `docs/05` 第 2 节。

删掉这个文件不会立刻报错，而是可能先白编译十几分钟 —— 详见 `docs/03` 第 2 步。

## 更详细的说明

本路线仓库（也就是本目录的上一级）的 `README.md` 与 `docs/` 下有五个文档：
选型理由、环境搭建、打包流程、自动更新、踩坑记录。遇到怪问题先翻最后一个。

> 把 template 整个复制出去之后，这些文档就不在旁边了。建议一并复制 `docs/`，
> 或者记住本仓库地址，出问题时回去查。
