/**
 * GitHub Trending 每日推送主流程：抓取 → AI 摘要 → 渲染飞书卡片 → 推送。
 *
 * 用法：
 *   node daily.js                 # 抓取并推送（默认 Top 10）
 *   node daily.js --dry-run       # 只渲染不推送，打印卡片 JSON
 *   node daily.js --limit 15      # 指定条数
 *   node daily.js --no-ai         # 跳过 AI 摘要，用原始英文描述
 *   node daily.js --out <path>    # 同时把卡片 JSON 落盘
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installSafeConsole, redact } = require('./redact.js');
const { fetchTrending } = require('./fetch-trending.js');
const { summarize } = require('./summarize.js');
const { renderCard, sendToFeishu } = require('./feishu.js');
const { checkPushedToday, markPushed, beijingDate, triggerSource } = require('./push-state.js');

// 在此之后所有 console 输出都会自动脱敏，任何密钥不可能进入 CI 日志。
installSafeConsole();

function parseArgs(argv) {
  const opts = { limit: 10, dryRun: false, ai: true, out: null, since: 'daily', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-ai') opts.ai = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--limit') opts.limit = Number(argv[++i] ?? 10);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--since') opts.since = argv[++i] ?? 'daily';
  }
  return opts;
}

const SINCE_TEXT = { daily: '今日', weekly: '本周', monthly: '本月' };

/**
 * 归档目录解析顺序：
 *   1. 环境变量 TRENDING_ARCHIVE_DIR
 *   2. 工作区 输出\GitHub每日热门\（符合工作区约定）
 *   3. 系统临时目录下的 github-trending-archive\
 * 逐个探测真实可写性，返回第一个能写的。
 */
const WORKSPACE = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(WORKSPACE, '输出', 'GitHub每日热门');
const TMP_DIR = path.join(os.tmpdir(), 'github-trending-archive');

/** 选出第一个可写的归档目录。 */
function resolveArchiveDir() {
  const candidates = [
    process.env.TRENDING_ARCHIVE_DIR,
    OUTPUT_DIR,
    path.join(__dirname, 'archive'),
    TMP_DIR,
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function todayText(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function compactDate(date = new Date()) {
  return todayText(date).replace(/-/g, '');
}

/** 追加一行到当日运行日志。 */
function appendLog(line) {
  try {
    const dir = resolveArchiveDir();
    if (!dir) return;
    fs.appendFileSync(path.join(dir, `日志_${compactDate()}.log`), `${line}\n`, 'utf8');
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

/** 归档 Markdown 与卡片 JSON，返回归档目录。 */
function archive({ card, repos, overview, summaries, date, sinceLabel }) {
  const dir = resolveArchiveDir();
  if (!dir) throw new Error('没有可写的归档目录');
  const md = writeMarkdown({ repos, overview, summaries, date, sinceLabel });
  const mdPath = path.join(dir, `GitHub热门_${compactDate()}.md`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(
    path.join(dir, `卡片_${compactDate()}.json`),
    JSON.stringify(card, null, 2),
    'utf8',
  );
  return { dir, mdPath };
}

/** 把摘要结果归档成便于阅读的 Markdown。 */
function writeMarkdown({ repos, overview, summaries, date, sinceLabel }) {
  const lines = [`# GitHub ${sinceLabel}热门 · ${date}`, ''];
  if (overview) lines.push(`> ${overview}`, '');
  repos.forEach((r, i) => {
    const summary = summaries.get(r.fullName) || r.description || '（暂无摘要）';
    lines.push(
      `## ${i + 1}. [${r.fullName}](${r.url})`,
      '',
      `- 语言：${r.language || '未知'}　总 star：${r.stars.toLocaleString('en-US')}　本期新增：+${r.starsSince.toLocaleString('en-US')}`,
      `- ${summary}`,
      '',
    );
  });
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sinceLabel = SINCE_TEXT[opts.since] || '今日';
  const today = beijingDate();
  const trigger = triggerSource();

  // ── 兜底去重 ──
  // 多个 cron 时间点都会触发同一份日报，这里确保每天只真正推送一次。
  // --dry-run 与 --force 不受去重限制。
  if (!opts.dryRun && !opts.force) {
    const { alreadyPushed, record } = checkPushedToday(today);
    if (alreadyPushed) {
      console.log(`[跳过] ${today} 已推送过（${record.at}，触发源 ${record.trigger}），本次不再重复发送。`);
      console.log('       如需强制重发，请加 --force。');
      return;
    }
  }

  console.log('[1/3] 抓取 GitHub Trending ...');
  const data = await fetchTrending({ since: opts.since });
  const repos = data.repos.slice(0, opts.limit);
  console.log(`      拿到 ${data.repos.length} 条，取前 ${repos.length} 条`);

  let overview = '';
  let summaries = new Map();

  if (opts.ai) {
    console.log('[2/3] 生成 AI 摘要 ...');
    try {
      const result = await summarize(repos, { sinceLabel });
      overview = result.overview;
      summaries = result.summaries;
      const missing = repos.filter((r) => !summaries.has(r.fullName)).length;
      console.log(`      摘要 ${summaries.size}/${repos.length} 条${missing ? `（${missing} 条缺失，回退原文）` : ''}`);
    } catch (e) {
      console.error(`      摘要失败，回退原始描述：${e.message}`);
    }
  } else {
    console.log('[2/3] 跳过 AI 摘要（--no-ai）');
  }

  const card = renderCard({
    repos,
    overview,
    summaries,
    date: todayText(),
    url: data.url,
    sinceLabel,
  });

  // 归档：每日一份 Markdown 与卡片 JSON
  try {
    const { mdPath } = archive({
      card, repos, overview, summaries, date: todayText(), sinceLabel,
    });
    console.log(`      归档：${mdPath}`);
  } catch (e) {
    console.error(`      归档失败（不影响推送）：${e.message}`);
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify(card, null, 2), 'utf8');
    console.log(`      卡片已写入 ${opts.out}`);
  }

  if (opts.dryRun) {
    appendLog(`[${new Date().toISOString()}] dry-run 完成，${repos.length} 条`);
    console.log('[3/3] --dry-run：不推送，卡片内容如下');
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  console.log('[3/3] 推送到飞书 ...');
  const r = await sendToFeishu(card);
  console.log(`      推送成功 ${JSON.stringify(r)}`);

  // 标记当天已推送，供后续 cron 时间点判断是否跳过
  markPushed({ date: today, count: repos.length, trigger });
  console.log(`      已记录 ${today} 推送状态（触发源 ${trigger}）`);

  appendLog(`[${new Date().toISOString()}] 推送成功，${repos.length} 条，摘要 ${summaries.size} 条，触发源 ${trigger}`);
}

main().catch((e) => {
  appendLog(`[${new Date().toISOString()}] 失败：${e.message}`);
  console.error('ERROR:', e.message);
  process.exit(1);
});
