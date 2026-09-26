# 04 自动更新：签名与 update.json

桌面应用装了之后怎么更新？本路线用的是 **Tauri updater + 静态 JSON 清单**：
不需要服务器和接口，把一个 JSON 和安装包丢到任意静态目录（对象存储、Nginx、
GitHub Releases 都行）即可。

## 链路

```
应用启动 → 请求 endpoints 指向的 update.json
        → 比对 version，有新版
        → 下载安装包（用内置公钥验签）
        → 安装并重启
```

## 一次性准备

> **这两步打包脚本会替你做完。** `pack.mjs` 在第 [2/5] 步发现没有 `.tauri-key` 时会
> 问一句「现在生成一对吗」（默认生成、空密码），然后把 `.tauri-key.pub` 自动写进
> `tauri.conf.json` 的 `plugins.updater.pubkey`。
>
> 下面写的是手工做法 —— 想在多台机器间共享同一对密钥、或者要自己控制密钥时用得上。

### 1. 生成密钥对

```bash
node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key
```

会询问密码 —— 直接回车是**空密码**，私钥不加密落盘。
想让打包全程不交互又带密码，就设环境变量：

```bat
set WEB2EXE_UPDATER_PASSWORD=你的密码
```

生成（`pack.mjs`）与签名（`build-desktop.mjs`）都读同一个变量，所以不需要任何
交互输入。**注意：原文说过"非空密码必须走交互式输入、双击 .bat 做不到"，
那是错的** —— 密码是通过环境变量传给 Tauri CLI 的，非空一样能全自动；
真正的取舍是"这个密码放在哪里、谁能读到"，而不是"技术上能不能自动化"。

生成两个文件：

| 文件 | 用途 | 处理方式 |
|---|---|---|
| `.tauri-key` | **私钥**，给更新包签名 | 绝不能提交仓库（模板 `.gitignore` 已挡住），单独备份 |
| `.tauri-key.pub` | 公钥，给应用验签 | 内容粘进 `tauri.conf.json` |

## 私钥安全（这一节请读完）

updater 的信任链是这样的：**已安装的客户端只认它编译时内置的那一个公钥**。
所以谁能用配对的私钥签一份 `update.json`，谁就能让所有已安装用户自动装上他给的程序
—— 模板的 `src/updater.ts` 调的是 `downloadAndInstall()`，中间没有确认弹窗。

由此推出三条必须知道的：

1. **空密码 = 私钥等同明文。** 拿到 `.tauri-key` 这个文件就等于拿到推送权限，
   不需要任何别的凭据。笔记本丢失、目录被同机器上的其他程序读到、备份被共享，
   都是直接失守。用 `WEB2EXE_UPDATER_PASSWORD` 把私钥加密，密码单独存（不要和文件放一起）。
2. **私钥丢了和私钥泄露是两种后果，别混。**
   - **私钥丢了**（文件没了、密码忘了）：再也无法给已安装用户推送更新，
     只能让他们手动重装一次新版本（重装后内置新公钥，之后照常）。
   - **换了新密钥对**（故意轮换，或私钥泄露后紧急替换）：老用户的客户端内置的还是
     **旧公钥**，新包它验不过 —— 同样要手动重装一次才能接上新链条。
     也就是说"轮换"不是免费的，第一次要靠人工铺路。
3. **备份位置要独立于工作机器**：离线密码管理器 + 一份异地副本。
   `.tauri-key` 在 `.gitignore` 里，所以它只会存在于本机 —— 机器坏掉就是第 2 条的第一种后果。

如果只是想先出包、暂不上自动更新：把 `bundle.createUpdaterArtifacts` 设为 `false`，
完全不生成签名产物，也就没有密钥管理负担（但以后要上更新，第一次发布的包就得重打）。

## 私钥备份、交接与泄露处置（照着做）

### 备份什么

| 东西 | 为什么单独算一份 |
|---|---|
| `.tauri-key` 文件本体 | 丢了 = 无法再签名 |
| 密码（若设了 `WEB2EXE_UPDATER_PASSWORD`） | 私钥是加密的，只有文件和只有密码都签不出东西 |
| `.tauri-key.pub` | 不是必需的（minisign 能从私钥重新导出，但本项目脚本没封装这一步），留着最省事 |

存法：密码管理器条目（文件用附件/保险库功能）+ 一份离线的异地副本。**不要**放在
项目目录、云盘同步文件夹、或和机器同一块磁盘上。

验证备份真的可用（不签任何发布物）：

```bash
echo test > .sig-check
# 注意参数名：sign 子命令里 -f 才是私钥文件、-p 是密码（generate 的 -p 是密码、-w 是文件）
node node_modules/@tauri-apps/cli/tauri.js signer sign .sig-check \
  -f .tauri-key -p "$WEB2EXE_UPDATER_PASSWORD"
rm .sig-check .sig-check.sig
```

签得动就说明"文件 + 密码"这一对是完整的。

### 多机 / 交接

同一对密钥在多台机器上用 = 把**文件 + 密码**两样都送过去，缺一样都签不出更新。
交接渠道走密码管理器的共享条目或一次性加密通道，不要走 IM、邮件、共享网盘链接
—— 那些地方留下的副本比你的机器活得久。

### 泄露了怎么办

先把结论说清楚：**已经装出去的客户端内置的是旧公钥，你没有任何远程手段能让它接受新公钥。**
`pubkey` 是编译进二进制常量的，所以泄露后的处置全是"止损 + 人工铺路"：

1. **立刻停止发布**新更新（别再签任何包），也别撤下线上 `update.json` ——
   撤了只是让检查失败，不解决信任问题。
2. 生成新密钥对，把新公钥写进 `tauri.conf.json`，重新打包发版。
   老客户端会**拒绝**这个新包（验签不过），因此它们停在旧版本，安全但不再前进。
3. 想让老用户接上新链条，只有一次人工动作：把新版本通过官网/内部分发/商店
   让用户**手动装一次**。装完之后内置的是新公钥，自动更新恢复正常。
4. 想避免"必须等人手动装"，唯一的预防手段是提前埋版本下限：
   前端启动时比对版本，低于某个值就挡住主界面并提示去官网重装
   （updater 本身没有强制更新的概念，见下一节）。

### 换密钥不是免费操作

轮换（定期换、员工离职后换、怀疑泄露）的代价就是上面第 3 步：**每一次换钥
都要靠一轮人工重装来铺路**。所以真正的建议是"一开始就把私钥管好"——
设密码、单独备份、别进任何仓库或 CI 日志——而不是指望将来能无痛轮换。

### 2. 填公钥与地址

`src-tauri/tauri.conf.json`：

```json
"plugins": {
  "updater": {
    "pubkey": "把 .tauri-key.pub 的内容整段粘进来",
    "endpoints": ["https://your-host.example.com/app/update.json"],
    "windows": { "installMode": "passive" }
  }
}
```

`installMode` 用 `passive`：更新时显示进度条但不要求用户点确认，
装完自动重启 —— 否则用户关了窗口，更新就半途而废了。

### 3. 打开打包时的签名产物

```json
"bundle": { "createUpdaterArtifacts": true }
```

模板默认开启。**暂时不需要自动更新**时改成 `false`，这样不必生成密钥也能打包。

## 每次发版

```bash
# 1. 改高版本号（唯一来源，改这一处）
#    src-tauri/tauri.conf.json 的 version

# 2. 打包（会产出 setup.exe + .sig）
node scripts/pack.mjs

# 3. 生成清单（脚本按版本号挑包，版本对不上会直接报错而不是静默用旧包）
node scripts/gen-update-json.mjs 0.2.0 https://your-host.example.com/app

# 4. 三个文件传到同一个目录
#    *-setup.exe   *.exe.sig   update.json
```

`update.json` 长这样：

```json
{
  "version": "0.2.0",
  "notes": "Web2Exe 应用 v0.2.0",
  "pub_date": "2026-09-21T02:30:00.000Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "url": "https://your-host.example.com/app/xxx-setup.exe"
    }
  }
}
```

`signature` 就是 `.sig` 文件的全部内容（脚本自动读进去）。

## 前端怎么调

模板里已经写好：`src/updater.ts`

```ts
const result = await checkForUpdates();
// { kind: "latest" }                      已经是最新
// { kind: "updated", version: "0.2.0" }   已更新并重启
// { kind: "not-tauri" }                   浏览器环境，跳过
// { kind: "error", message }              失败，原样带回错误信息
```

两个容易踩的点：

**1. 浏览器里必须能安全调用。** 模板先判定 `__TAURI_INTERNALS__` 是否存在，
再用**动态** `import()` 拉插件 —— 静态 import 在浏览器里会在模块加载阶段就炸，
整页白屏。

**2. Rust 侧要注册插件**，否则前端调 `check()` 得到的是
`command not found`，而不是任何有用的提示：

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())        // 重启要用
```

`capabilities/default.json` 里也要放行 `updater:default` 与 `process:default`。
Tauri 2 默认不给前端任何系统能力，漏了就是静默失败。

## 几个具体问题

**没有服务器能行吗？**
能。`endpoints` 指向的对象存储、CDN、GitHub Releases 的直链都可以，
只要返回一个静态 JSON 文件（注意 CORS 和 HTTPS）。

**能灰度吗？**
可以，`endpoints` 是数组，会依次尝试。要按用户分流就得自己起一个接口返回不同的清单。

**强制更新怎么做？**
updater 本身没有"必须更新"的概念。做法是在前端启动时检查版本，
低于最低要求就挡住主界面（但要留一个"仍然进入"的口子，否则用户在网络异常时会被锁在外面）。

**只更新不重启？**
`installMode: "passive"` 会重启。如果希望用户自己决定何时重启，
改成调用 `download()` + `install()` 而不是 `downloadAndInstall()`。
