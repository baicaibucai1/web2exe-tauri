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
拼进更新 URL 时要额外编码（详见主仓库 docs/05 第 10 节）。

**2. `src/`**

换成你自己的前端即可。两种做法：

- **整个替换**：把 `src/` 删掉，换成你的 Vite 工程。只需保证
  `vite.config.ts` 里 `server.port = 1420` 且 `build.outDir = "dist"`
- **只接产物**：保持 `src/` 不动，把 `tauri.conf.json` 的
  `build.frontendDist` 指向你自己的构建产物目录

`src/App.tsx` 是占位页，它存在的意义是"打包后能一眼看出前端跑起来了"，
而不是白屏让人以为打包坏了。可以放心删。

## 第一次打包前必须先做一次

```bash
node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key
# 询问密码时直接回车（用空密码，打包脚本按空密码处理）
```

然后把 `.tauri-key.pub` 的内容整段粘进 `tauri.conf.json` 的
`plugins.updater.pubkey`。

> **暂时不想要自动更新**？把 `tauri.conf.json` 里的
> `bundle.createUpdaterArtifacts` 改成 `false`，就可以跳过这一步直接打包。

`.tauri-key` 是私钥，**绝不能提交到仓库**（本目录的 `.gitignore` 已经挡住了）。
它丢了就再也无法给已安装的用户推送更新。

## 三个 .bat

| 文件 | 用途 |
|---|---|
| `启动开发版.bat` | 浏览器里跑前端，改代码即时刷新。日常开发用这个 |
| `启动桌面版.bat` | 在真实 Tauri 窗口里跑（debug 构建）。提交前用它验一遍 |
| `打包桌面版.bat` | 产出安装包 + 签名 + update.json |

其余三个（`安装Rust环境.bat` 等）是环境安装引导，只在第一次需要。

**这些 .bat 必须是纯 ASCII** —— 原因见主仓库 docs/05 第 1 节。
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
```

打包失败时先看第 1 条；觉得"装完应该有问题"看第 3 条。
两个脚本都在主仓库 docs/03 的表格里有对应关系。

## 更详细的说明

主仓库 `../README.md` 与 `../docs/` 下有五个文档：
选型理由、环境搭建、打包流程、自动更新、踩坑记录。遇到怪问题先翻最后一个。
