#!/usr/bin/env node
/**
 * launchers.mjs —— 其余 .bat 的真正实现
 *
 * 和 scripts/pack.mjs 同样的理由：**.bat 必须是纯 ASCII**。
 * cmd.exe 按字节偏移定位批处理文件里的行，多字节字符会让偏移逐渐错位，
 * 把中文 echo 行切成「不是内部或外部命令」的乱码。
 * 完整实测数据见 pack.mjs 顶部注释。
 *
 * 所以每个 .bat 只是一个纯 ASCII 的薄启动器，中文提示一律由这里打印。
 *
 * 用法（各 .bat 里调用）：
 *   node scripts/launchers.mjs dev            # 启动开发版（浏览器）
 *   node scripts/launchers.mjs desktop        # 启动桌面版
 *   node scripts/launchers.mjs install-rust   # 安装 Rust
 *   node scripts/launchers.mjs guide-mingw    # MinGW 安装指引
 *   node scripts/launchers.mjs guide-msvc     # C++ 生成工具安装指引
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PRODUCT, ROOT } from './project.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLI = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const TMP = path.join(ROOT, '.setup-tmp');

const say = (...a) => console.log(...a);
const hr = () => say('  ' + '='.repeat(52));
const setTitle = (t) => process.stdout.write(`\x1b]0;${t}\x07`);

function die(lines) {
  say('');
  for (const l of lines) say('  ' + l);
  say('');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      ...opts,
    });
    p.stdout.on('data', (d) => process.stdout.write(d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('error', (e) => resolve(-1));
    p.on('close', (code) => resolve(code));
  });
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

/** 取工具链路径（cargo + MinGW），用于桌面构建 */
async function toolchainEnv() {
  const p = spawn(process.execPath, [path.join(__dirname, 'toolchain-path.mjs')], {
    cwd: ROOT,
    windowsHide: true,
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  await new Promise((r) => p.on('close', r));
  const extra = out.trim();
  return { ...process.env, PATH: [extra, process.env.PATH].filter(Boolean).join(';') };
}

/* ======================================================================== */
/* dev —— 浏览器开发模式                                                     */
/* ======================================================================== */

async function cmdDev() {
  setTitle(`${PRODUCT} - 开发模式`);
  say('');
  hr();
  say(`    ${PRODUCT} · 开发模式启动`);
  hr();
  say('');
  say('  正在启动，浏览器稍后会自动打开...');
  say('  关闭这个黑窗口即可停止应用。');
  say('');

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    say('  首次运行，正在安装依赖，请稍等...');
    say('');
    const code = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install']);
    if (code !== 0) die(['[错误] 依赖安装失败，请检查网络。']);
    say('');
  }

  if (!fs.existsSync(VITE)) die([`[错误] 找不到 ${VITE}`, '请先运行 npm install。']);

  const url = 'http://localhost:1420';
  setTimeout(() => {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }, 2500);

  await run(process.execPath, [VITE]);
}

/* ======================================================================== */
/* desktop —— Tauri 桌面窗口                                                 */
/* ======================================================================== */

async function cmdDesktop() {
  setTitle(`${PRODUCT} - 桌面版`);
  say('');
  hr();
  say(`    ${PRODUCT} · 桌面应用模式`);
  hr();
  say('');

  const env = await toolchainEnv();

  if (!fs.existsSync(path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe'))) {
    die([
      '[缺少 Rust 工具链]',
      '',
      '桌面模式需要 Rust 才能编译。请双击运行：',
      '  安装Rust环境.bat',
      '',
      '装好后重新运行本脚本即可 —— PATH 会由脚本自动补齐，不用重开窗口。',
    ]);
  }

  // 工具链判定：配了 GNU 就用 GNU
  let toolchain = 'msvc';
  const cargoCfg = path.join(ROOT, 'src-tauri', '.cargo', 'config.toml');
  if (fs.existsSync(cargoCfg) && fs.readFileSync(cargoCfg, 'utf8').includes('x86_64-pc-windows-gnu')) {
    toolchain = 'gnu';
  }

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    say('  首次运行，正在安装依赖...');
    const code = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { env });
    if (code !== 0) die(['[错误] 依赖安装失败。']);
  }

  if (!fs.existsSync(path.join(ROOT, 'src-tauri', 'icons', 'icon.ico'))) {
    say('  正在生成应用图标...');
    await run(process.execPath, [path.join(__dirname, 'gen-icons.mjs')], { env });
  }

  // 既没配 GNU、也没有 MSVC 链接器时，先自动探测一次 MinGW（setup-gnu 是幂等的），
  // 补不上再给人话提示 —— 不要让人对着链接器的报错猜。
  if (toolchain === 'msvc') {
    const p = spawn('where', ['link'], { windowsHide: true });
    const code = await new Promise((r) => p.on('close', r));
    if (code !== 0) {
      say('');
      say('  既没有 MSVC 链接器，也没生成 GNU 配置 —— 先探测一次 MinGW ...');
      await run(process.execPath, [path.join(__dirname, 'setup-gnu.mjs')], { env });

      const okGnu =
        fs.existsSync(cargoCfg) &&
        fs.readFileSync(cargoCfg, 'utf8').includes('x86_64-pc-windows-gnu');

      if (okGnu) {
        toolchain = 'gnu';
      } else {
        die([
          '[缺少链接器]',
          '',
          '编译需要 C++ 链接器，当前既没有 MSVC 也没配置 GNU。两条路任选一条：',
          '',
          '  A. 装 GNU 工具链（推荐，约 100 MB）',
          '     点「安装MinGW环境.bat」看步骤，装完运行 npm run setup:gnu',
          '',
          '  B. 装 MSVC C++ 生成工具（约 2-4 GB）',
          '     点「安装C++生成工具.bat」，需要管理员权限',
        ]);
      }
    }
  }

  say(`  工具链：${toolchain}`);
  say('');
  say('  正在编译并启动桌面窗口...');
  say('  首次编译需要几分钟，之后会快很多。');
  say('  关闭窗口即可退出应用。');
  say('');

  if (!fs.existsSync(CLI)) die(['[错误] 找不到 Tauri CLI。', '请先运行 npm install。']);
  await run(process.execPath, [CLI, 'dev'], { env });
}

/* ======================================================================== */
/* install-rust —— 安装 Rust 工具链                                          */
/* ======================================================================== */

async function cmdInstallRust() {
  setTitle('安装 Rust 工具链');
  say('');
  hr();
  say('    Rust 工具链安装');
  hr();
  say('');
  say('  这一步需要你亲自运行，因为安装程序要写入系统环境变量，');
  say('  脚本无法代你授权。');
  say('');
  say('  安装内容：');
  say(`    - Rust 编译器 (cargo / rustc)`);
  say('    - 位置：%USERPROFILE%\\.cargo  和  %USERPROFILE%\\.rustup');
  say('    - 体积：约 400 MB');
  say('');
  say('  ----------------------------------------------------');
  say('  请选择工具链：');
  say('  ----------------------------------------------------');
  say('');
  say('    [1] GNU 工具链  (推荐)');
  say('        不需要 C++ 生成工具，省去 2-4 GB 下载');
  say('        需要先装好 MSYS2（见「安装MinGW环境.bat」）');
  say('');
  say('    [2] MSVC 工具链');
  say('        官方推荐路线，兼容性最好');
  say('        需要先装 Visual Studio C++ 生成工具（2-4 GB）');
  say('');

  let choice = await ask('  请输入 1 或 2（直接回车选 1）: ');
  if (!choice) choice = '1';
  if (choice !== '1' && choice !== '2') {
    die(['[错误] 输入无效，请输入 1 或 2。']);
  }

  const target = choice === '1' ? 'x86_64-pc-windows-gnu' : 'x86_64-pc-windows-msvc';
  const official = `https://static.rust-lang.org/rustup/dist/${target}/rustup-init.exe`;
  const mirror = `https://mirrors.tuna.tsinghua.edu.cn/rustup/dist/${target}/rustup-init.exe`;

  say('');
  say(`  已选择：${choice === '1' ? 'GNU' : 'MSVC'} 工具链`);
  say('');
  await ask('  按回车开始安装...');

  fs.mkdirSync(TMP, { recursive: true });
  const exe = path.join(TMP, 'rustup-init.exe');

  if (!fs.existsSync(exe)) {
    say('');
    say('  正在下载安装程序...');
    say('');
    for (const [label, url] of [
      ['清华镜像', mirror],
      ['官方源', official],
    ]) {
      say(`  尝试 ${label}...`);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100000) throw new Error(`文件太小（${buf.length} 字节），可能不是安装程序`);
        fs.writeFileSync(exe, buf);
        say(`  下载完成（${(buf.length / 1024 / 1024).toFixed(1)} MB）。`);
        break;
      } catch (e) {
        say(`  失败：${e.message}`);
      }
    }
    if (!fs.existsSync(exe)) {
      die([
        '下载失败',
        '',
        '请手动下载后放到本目录下的 .setup-tmp\\ 里，再运行一次本脚本：',
        `  ${official}`,
        '',
        '文件名必须保持 rustup-init.exe',
      ]);
    }
  }

  say('');
  say('  开始安装（下载工具链约 3-8 分钟，请勿关闭窗口）...');
  say('');

  // 让 rustup 走清华镜像拉工具链 —— 国内直连官方源经常卡死
  const env = {
    ...process.env,
    RUSTUP_DIST_SERVER: 'https://mirrors.tuna.tsinghua.edu.cn/rustup',
    RUSTUP_UPDATE_ROOT: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup',
  };
  say(`  镜像源：${env.RUSTUP_DIST_SERVER}`);
  say('');

  const code = await run(
    exe,
    ['-y', '--default-toolchain', 'stable', '--profile', 'minimal', '--default-host', target],
    { env, stdio: ['inherit', 'inherit', 'inherit'] },
  );

  if (code !== 0) {
    die([
      '安装未成功',
      '',
      '常见原因与对策：',
      '',
      '1. 提示缺少 MSVC / Visual Studio 生成工具',
      '   说明你选了 MSVC 路线。两个选择：',
      '     - 改选 GNU 路线（需要先装 MSYS2）',
      '     - 或安装 Visual Studio 2022 生成工具并勾选',
      '       「使用 C++ 的桌面开发」',
      '',
      '2. 下载中途卡住或超时',
      '   镜像源可能暂时不可用。可在 PowerShell 里执行：',
      '     $env:RUSTUP_DIST_SERVER="https://mirrors.ustc.edu.cn/rust-static"',
      '     $env:RUSTUP_UPDATE_ROOT="https://mirrors.ustc.edu.cn/rust-static/rustup"',
      '   再运行 .setup-tmp\\rustup-init.exe',
    ]);
  }

  // GNU 路线：补装目标（元数据很小，顺便也做掉）
  if (choice === '1') {
    say('');
    say('  正在确认 GNU 目标...');
    const rustup = path.join(os.homedir(), '.cargo', 'bin', 'rustup.exe');
    if (fs.existsSync(rustup)) {
      await run(rustup, ['target', 'add', 'x86_64-pc-windows-gnu'], { env });
    }
  }

  say('');
  hr();
  say('  安装成功');
  hr();
  say('');
  say('  下一步可以直接运行「启动桌面版.bat」或「打包桌面版.bat」——');
  say('  PATH 会由脚本自动补齐，不需要重开窗口。');
  say('');
  if (choice === '1') {
    say('  若还没装 MSYS2：');
    say('    1. 双击「安装MinGW环境.bat」，按里面的指引装好');
    say('    2. 回到本目录运行：npm run setup:gnu');
    say('');
  }

  try {
    fs.unlinkSync(exe);
  } catch {
    /* 删不掉不影响结果 */
  }
}

/* ======================================================================== */
/* guide-mingw / guide-msvc —— 安装指引                                      */
/* ======================================================================== */

async function cmdGuideMingw() {
  setTitle('安装 MinGW 环境');
  say('');
  hr();
  say('    MinGW-w64 安装指引（GNU 工具链路线）');
  hr();
  say('');
  say('  为什么需要它：');
  say('    走 GNU 路线时，Rust 需要一个链接器把编译结果拼成 .exe。');
  say('    MSYS2 自带的 MinGW-w64 提供这个链接器，体积约 100 MB，');
  say('    比 Visual Studio 生成工具的 2-4 GB 小得多。');
  say('');
  say('  注意：这个环节需要你手动操作，脚本无法代劳 ——');
  say('        MSYS2 安装程序要写入系统目录并请求管理员权限。');
  say('');
  say('  ----------------------------------------------------');
  say('  第 1 步：下载 MSYS2');
  say('  ----------------------------------------------------');
  say('');
  say('    推荐用清华镜像，速度稳定：');
  say('    https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/x86_64/');
  say('');
  say('    在页面里找 msys2-x86_64-<日期>.exe 的最新版，下载后双击安装。');
  say('    安装路径建议保持默认的 C:\\msys64');
  say('');
  say('  ----------------------------------------------------');
  say('  第 2 步：安装编译器');
  say('  ----------------------------------------------------');
  say('');
  say('    装好后从开始菜单打开「MSYS2 MINGW64」终端（注意不要选错）；');
  say('    在里面执行：');
  say('');
  say('      pacman -S mingw-w64-x86_64-gcc');
  say('');
  say('    中途会问是否继续，输入 y 回车。');
  say('');
  say('  ----------------------------------------------------');
  say('  第 3 步：让本项目的脚本找到它');
  say('  ----------------------------------------------------');
  say('');
  say('    回到本目录运行  npm run setup:gnu');
  say('    它会自动探测 MinGW 位置并生成 Cargo 配置，');
  say('    看到「配置已写入」就成功了。');
  say('');

  const go = await ask('  现在运行 setup:gnu 试试吗？(y/N): ');
  say('');
  if (go.toLowerCase() === 'y') {
    await run(process.execPath, [path.join(__dirname, 'setup-gnu.mjs')]);
  } else {
    say('  已跳过。随时可以手动运行：npm run setup:gnu');
  }
  say('');
  say('  完成后可以双击「打包桌面版.bat」开始打包。');
  say('');
}

async function cmdGuideMsvc() {
  setTitle('安装 C++ 生成工具');
  say('');
  hr();
  say('    Visual Studio C++ 生成工具 - 打包桌面版必需');
  hr();
  say('');
  say('  为什么需要它：');
  say('    Rust 编译出的程序需要 Windows 官方的 C++ 链接器才能生成 .exe。');
  say('    这个工具包是微软官方提供的精简版（只含编译器，不含 IDE）。');
  say('');
  say('  需要你亲自运行的原因：');
  say('    安装程序会请求管理员权限并写入系统目录，脚本无法代你授权。');
  say('');
  say('  安装内容：');
  say('    - MSVC v143 编译器与链接器');
  say('    - Windows 11 SDK');
  say('    - 体积：约 2-4 GB，预计 10-20 分钟');
  say('');
  say('  提示：如果只是想把项目跑起来，走 GNU 路线只要约 100 MB，');
  say('        见「安装MinGW环境.bat」。');
  say('');

  const go = await ask('  按回车开始安装，或输入 N 退出: ');
  if (go.toLowerCase() === 'n') return;

  const hasWinget = await new Promise((r) => {
    const p = spawn('where', ['winget'], { windowsHide: true });
    p.on('close', (c) => r(c === 0));
    p.on('error', () => r(false));
  });

  if (!hasWinget) {
    die([
      '[错误] 没找到 winget，无法自动安装。',
      '',
      '请手动操作：',
      '  1. 打开 https://visualstudio.microsoft.com/downloads/',
      '  2. 找到「Visual Studio 2022 生成工具」并下载',
      '  3. 安装时勾选「使用 C++ 的桌面开发」',
    ]);
  }

  say('');
  say('  正在安装（会弹出 UAC 授权窗口，请点「是」）...');
  say('  进度较长，请耐心等待，不要关闭本窗口。');
  say('');

  const code = await run(
    'winget',
    [
      'install',
      'Microsoft.VisualStudio.2022.BuildTools',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--override',
      '--quiet --wait --norestart --nocache ' +
        '--add Microsoft.VisualStudio.Workload.VCTools ' +
        '--add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 ' +
        '--add Microsoft.VisualStudio.Component.Windows11SDK.22621 ' +
        '--includeRecommended',
    ],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );

  if (code !== 0) {
    die([
      '安装未完成',
      '',
      '如果提示需要管理员权限，请右键本脚本选择「以管理员身份运行」。',
    ]);
  }

  say('');
  hr();
  say('  安装成功');
  hr();
  say('');
  say('  请关闭本窗口，重新打开「打包桌面版.bat」继续。');
  say('');
}

/* ======================================================================== */

const COMMANDS = {
  dev: cmdDev,
  desktop: cmdDesktop,
  'install-rust': cmdInstallRust,
  'guide-mingw': cmdGuideMingw,
  'guide-msvc': cmdGuideMsvc,
};

const name = process.argv[2];
if (!COMMANDS[name]) {
  console.error(`未知的子命令：${name ?? '(空)'}`);
  console.error(`可用：${Object.keys(COMMANDS).join(' / ')}`);
  process.exit(1);
}

COMMANDS[name]().catch((e) => {
  console.error('[x] 未预期的错误：' + (e?.stack ?? e));
  process.exit(1);
});
