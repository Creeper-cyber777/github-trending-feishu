#!/usr/bin/env node
/**
 * 密钥扫描：检查仓库文件里是否有密钥残留。
 * 用法：
 *   node scripts/check-secrets.js            扫描当前目录下所有受版本控制的文件
 *   node scripts/check-secrets.js <dir>      扫描指定目录
 * 退出码：0 = 干净，1 = 发现疑似密钥
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 疑似密钥的形态。 */
const RULES = [
  { name: '飞书 Webhook', re: /open-apis\/bot\/v\d+\/hook\/[0-9a-f-]{20,}/i },
  { name: '智谱 API Key', re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16,}\b/ },
  { name: '疑似飞书签名密钥', re: /\b[0-9a-f]{32}\b/ },
  { name: '通用长 hex 令牌', re: /\b[0-9a-f]{40,}\b/ },
  { name: 'Bearer 长令牌', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: '私钥文件内容', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

/** 出现这些片段的行视为文档占位符，跳过。 */
const ALLOWLIST = [
  /xxxx/i,
  /your[-_]?key/i,
  /example/i,
  /placeholder/i,
  /<[^>]*>$/,
  /\*\*\*REDACTED\*\*\*/,
  /\.env\.local/,       // 文档里提到文件名不算泄密
  /gitignore/,
];

/** 不扫描的目录与文件。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'artifact', 'archive', 'logs', '输出']);
const SKIP_FILES = new Set(['.env.local', 'package-lock.json']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|exe|dll|woff2?|ttf)$/i;

/** 纯注释行不参与扫描（说明文字里的示例）。 */
function isCommentLine(line) {
  return /^\s*(#|\/\/|\*|<!--)/.test(line);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      if (SKIP_EXT.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

function scan(root) {
  const files = walk(root);
  const findings = [];

  for (const file of files) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 4 * 1024 * 1024) continue; // 跳过超大文件
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const rel = path.relative(root, file) || file;
    content.split(/\r?\n/).forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (ALLOWLIST.some((re) => re.test(line))) return;
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          findings.push({
            file: rel,
            line: i + 1,
            rule: rule.name,
            preview: line.trim().slice(0, 90),
          });
        }
      }
    });
  }

  if (findings.length === 0) {
    console.log(`✓ 扫描 ${files.length} 个文件，未发现密钥。`);
    return 0;
  }

  console.error(`\n✗ 发现 ${findings.length} 处疑似密钥：\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
    console.error(`    ${f.preview}`);
  }
  console.error('\n处理方式：');
  console.error('  1. 真实密钥 → 立即删除，并在对应平台重置该密钥');
  console.error('  2. 文档示例 → 改成 xxxx 一类明显占位符');
  console.error('  3. 已在 Git 历史里的密钥 → 视为已泄露，必须重置\n');
  return 1;
}

const target = path.resolve(process.argv[2] || path.join(__dirname, '..'));
process.exit(scan(target));
