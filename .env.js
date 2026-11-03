/**
 * 最小 .env 加载器：读取同目录 .env.local，把键值注入 process.env。
 * 不覆盖已存在的环境变量（环境变量优先级更高）。
 * 被 fetch/summarize/feishu/daily 在启动时 require 一次即可。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '.env.local');

function loadEnv(file = ENV_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const loaded = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
    loaded[key] = process.env[key];
  }
  return loaded;
}

loadEnv();

module.exports = { loadEnv };
