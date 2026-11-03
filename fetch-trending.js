/**
 * 抓取 GitHub Trending 每日榜并解析成结构化数据。
 * 用法：node fetch-trending.js [--since daily|weekly|monthly] [--lang <语言>] [--json]
 */
'use strict';

const VALID_SINCE = new Set(['daily', 'weekly', 'monthly']);

function parseArgs(argv) {
  const opts = { since: 'daily', lang: '', json: false, limit: 25 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since') { opts.since = argv[++i] ?? 'daily'; }
    else if (a === '--lang') { opts.lang = argv[++i] ?? ''; }
    else if (a === '--json') { opts.json = true; }
    else if (a === '--limit') { opts.limit = Number(argv[++i] ?? 25); }
  }
  if (!VALID_SINCE.has(opts.since)) throw new Error(`--since must be one of ${[...VALID_SINCE].join('|')}`);
  return opts;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 去掉标签，保留纯文本。 */
function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, '')).trim();
}

/** 从一段 HTML 里按类名/选择器提取第一处内容。 */
function firstMatch(html, re) {
  const m = re.exec(html);
  return m ? m[1] : null;
}

/**
 * 解析一个 <article> 块。
 * @param {string} block 单条仓库的 HTML 片段
 * @returns {object|null}
 */
function parseArticle(block) {
  // 仓库全名：<h2 class="h3 lh-condensed"><a href="/owner/name" ...>
  const fullName = firstMatch(block, /<h2 class="h3 lh-condensed">\s*<a[^>]*href="\/([^"]+)"/);
  if (!fullName) return null;
  const [owner, name] = fullName.split('/');
  if (!owner || !name) return null;

  // 描述：<p class="col-9 color-fg-muted my-1 pr-4">...</p>
  // 注意 GitHub 的类名带 tmp- 前缀（tmp-pr-4），不同时期标记略有差异，所以做成容错匹配。
  const description = stripTags(
    firstMatch(block, /<p class="col-9 color-fg-muted my-1[^"]*">([\s\S]*?)<\/p>/) ?? '',
  );

  // 语言：<span itemprop="programmingLanguage">Rust</span>
  const language = stripTags(
    firstMatch(block, /<span itemprop="programmingLanguage">([\s\S]*?)<\/span>/) ?? '',
  );

  // 总 star：<a href="/owner/name/stargazers" ...>12,345</a>
  const starsRaw = stripTags(firstMatch(block, /href="\/[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/) ?? '');
  const stars = Number(starsRaw.replace(/,/g, '')) || 0;

  // 总 fork
  const forksRaw = stripTags(firstMatch(block, /href="\/[^"]+\/forks"[^>]*>([\s\S]*?)<\/a>/) ?? '');
  const forks = Number(forksRaw.replace(/,/g, '')) || 0;

  // 今日新增 star：<span class="d-inline-block float-sm-right"> <svg .../> 1,234 stars today</span>
  // 该 span 内部先出现一个 <svg> 图标，所以要去掉标签后再提取数字，不能用单层非贪婪正则直接取值。
  const sinceRaw = stripTags(
    firstMatch(block, /<span[^>]*class="d-inline-block float-sm-right"[^>]*>([\s\S]*?)<\/span>/) ?? '',
  );
  const sinceMatch = /([\d,]+)\s+stars?\s+(today|this week|this month)/i.exec(sinceRaw);
  const starsSince = sinceMatch ? Number(sinceMatch[1].replace(/,/g, '')) : 0;
  const sinceLabel = sinceMatch ? sinceMatch[2].toLowerCase() : '';

  // 头像/owner 链接（顺带确认 owner 主页地址规范）
  const url = `https://github.com/${owner}/${name}`;

  return {
    owner,
    name,
    fullName,
    url,
    description,
    language,
    stars,
    forks,
    starsSince,
    sinceLabel,
  };
}

/** 从整页 HTML 解析出仓库列表。 */
function parseTrending(html) {
  const blocks = html.split('<article class="Box-row">').slice(1);
  return blocks.map((b) => parseArticle(b.split('</article>')[0])).filter(Boolean);
}

async function fetchTrending({ since = 'daily', lang = '' } = {}) {
  const params = new URLSearchParams({ since });
  let url = 'https://github.com/trending';
  if (lang) url += `/${encodeURIComponent(lang)}`;
  url += `?${params.toString()}`;

  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9',
  };

  // 网络抖动重试：连接超时在部分出口很常见，单次失败不应当让整份日报失败。
  const attempts = 4;
  let lastErr;
  let html;
  for (let i = 1; i <= attempts; i += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45000);
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`GitHub trending returned HTTP ${res.status} for ${url}`);
      } else {
        html = await res.text();
        break;
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? new Error('抓取 GitHub Trending 超时（45s）') : e;
    }
    if (i < attempts) {
      const wait = 2000 * i;
      process.stderr.write(`      抓取第 ${i} 次失败（${lastErr.message}），${wait}ms 后重试\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (html === undefined) throw lastErr ?? new Error('抓取 GitHub Trending 失败');

  const repos = parseTrending(html);
  if (repos.length === 0) throw new Error('Parsed zero repositories — GitHub markup may have changed');
  return { url, since, lang, repos };
}

module.exports = { fetchTrending, parseTrending, parseArticle };

if (require.main === module) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const data = await fetchTrending(opts);
    const repos = data.repos.slice(0, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify({ ...data, repos }, null, 2));
    } else {
      console.log(`来源: ${data.url}`);
      console.log(`共 ${data.repos.length} 条，显示前 ${repos.length} 条\n`);
      repos.forEach((r, i) => {
        console.log(`${String(i + 1).padStart(2, ' ')}. ${r.fullName}  [${r.language || '-'}]`);
        console.log(`    ★${r.stars}  fork ${r.forks}  +${r.starsSince} ${r.sinceLabel}`);
        console.log(`    ${r.description || '(无描述)'}`);
      });
    }
  })().catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
}
