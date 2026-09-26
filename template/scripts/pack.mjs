#!/usr/bin/env node
/**
 * pack.mjs —— 「打包桌面版.bat」的真正实现
 *
 * 为什么逻辑不写在 .bat 里？
 * ------------------------------------------------------------------
 * cmd.exe 的批处理解析器**无法可靠处理含大量多字节字符的 .bat 文件**。
 * 它按字节偏移重新定位文件，多字节字符会让偏移逐渐错位，
 * 最终把某一行切在半个字符中间 —— 于是 `echo 中文` 被拆成
 * 「不是内部或外部命令」的乱码。
 *
 * 实测（同一份内容，CMD /D /C 直接跑）：
 *   纯 ASCII + CRLF，5733 字节      -> 69/69 行正常，stderr 全空
 *   UTF-8 无 BOM + CRLF，8318 字节  -> 只有 19/69 行，大量乱码命令
 *   GBK + CRLF，5845 字节           -> 正常，但会和 Node 的 UTF-8 输出冲突
 *   UTF-8 + BOM                     -> BOM 被当成命令名
 *   用 ASCII 外层先 chcp 65001 再 call 内层 -> 仍然 19/69，无效
 *
 * 结论：**.bat 必须是纯 ASCII**，所有中文提示一律由 Node 打印
 * （Node 写的是 UTF-8 字节，配合 .bat 里那句 `chcp 65001` 就能正常显示）。
 *
 * 用法：
 *   node scripts/pack.mjs
 * 结束时不等待按键 —— 「打包桌面版.bat」自己带 pause，脚本本身不阻塞，
 * 因此在 CI / 无终端环境下可以直接跑（交互式提问会走空回答并跳过）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PRODUCT, ROOT, UPDATER_KEY_PASSWORD } from './project.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TSC = path.join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const CLI = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

// 只出安装包、不产更新签名：CI 用它（不留私钥在 runner 上），
// "先不想管密钥"的人也可以手动加 --no-sign
const NO_SIGN = process.argv.includes('--no-sign') || process.env.WEB2EXE_NO_SIGN === '1';

const line = (n = 52) => '  ' + '='.repeat(n);
const say = (...a) => console.log(...a);
const step = (n, total, title) => {
  say('');
  say(`  [${n}/${total}] ${title}...`);
  say('');
};

function die(title, details = []) {
  say('');
  say(line());
  say(`  ${title}`);
  say(line());
  for (const d of details) say('  ' + d);
  say('');
  process.exit(1);
}

/** 跑一条命令，输出实时转发到当前终端，同时收集文本 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      ...opts,
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    p.stderr.on('data', (d) => {
      out += d.toString();
      process.stderr.write(d);
    });
    p.on('error', (e) => resolve({ code: -1, out: out + '\n' + e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** 读一行输入（没有 TTY 时直接返回空串，避免卡住） */
function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const TOTAL = 5;

  // 控制台窗口标题由 Node 设置 —— .bat 里不能写中文，所以 title 命令也搬过来了。
  // OSC 序列：ESC ] 0 ; <标题> BEL
  process.stdout.write(`\x1b]0;${PRODUCT} - 打包\x07`);

  say('');
  say(line());
  say(`    ${PRODUCT} · 打包成 Windows 安装包`);
  say(line());

  /* ---------------- [1/5] 环境自检 ---------------- */
  step(1, TOTAL, '检查构建环境');
  const envCheck = path.join(__dirname, 'env-check.mjs');
  const env = await run(process.execPath, [envCheck]);
  if (env.code !== 0) {
    die('环境检查未通过，请按上方提示补齐依赖后再试。');
  }

  /* ---------------- [2/5] 项目文件 ---------------- */
  step(2, TOTAL, '检查项目文件');

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    say('  首次运行，正在安装前端依赖...');
    const r = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install']);
    if (r.code !== 0) die('依赖安装失败。', ['请检查网络后重试。']);
  }

  if (!fs.existsSync(path.join(ROOT, 'src-tauri', 'icons', 'icon.ico'))) {
    say('  缺少应用图标，正在生成...');
    const r = await run(process.execPath, [path.join(__dirname, 'gen-icons.mjs')]);
    if (r.code !== 0) die('图标生成失败。');
  }

  // GNU 工具链配置：src-tauri/.cargo/config.toml
  //
  // 这个文件由 setup-gnu.mjs 生成，内容是**本机 MinGW 的绝对路径**，
  // 所以模板仓库里没有它（有了反而会把别人的路径带给你）。
  // 但缺了它会同时坏掉两件事：
  //   1. 编译目标退化成 rustup 的默认 toolchain。默认若是 msvc，
  //      得先白编译十几分钟，才会在链接阶段报 could not open 'kernel32.lib'；
  //   2. -Wl,-exclude-all-symbols 不生效，可能撞上 export ordinal too large。
  // 与其让人等十几分钟再看不懂的报错，不如在这里补上。
  //
  // 想走 MSVC 路线（需要管理员权限）就设 WEB2EXE_NO_GNU=1 跳过这段。
  const cargoCfg = path.join(ROOT, 'src-tauri', '.cargo', 'config.toml');
  const hasGnuCfg =
    fs.existsSync(cargoCfg) &&
    fs.readFileSync(cargoCfg, 'utf8').includes('x86_64-pc-windows-gnu');

  if (hasGnuCfg) {
    say('  GNU 工具链配置：[OK] src-tauri\\.cargo\\config.toml');
  } else if (process.env.WEB2EXE_NO_GNU) {
    say('  [跳过] 未配置 GNU 工具链（WEB2EXE_NO_GNU=1，按 MSVC 路线处理）');
  } else {
    say('  未配置 GNU 工具链，正在生成 src-tauri\\.cargo\\config.toml ...');
    const r = await run(process.execPath, [path.join(__dirname, 'setup-gnu.mjs')]);
    if (r.code !== 0 || !fs.existsSync(cargoCfg)) {
      die('GNU 工具链未就绪', [
        '这一步需要 MinGW-w64 —— 不用 Visual Studio 就靠它。',
        '',
        '  1. 双击「安装MinGW环境.bat」，按提示下载 MSYS2 并安装 gcc',
        '  2. 装完重新运行本脚本（也可以手动执行 node scripts/setup-gnu.mjs）',
        '',
        '若你本来就想走 MSVC 路线（需要管理员权限、约 2-4 GB），',
        '请先装好 Visual Studio「使用 C++ 的桌面开发」，然后设 WEB2EXE_NO_GNU=1 再打包。',
      ]);
    }
  }

  // ---- 更新签名：私钥 + 公钥，两样都要对 ----
  //
  // Tauri updater 是强制签名的，没有私钥就产不出可更新的包。
  // 而且**公私钥必须是一对**：tauri.conf.json 里的 pubkey 如果还是模板占位符，
  // 打包会在全部编译完成之后（这里是 42 分钟）才报
  //   failed to decode pubkey: Invalid symbol 95, offset 7
  // —— 那个 95 就是占位符 REPLACE_WITH_YOUR_TAURI_PUBKEY 里第 7 个字符的下划线。
  // 所以这两件事都要在编译之前查完。
  const keyPath = path.join(ROOT, '.tauri-key');
  const pubPath = path.join(ROOT, '.tauri-key.pub');
  const confPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
  const PUBKEY_PLACEHOLDER = 'REPLACE_WITH_YOUR_TAURI_PUBKEY';

  let confText = fs.readFileSync(confPath, 'utf8');
  const pubkeyInConf = (confText.match(/"pubkey"\s*:\s*"([^"]*)"/) ?? [, ''])[1];
  const pubkeyIsPlaceholder =
    pubkeyInConf === '' || pubkeyInConf === PUBKEY_PLACEHOLDER;

  // (1) 私钥不存在
  if (!NO_SIGN && !fs.existsSync(keyPath)) {
    if (!pubkeyIsPlaceholder) {
      die('缺少更新签名私钥 .tauri-key，但 tauri.conf.json 里的公钥不是占位符', [
        '这说明这对密钥曾经是配好的 —— 私钥不见了。',
        '',
        '先在备份里找一下 .tauri-key。',
        '确实找不回来的话：私钥一旦丢失，就再也无法给**已经安装过的用户**推送更新，',
        '只能让他们手动重装一次。要继续开发可以重新生成一对，',
        `方法是先把 tauri.conf.json 里的 pubkey 改回 ${PUBKEY_PLACEHOLDER}，再重新打包。`,
      ]);
    }

    if (!process.stdin.isTTY) {
      die('缺少更新签名私钥 .tauri-key', [
        '这个密钥用于给更新包签名（Tauri updater 强制要求）。第一次使用要先生成一对：',
        '',
        '  node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key',
        '',
        '会询问密码。直接回车是空密码 —— 私钥不加密、等同明文；',
        '要加密就先设 WEB2EXE_UPDATER_PASSWORD，生成与每次打包用同一个值',
        '（打包脚本会自动读它，不需要交互输入）。风险见 docs/04 的「私钥安全」。',
        '',
        '若只想产出安装包、暂时不需要自动更新：把 tauri.conf.json 里的',
        'bundle.createUpdaterArtifacts 改成 false 再打包。',
      ]);
    }

    // 全新项目（公钥还是占位符）→ 问一句就替他生成，省掉一次手工操作
    const a = await ask('  还没有更新签名私钥，现在生成一对吗？(Y/n): ');
    if (/^n(o)?$/i.test(a)) {
      die('已跳过生成签名密钥', [
        '没有私钥就产不出可更新的安装包。想手动生成：',
        '',
        '  node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key',
        '',
        '（会询问密码；想加密保存就设 WEB2EXE_UPDATER_PASSWORD 后重新打包，',
        '  不设就是空密码 —— 私钥落盘等同明文，见 docs/04 的「私钥安全」）',
      ]);
    }

    say('  正在生成签名密钥...');
    const pw = UPDATER_KEY_PASSWORD;
    if (!pw) {
      say('  [!] 密码为空 —— 私钥落盘等同明文。任何能读到 .tauri-key 的人都能签出');
      say('      一份会被所有已安装客户端自动装上的更新。');
      say('      要加密保存：set WEB2EXE_UPDATER_PASSWORD=你的密码 后重新打包，');
      say('      之后每次打包/签名保持同一个值即可（脚本会自动读，不需要交互输入）。');
    }
    const gen = await run(process.execPath, [
      CLI,
      'signer',
      'generate',
      '-w', '.tauri-key',
      '-p', pw,
      '--ci',
    ]);
    if (gen.code !== 0 || !fs.existsSync(keyPath)) {
      die('签名密钥生成失败。', ['上方是 tauri signer 的输出。']);
    }
    say('  [OK] 已生成 .tauri-key（私钥，务必单独备份）+ .tauri-key.pub（公钥）');
  }

  // (2) 公钥还是占位符 → 用本地公钥自动填上
  //     只替换占位符/空串，不动使用者自己填过的值。
  if (NO_SIGN) {
    // 不签名时占位公钥不用管：createUpdaterArtifacts=false，产物里根本没有 .sig
    say('  [跳过] 签名密钥与公钥回填（--no-sign）');
  } else if (pubkeyIsPlaceholder) {
    if (!fs.existsSync(pubPath)) {
      die('tauri.conf.json 的 pubkey 还是占位符，且找不到 .tauri-key.pub', [
        '公钥在生成密钥时打印过一次；若那份也没留下，只能重新生成一对',
        '（此时已安装的旧版本将无法自动更新，需要手动重装）。',
      ]);
    }
    const pub = fs.readFileSync(pubPath, 'utf8').trim();
    if (!pub) die('.tauri-key.pub 是空文件。');

    const next = confText.replace(/"pubkey"\s*:\s*"[^"]*"/, `"pubkey": ${JSON.stringify(pub)}`);
    if (next === confText) {
      die('没能在 tauri.conf.json 里找到 plugins.updater.pubkey 字段。');
    }
    fs.writeFileSync(confPath, next, 'utf8');
    say('  [OK] 已把 .tauri-key.pub 写入 tauri.conf.json 的 plugins.updater.pubkey');
  } else {
    say('  签名密钥：[OK] 私钥与公钥均已配置');
  }

  // 版本号统一从 tauri.conf.json 读，避免多处维护导致不一致
  let version = '';
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ).version;
  } catch {
    /* 下面统一报错 */
  }
  if (!version) {
    die('无法从 src-tauri/tauri.conf.json 读取版本号。');
  }
  say(`  版本号：${version}`);

  /* ---------------- [3/5] 前端构建 ---------------- */
  step(3, TOTAL, '构建前端');
  for (const [label, script, extra] of [
    ['类型检查', TSC, ['-b', '--pretty', 'false']],
    ['打包前端资源', VITE, ['build']],
  ]) {
    if (!fs.existsSync(script)) {
      die(`找不到 ${script}`, ['请先运行 npm install。']);
    }
    const r = await run(process.execPath, [script, ...extra]);
    if (r.code !== 0) die(`${label}失败，请查看上方信息。`);
  }

  /* ---------------- [4/5] 编译并打包 ---------------- */
  step(4, TOTAL, '编译并打包（首次约 5-15 分钟，下面是实时输出）');

  // build-desktop.mjs 内部会：补 PATH、同步 WebView2Loader.dll、
  // 用正确的方式设置签名密码、并把 Tauri 的 beforeBuildCommand 置空
  // （前端刚在第 3 步构建过，不必再构建一遍）。
  const build = await run(process.execPath, [
    path.join(__dirname, 'build-desktop.mjs'),
    ...(NO_SIGN ? ['--no-sign'] : []),
  ]);
  if (build.code !== 0) {
    die('打包失败', [
      '',
      '若报错包含 "export ordinal too large" / "too many exported symbols"：',
      '  这是 PE 导出表序号超过 65535 —— 只有产物里**真有导出表**时才会发生，',
      '  也就是 cdylib/DLL 形态（或很老的 binutils + windows crate 组合）。',
      '  本模板是 bin 型应用，产出的 exe 没有导出表，正常撞不到（docs/05 第 2 节）。',
      '  先确认 src-tauri\\.cargo\\config.toml 还在（它写着 -Wl,-exclude-all-symbols）：',
      '    npm run setup:gnu',
      '  还在就去看 Cargo.toml 的 crate-type 是不是被改成了 ["cdylib", ...]。',
      '',
      '若报错包含 "could not open \'kernel32.lib\'"：',
      '  这是走了 MSVC 路线但缺少 Windows SDK，建议改用 GNU 路线。',
      '',
      '若报错是下载超时（Connection Failed / os error 10060）：',
      '  NSIS 打包器首次使用需要下载，请配置网络代理后重试。',
      '',
      '若报错包含 "failed to decode pubkey"：',
      '  tauri.conf.json 里 plugins.updater.pubkey 不是有效的公钥（多半还是占位符）。',
      '  正常情况第 [2/5] 步已经自动填好了；手动改过的话，把它改回占位符再打一次。',
      '',
      '若报错提到 password / decryption / could not decrypt：',
      '  .tauri-key 是带密码生成的，而本次打包没给出同一个密码。',
      '  设 WEB2EXE_UPDATER_PASSWORD=生成时的密码 再打包（别写进仓库或 CI 日志）。',
    ]);
  }

  /* ---------------- [5/5] 生成更新清单 ---------------- */
  step(5, TOTAL, '生成更新清单');

  if (NO_SIGN) {
    say('  [跳过] 本次没有 .sig 签名产物（--no-sign），因此不生成 update.json。');
    say('  以后要上自动更新：生成私钥后去掉 WEB2EXE_NO_SIGN 重打一次。');
  } else {
    say('  请填入安装包的线上地址前缀');
    say('  （应用会从这里下载更新，必须是 HTTPS）');
    say('');
    const baseUrl = await ask('  地址前缀: ');

    if (!baseUrl) {
      say('');
      say('  未填地址，跳过生成 update.json。');
      say('  稍后可以手动运行：');
      say(`    node scripts/gen-update-json.mjs ${version} https://你的地址/目录`);
    } else {
      const r = await run(process.execPath, [
        path.join(__dirname, 'gen-update-json.mjs'),
        version,
        baseUrl,
      ]);
      if (r.code !== 0) {
        say('');
        say('  [警告] update.json 生成失败，安装包本身已经打好了。');
      }
    }
  }

  /* ---------------- 完成 ---------------- */
  say('');
  say(line());
  say('  打包完成');
  say(line());
  say('');
  say('  产物位置（由脚本自动探测 —— GNU 工具链下路径含 target triple，');
  say('  不是简单的 target\\release）：');
  say('');
  await run(process.execPath, [path.join(__dirname, 'build-status.mjs')]);
  say('');
  say('  产物说明：');
  say('    *-setup.exe        安装包，双击即可安装');
  say('    *-setup.exe.sig    更新签名，必须跟安装包一起上传');
  say('    update.json        更新清单，放在线上目录供应用查询');
  say('');
  say('  分发步骤：');
  say('    1. 把安装包、.sig 签名、update.json 传到同一个线上目录');
  say('    2. 该目录地址要与 src-tauri\\tauri.conf.json 里');
  say('       plugins.updater.endpoints 的配置一致');
  say('    3. 发布新版本时，改高 tauri.conf.json 的 version 再打一次包');
  say('');
}

main().catch((e) => {
  console.error('');
  console.error('  [x] 未预期的错误：' + (e?.stack ?? e));
  process.exit(1);
});
