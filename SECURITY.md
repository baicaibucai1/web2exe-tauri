# 安全策略

这个项目分发的不只是一个模板，而是一条**能产出可自动更新软件**的构建路线。
所以它的安全面比一般脚手架大：涉及签名私钥、工具链下载、以及更新通道。

## 怎么报告漏洞

开 GitHub Issue（如果是可以被利用的，请先用提交历史里的邮箱私下联系维护者）：

- 哪一步、哪个脚本、什么版本（见 [VERSIONS.md](VERSIONS.md) 的指纹表）
- 复现命令
- 影响面：只影响构建机？还是影响产出的安装包与它的更新链？

## 一、更新签名私钥是整条信任链的单点

已安装的客户端只认它编译时内置的那一个公钥。
**谁能用配对的私钥签一份 `update.json`，谁就能让所有已安装用户自动装上他给的程序**
（模板的 `src/updater.ts` 调 `downloadAndInstall()`，中间没有确认弹窗）。

因此：

| 事实 | 后果 |
|---|---|
| 不设 `WEB2EXE_UPDATER_PASSWORD` 时，私钥以**空密码**生成 | `.tauri-key` 落盘等同明文，读到文件 = 拿到推送权限 |
| 私钥丢了 | 再也无法给已安装用户推更新，只能让他们手动重装一次 |
| 换密钥对（轮换或泄露后应急） | 老客户端内置旧公钥，新包它验不过 —— 同样只能人工重装铺路 |

完整处置步骤在 [docs/04](docs/04-自动更新-签名与-update.json.md) 的「私钥安全」和
「私钥备份、交接与泄露处置」两节。要点：**私钥与密码分开备份、都不进仓库、CI 里不留私钥。**

### CI 里不放签名密钥（本项目的既定做法）

`.github/workflows/checks.yml` 的完整构建 job 用 `WEB2EXE_NO_SIGN=1` 打包，
产物没有 `.sig`、也不生成 `update.json`。理由：把签名能力放进 CI，等于让 runner、
artifact 存储和所有能读 secret 的人共同持有"向全部用户推程序"的权力。
发布签名由维护者在本地做。

## 二、工具链下载的供应链边界（必须读）

免管理员的那两个装法（`npm run setup:msys2` / `npm run setup:mingw`）
**绕开了 pacman 的包签名校验**：直接从镜像下载归档、解压、然后执行里面的 `gcc.exe`。

```
下载内容无完整性校验 → 解压出的 gcc.exe 被执行 → 之后每个安装包都建立在它之上
```

所以这两个脚本要求显式授权：

```bat
set WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN=1
```

没有可信校验和锚点时，脚本会把下载内容的 SHA-256 打出来，便于你与镜像公告值人工比对。

**能接受管理员权限时请用 MSYS2 官方安装程序 + `pacman`**（它验包签名）。
pacman 首次卡住通常是密钥环没初始化，该修的是这个：

```bash
pacman-key --init
pacman-key --populate msys2
```

有官方锚点的下载一律真校验：`rustup-init.exe` 必须通过
`static.rust-lang.org` 公布的 `.sha256` 才会被执行（二进制可以先从镜像取，
跨主机比对摘要才有意义；不符即丢弃）。

## 三、应用侧的默认安全姿态

- **capabilities 是白名单**：`template/src-tauri/capabilities/default.json`
  默认只放行 `core` / `updater` / `process` 三组。前端调不到任何系统能力，
  要用就在 `permissions` 里逐项加 —— 这是有意的，不要图省事改成大范围授权。
- **`security.csp` 默认是 `null`**：模板不预设 CSP，因为它不知道你的前端会加载什么。
  **这是留给使用者的责任**，不是"已经配好了"。发布前按你的资源来源写 CSP；
  若用 `assetProtocol` 读包内资源，注意路径会被编码成 `$RESOURCE/_up_/...`
  （见 docs/05 第 6 节）。
- **更新端点必须 HTTPS**，且 `update.json` 的 url 与安装包要来自同一目录。
- **别共用 `identifier`**：它决定数据目录归属（`$APPDATA` / `$LOCALAPPDATA`
  下的 `<identifier>`，含 WebView2 的 cookie 与 localStorage）。
  两款应用共用它 = 共享数据；而交互式卸载时勾选"删除应用数据"会把另一家的整目录删掉。

## 四、不在这个模板的安全边界之内

- 它面向"个人开发者一台机器"。多人协作或多产品发布需要的是 KMS/HSM 级签名能力，
  这套脚本不提供那一级保障。
- 它不验证产物的恶意行为，只验证"能不能装、能不能起来"（`npm run smoke`）。
- 不支持 Windows 7/8（没有 WebView2），也不为其提供兼容层。
