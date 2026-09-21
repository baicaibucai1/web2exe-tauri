import { useState } from "react";
import { checkForUpdates, isTauri, type UpdateResult } from "./updater";

/*
 * 这是模板的占位页面 —— 换成你自己的界面即可。
 *
 * 它存在的意义只有两个：
 *   1. 打包后能立刻看出"前端确实跑起来了"（而不是白屏，让人以为是打包坏了）
 *   2. 把「自动更新」这条链路做成可点的一步，省得回头再摸一遍
 */
export default function App() {
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inDesktop = isTauri();

  async function onCheck() {
    setBusy(true);
    setResult(await checkForUpdates());
    setBusy(false);
  }

  return (
    <main className="page">
      <header className="hero">
        <div className="mark" aria-hidden="true" />
        <div>
          <h1>你的 Web 应用在这里</h1>
          <p className="sub">
            这是模板自带的占位页面。把 <code>src/</code> 换成你的前端，
            或者把 <code>src-tauri/tauri.conf.json</code> 里的
            <code>build.frontendDist</code> 指向你自己的构建产物目录。
          </p>
        </div>
      </header>

      <section className="card">
        <h2>运行环境</h2>
        <p className="row">
          <span className={inDesktop ? "pill on" : "pill off"}>
            {inDesktop ? "桌面外壳内" : "浏览器内"}
          </span>
          <span className="hint">
            {inDesktop
              ? "当前是 Tauri 窗口，能调系统能力（自动更新、文件、通知）。"
              : "当前是浏览器开发模式，系统能力不可用 —— 这是预期行为。"}
          </span>
        </p>
      </section>

      <section className="card">
        <h2>自动更新</h2>
        <p className="hint">
          点一下调 updater 插件去拉线上 update.json。要让它真的工作，还需要
          把安装包与签名传到线上目录，并把地址填进
          <code>tauri.conf.json</code> 的 <code>plugins.updater.endpoints</code>。
        </p>
        <div className="actions">
          <button onClick={onCheck} disabled={busy}>
            {busy ? "检查中…" : "检查更新"}
          </button>
          {result && <span className={`out ${result.kind}`}>{describe(result)}</span>}
        </div>
      </section>

      <section className="card">
        <h2>接下来做什么</h2>
        <ol className="steps">
          <li>
            改 <code>src-tauri/tauri.conf.json</code>：<code>productName</code>、
            <code>identifier</code>、窗口尺寸。
          </li>
          <li>
            双击 <code>启动开发版.bat</code> 在浏览器里看效果，再双击
            <code>启动桌面版.bat</code> 在真实窗口里跑一遍。
          </li>
          <li>
            双击 <code>打包桌面版.bat</code> 产出安装包。
            首次编译 Rust 依赖约 5–15 分钟。
          </li>
        </ol>
      </section>
    </main>
  );
}

function describe(r: UpdateResult): string {
  switch (r.kind) {
    case "not-tauri":
      return "浏览器环境，跳过（正常）";
    case "latest":
      return "已经是最新版本";
    case "updated":
      return `已更新到 ${r.version}，应用即将重启`;
    case "error":
      // 没配 endpoints 时最常见的错误就是这里 —— 把原始信息原样带出来，
      // 比"检查更新失败"这种一句话有用得多
      return `失败：${r.message}`;
  }
}
