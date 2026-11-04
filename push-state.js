/**
 * 当天推送去重：避免多个保底 cron 时间点重复推送。
 *
 * 难点：GitHub Actions 每次运行都是全新容器，本地文件不保留。
 * 解决：把"今天是否已推送"记录到 GitHub Actions Cache 中。
 *   - 用 actions/cache 的 restore/save 语义，key 里包含日期
 *   - 本地运行时退化为读写本地文件
 *
 * 另外提供一条不依赖缓存的服务端兜底：在飞书消息里带上当日标记，
 * 即使缓存失效导致重复推送，用户也能一眼看出是同一天的内容。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 状态文件路径：优先用环境变量指定的目录，否则用临时目录。 */
function stateFile() {
  const dir = process.env.TRENDING_STATE_DIR
    || process.env.TRENDING_ARCHIVE_DIR
    || path.join(os.tmpdir(), 'github-trending-archive');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录不可写时退化为临时目录 */
  }
  return path.join(dir, 'push-state.json');
}

/** 北京时间的 YYYY-MM-DD。 */
function beijingDate(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断今天是否已经推送过。
 * @param {string} [date] 北京日期 YYYY-MM-DD
 * @returns {{alreadyPushed: boolean, record: object|null}}
 */
function checkPushedToday(date = beijingDate()) {
  const state = readState();
  const record = state[date];
  return { alreadyPushed: Boolean(record?.pushed), record: record ?? null };
}

/** 记录今天已推送。 */
function markPushed({ date = beijingDate(), count, trigger } = {}) {
  const state = readState();
  state[date] = {
    pushed: true,
    at: new Date().toISOString(),
    count: count ?? null,
    trigger: trigger ?? null,
  };
  // 只保留最近 30 天，避免状态文件无限增长
  const keys = Object.keys(state).sort();
  while (keys.length > 30) {
    delete state[keys.shift()];
  }
  writeState(state);
}

/** 触发来源：GitHub Actions 的 schedule 还是手动。 */
function triggerSource() {
  return process.env.GITHUB_EVENT_NAME || 'local';
}

module.exports = { checkPushedToday, markPushed, beijingDate, triggerSource, stateFile };
