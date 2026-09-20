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

会询问密码 —— **直接回车用空密码**。打包脚本按空密码处理
（原因见 docs/05 第 4 节：非空密码必须走交互输入，而双击 `.bat` 的场景没有交互）。

生成两个文件：

| 文件 | 用途 | 处理方式 |
|---|---|---|
| `.tauri-key` | **私钥**，给更新包签名 | 绝不能提交仓库（模板 `.gitignore` 已挡住），单独备份 |
| `.tauri-key.pub` | 公钥，给应用验签 | 内容粘进 `tauri.conf.json` |

**私钥丢了会怎样**：已安装的旧版本认的是公钥，你还能用同一对密钥继续发新版；
但如果私钥丢了，就再也无法给已安装用户推送更新，只能让他们手动重装一次。

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

# 3. 生成清单
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
