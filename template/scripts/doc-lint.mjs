#!/usr/bin/env node
/**
 * doc-lint.mjs —— 文档交叉引用检查
 *
 * 为什么需要：这套文档里到处是「见 docs/05 第 2 节」这类引用，而 docs/05 的节号
 * 是纯手工维护的。给踩坑记录插两节、下面的编号全部要顺移，漏改一处就变成
 * "指着另一节说的" —— 这类断链读者不会报错，只会读到错的内容。
 * （2026-09-26 实际发生过：新增两节后 11/12/13 号重复，靠 grep 才发现。）
 *
 * 检查两类可靠判据：
 *   1. 引用到的 docs/ 下的文档必须存在
 *   2. 「docs/<某篇> 第 N 节」以及文档内不带前缀的「第 N 节」，
 *      指向的 `## N.` 标题必须存在 —— 后者按"当前文件"解析
 *
 * 不检查 `#anchor` 形式的链接：GitHub 对含中文与反引号的标题做 slug 的规则
 * 实现起来容易出错，误报会让人开始忽略这个脚本的输出，那就失去意义了。
 *
 * 用法：
 *   node scripts/doc-lint.mjs            # 从仓库根扫 .md 与 scripts/*.mjs
 *   node scripts/doc-lint.mjs --verbose  # 打印识别到的每条引用
 * 退出码：0 = 全部对得上，1 = 有断链
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ 往上两级 = 仓库根（template/ 的上一级）
const ROOT = path.resolve(__dirname, "..", "..");
const VERBOSE = process.argv.includes("--verbose");

const docsDir = path.join(ROOT, "docs");
const hasDocs = fs.existsSync(docsDir);
const docFiles = hasDocs
  ? fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"))
  : [];

// 模板被单独复制出去用时（README 建议的用法），旁边就没有 docs/，
// 此时所有「见 docs/05 第 N 节」都无从校验 —— 那不是断链，直接跳过，
// 否则每个用户第一次跑都会看到一堆假警报。
if (!hasDocs) {
  console.log("没找到仓库根的 docs/ 目录 —— 这是被单独复制出去的模板副本？跳过交叉引用检查。");
  process.exit(0);
}

/** 收集每个文档里存在的节号：`## 3. xxx` → 3 */
const sectionsOf = {};
/** 数字前缀 → 文件名，让「docs/05 第 2 节」这种简写也能解析 */
const byPrefix = {};
for (const f of docFiles) {
  const text = fs.readFileSync(path.join(docsDir, f), "utf8");
  const nums = new Set();
  for (const m of text.matchAll(/^##\s+(\d+)\.\s/gm)) nums.add(Number(m[1]));
  sectionsOf[f] = nums;
  const prefix = f.match(/^(\d{2})/)?.[1];
  if (prefix) byPrefix[prefix] = f;
}

function* walk(dir, filter) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "target" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, filter);
    else if (filter(e.name)) yield p;
  }
}

const files = [...walk(ROOT, (n) => n.endsWith(".md") || n.endsWith(".mjs"))];
const problems = [];
let checked = 0;

// 「docs/05 第 2 节」「docs/05-踩坑记录.md 第 2 节」都要认 —— 正文里绝大多数写的是
// 数字简写，只匹配完整文件名的话，检查会"全绿"而实际一条都没核对。
const RE_SECTION_REF =
  /docs\/(?:(\d{2})|([\w.\u4e00-\u9fff-]+?\.md))((?:(?!第)[^\n]){0,20}?)第\s*(\d+)\s*节/g;
const RE_ANY_SECTION = /第\s*(\d+)\s*节/g;
const RE_DOC_LINK = /docs\/([\w.\u4e00-\u9fff-]+?\.md)/g;

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  // 文档自己内部的「第 N 节」按本文件解析
  const ownDoc = rel.match(/^docs\/([^/]+\.md)$/)?.[1] ?? null;
  const covered = [];

  for (const m of text.matchAll(RE_SECTION_REF)) {
    checked++;
    covered.push([m.index, m.index + m[0].length]);
    const n = Number(m[4]);
    const targetFile = m[1] ? byPrefix[m[1]] : m[2];
    const label = m[1] ? `docs/${m[1]}${targetFile ? `（${targetFile}）` : ""}` : `docs/${m[2]}`;

    if (!targetFile || !sectionsOf[targetFile]) {
      problems.push(`${rel}: 引用 ${label} 第 ${n} 节，但 docs/ 下没有这个文档`);
    } else if (!sectionsOf[targetFile].has(n)) {
      problems.push(
        `${rel}: 引用 ${label} 第 ${n} 节，但该文档没有 "## ${n}." 标题（节号可能已顺移）`,
      );
    } else if (VERBOSE) {
      console.log(`  ok  ${rel} -> ${label} 第 ${n} 节`);
    }
  }

  if (ownDoc) {
    for (const m of text.matchAll(RE_ANY_SECTION)) {
      if (covered.some(([a, b]) => m.index >= a && m.index < b)) continue; // 上面已核对
      checked++;
      const n = Number(m[1]);
      if (!sectionsOf[ownDoc].has(n)) {
        problems.push(`${rel}: 「第 ${n} 节」在本文件里找不到 "## ${n}." 标题`);
      }
    }
  }

  for (const m of text.matchAll(RE_DOC_LINK)) {
    checked++;
    const target = path.join(docsDir, m[1]);
    if (!fs.existsSync(target)) {
      problems.push(`${rel}: 链接到不存在的文档 docs/${m[1]}`);
    }
  }
}

console.log("");
console.log(`扫描 ${files.length} 个文件，核对 ${checked} 处文档引用`);
if (problems.length === 0) {
  console.log("全部对得上。");
  process.exit(0);
}
console.log(`发现 ${problems.length} 处断链：`);
for (const p of problems) console.log("  " + p);
console.log("");
console.log("改节号时记得同步所有指回去的地方；docs/ 下的节是纯手工编号，这是唯一能拦住它的检查。");
process.exit(1);
