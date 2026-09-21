#!/usr/bin/env node
/**
 * bat-lint.mjs —— .bat 文件的强制规范检查（CRLF / 无 BOM / 纯 ASCII）
 *
 * 三条规则，都不是洁癖，每一条都对应一个实际踩过的坑：
 *
 * 1) **必须 CRLF。** cmd.exe 按当前代码页逐行解码批处理文件，
 *    中文 Windows 默认 936(GBK)。LF 结尾的行若以多字节中文收尾，
 *    末字节会和紧随的 0x0A 凑成一个合法 GBK 字符，把换行吃掉 ——
 *    两行粘成一行，`if (...) (` 这种多行块被拆散。
 *
 * 2) **不能有 UTF-8 BOM。** cmd 会把 BOM 当成第一个命令的一部分，
 *    报 `'@echo' 不是内部或外部命令`。
 *
 * 3) **必须纯 ASCII。** 这是最重要、也最容易忽略的一条：
 *    cmd.exe 按**字节偏移**定位批处理文件里的行，多字节字符会让偏移逐渐错位，
 *    迟早有一行被切在半个字符中间。实测（同一份内容，CMD /D /C 直接跑）：
 *
 *      纯 ASCII + CRLF，5733 字节        -> 69/69 行正常，stderr 全空
 *      UTF-8 无 BOM + CRLF，8318 字节    -> 只有 19/69 行，大量乱码命令
 *      GBK + CRLF，5845 字节             -> 正常，但会和 Node 的 UTF-8 输出冲突
 *      UTF-8 带 BOM                      -> BOM 被当成命令名
 *      用 ASCII 外层先 chcp 65001 再 call -> 仍然 19/69，无效
 *
 *    小文件（几百字节）碰巧能跑，所以这个问题很容易被漏掉 ——
 *    但「碰巧能跑」不是可以依赖的性质，所以这里按硬规则检查。
 *
 *    正确做法：.bat 只做薄启动器，所有中文提示由 Node 脚本打印
 *    （Node 写 UTF-8 字节，配合 .bat 里的 `chcp 65001` 正常显示）。
 *
 * 用法：
 *   node scripts/bat-lint.mjs            # 检查全部（CI / env:check 用这个）
 *   node scripts/bat-lint.mjs --fix      # 自动修 CRLF 与 BOM（ASCII 违规只能人工处理）
 *   node scripts/bat-lint.mjs --quiet
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const FIX = argv.includes('--fix');
const QUIET = argv.includes('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };

// 只看项目根目录的 .bat（子目录里的是第三方或构建产物）
const names = fs
  .readdirSync(ROOT)
  .filter((f) => f.toLowerCase().endsWith('.bat'))
  .sort();

if (names.length === 0) {
  log('没有找到 .bat 文件。');
  process.exit(0);
}

const fixed = [];
const violations = [];

for (const name of names) {
  const p = path.join(ROOT, name);
  const buf = fs.readFileSync(p);

  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let loneLf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) loneLf++;
  }
  // 非 ASCII 字节：逐行统计，方便定位
  const text = buf.subarray(hasBom ? 3 : 0).toString('utf8');
  const nonAsciiLines = [];
  text.split('\n').forEach((l, i) => {
    if (/[^\x00-\x7F]/.test(l)) nonAsciiLines.push(i + 1);
  });

  const eolIssues = [];
  if (hasBom) eolIssues.push('UTF-8 BOM');
  if (loneLf > 0) eolIssues.push(`${loneLf} 处 LF`);

  // 能自动修的（换行 / BOM）先修掉
  if (FIX && eolIssues.length > 0) {
    const body = hasBom ? buf.subarray(3) : buf;
    const normalized = body.toString('utf8').replace(/\r\n|\r|\n/g, '\r\n');
    fs.writeFileSync(p, Buffer.from(normalized, 'utf8'));
    fixed.push(`${name}  (${eolIssues.join('，')})`);
  }

  // ASCII 违规无法自动化，只报
  if (nonAsciiLines.length > 0) {
    const shown = nonAsciiLines.slice(0, 6).join(', ');
    const more = nonAsciiLines.length > 6 ? ` 等 ${nonAsciiLines.length} 行` : '';
    violations.push(`${name}  ->  第 ${shown}${more} 行含非 ASCII 字符`);
  }
  if (!FIX && eolIssues.length > 0) {
    violations.push(`${name}  ->  ${eolIssues.join('，')}`);
  }
}

if (FIX && fixed.length > 0) {
  log('已自动修复：');
  for (const f of fixed) log('  ' + f);
  log('');
}

if (violations.length === 0) {
  log(`.bat 规范检查：${names.length} 个文件全部合规（纯 ASCII + CRLF + 无 BOM）`);
  process.exit(0);
}

console.error('');
console.error('[x] 以下 .bat 文件不符合规范，会导致 cmd.exe 解析出错：');
for (const v of violations) console.error('    ' + v);
console.error('');
console.error('    纯 ASCII 违规无法自动修复，需要人工处理：');
console.error('      - 把中文提示移到 Node 脚本里打印（参考 scripts/pack.mjs / launchers.mjs）');
console.error('      - .bat 只保留 ASCII 的启动逻辑，例如：');
console.error('            @echo off');
console.error('            chcp 65001 >nul');
console.error('            cd /d "%~dp0"');
console.error('            node scripts\\pack.mjs');
console.error('            pause');
console.error('');
console.error('    换行 / BOM 问题可以自动修：node scripts/bat-lint.mjs --fix');
process.exit(1);
