/**
 * 调用智谱 GLM 生成 GitHub Trending 榜单的中文摘要。
 *
 * API Key 解析顺序：
 *   环境变量 ZHIPU_API_KEY → $DSH_HOME/.credentials.yaml 的 refs.ZHIPU_API_KEY
 *
 * 可选环境变量：
 *   ZHIPU_BASE_URL  默认 https://open.bigmodel.cn/api/paas/v4
 *   ZHIPU_MODEL     默认 glm-4-flash
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
require('./.env.js');
const { redact } = require('./redact.js');

const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-4-flash';

/** 从 .credentials.yaml 的 refs 段取出某个变量名对应的值。 */
function readCredentialRef(name) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  let text;
  try {
    text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  } catch {
    return null;
  }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) { inRefs = false; continue; }
    if (!inRefs) continue;
    const m = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
    if (m && m[1] === name) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function resolveApiKey() {
  return process.env.ZHIPU_API_KEY || readCredentialRef('ZHIPU_API_KEY') || null;
}

function buildPrompt(repos, sinceLabel) {
  const list = repos
    .map((r, i) => {
      const desc = r.description ? r.description.slice(0, 400) : '(无描述)';
      return `${i + 1}. ${r.fullName} | 语言:${r.language || '未知'} | 总star:${r.stars} | 本期新增:${r.starsSince} | 简介:${desc}`;
    })
    .join('\n');

  return `你是一名技术编辑，为中文读者写 GitHub 每日热门榜单摘要。下面是今天 GitHub Trending 的仓库数据（${sinceLabel}）：

${list}

请输出严格的 JSON，不要 Markdown 代码块，结构如下：
{
  "overview": "整份榜单的整体观察，2-3 句，指出今天的技术主题和趋势，不要罗列仓库名",
  "items": [
    { "fullName": "owner/repo", "summary": "40-70 字中文摘要，说清这个项目解决什么问题、为什么值得关注" }
  ]
}

要求：
1. items 的 fullName 必须与输入完全一致，顺序与输入一致，每条都要有。
2. summary 用中文，客观描述，不要用"颠覆""神器""必装"这类夸张营销词。
3. 不要编造输入里没有的事实（如功能细节、公司背景）；信息不足就基于简介本身概括。
4. 只输出 JSON。`;
}

/**
 * 带超时与重试的 POST。网络抖动（连接超时 / DNS 抖动）在多出口环境下很常见，
 * 单次失败不应该让整份日报丢掉。
 */
async function postJsonWithRetry(url, headers, payload, { attempts = 4, timeoutMs = 90000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      // 5xx 与 429 值得重试；4xx（除 429）是调用方问题，直接返回让上层报错。
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      } else {
        return { status: res.status, text };
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError'
        ? new Error(`请求超时（${timeoutMs}ms）`)
        : e;
    }
    if (i < attempts) {
      const wait = 1500 * i;
      process.stderr.write(`      第 ${i} 次请求失败（${lastErr.message}），${wait}ms 后重试\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * 生成摘要。
 * @param {Array} repos 仓库列表
 * @param {object} [options]
 * @returns {Promise<{overview: string, summaries: Map<string,string>, model: string, usage: object}>}
 */
async function summarize(repos, options = {}) {
  const apiKey = options.apiKey || resolveApiKey();
  if (!apiKey) {
    throw new Error('未找到 ZHIPU_API_KEY（可在环境变量或 ~/.dsh/.credentials.yaml 的 refs 中配置）');
  }

  const base = (options.baseUrl || process.env.ZHIPU_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const model = options.model || process.env.ZHIPU_MODEL || DEFAULT_MODEL;
  const sinceLabel = options.sinceLabel || '今日';

  const { status, text } = await postJsonWithRetry(
    `${base}/chat/completions`,
    { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    {
      model,
      messages: [
        { role: 'system', content: '你是严谨的中文技术编辑，只输出被要求的 JSON。' },
        { role: 'user', content: buildPrompt(repos, sinceLabel) },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    },
    { timeoutMs: options.timeoutMs ?? 90000 },
  );

  if (status < 200 || status >= 300) {
    // 脱敏后再截断：智谱的错误响应有时会回显请求头信息。
    throw new Error(`智谱 API ${status}: ${redact(text).slice(0, 400)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`智谱返回非 JSON: ${redact(text).slice(0, 300)}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('智谱返回内容为空');

  let parsed;
  try {
    parsed = JSON.parse(
      String(content).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(),
    );
  } catch (e) {
    throw new Error(`无法解析智谱返回的 JSON: ${e.message}；原始内容前 300 字: ${String(content).slice(0, 300)}`);
  }

  const summaries = new Map();
  for (const item of parsed.items ?? []) {
    if (item && typeof item.fullName === 'string' && typeof item.summary === 'string') {
      summaries.set(item.fullName, item.summary.trim());
    }
  }
  return { overview: String(parsed.overview ?? '').trim(), summaries, model, usage: json.usage };
}

module.exports = { summarize, resolveApiKey, readCredentialRef };

if (require.main === module) {
  (async () => {
    const { fetchTrending } = require('./fetch-trending.js');
    const data = await fetchTrending({ since: 'daily' });
    const r = await summarize(data.repos.slice(0, 5), { sinceLabel: '今日' });
    console.log('OVERVIEW:', r.overview);
    for (const [k, v] of r.summaries) console.log(`- ${k}: ${v}`);
    console.log('USAGE:', JSON.stringify(r.usage));
  })().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
