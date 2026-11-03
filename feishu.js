/**
 * 把 Trending 榜单渲染并推送到飞书自定义机器人。
 * 支持签名校验（机器人开启"签名校验"时必填 FEISHU_SECRET）。
 *
 * 环境变量：
 *   FEISHU_WEBHOOK  必填，形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
 *   FEISHU_SECRET   可选，机器人开启签名校验时填
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
require('./.env.js');
const { redact } = require('./redact.js');

/** 生成飞书签名：以 `${timestamp}\n${secret}` 为密钥对空串做 HMAC-SHA256，再 base64。 */
function sign(timestamp, secret) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

/** 从 .credentials.yaml 的 refs 段读取变量（与 summarize.js 同一套解析）。 */
function readCredentialRef(name) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs && /^\S/.test(line)) { inRefs = false; continue; }
      if (!inRefs) continue;
      const m = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* 文件不存在时走环境变量 */ }
  return null;
}

function resolveConfig() {
  const webhook = process.env.FEISHU_WEBHOOK || readCredentialRef('FEISHU_WEBHOOK');
  const secret = process.env.FEISHU_SECRET || readCredentialRef('FEISHU_SECRET') || '';
  return { webhook, secret };
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

/** 渲染为飞书 interactive 卡片。 */
function renderCard({ repos, overview, summaries, date, url, sinceLabel }) {
  const elements = [];

  if (overview) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: overview } });
    elements.push({ tag: 'hr' });
  }

  repos.forEach((r, i) => {
    const summary = summaries.get(r.fullName) || r.description || '（暂无摘要）';
    // 飞书 lark_md 支持 a 标签与 * 加粗
    const title = `**[${i + 1}. ${r.fullName}](${r.url})**  \`${r.language || '未知语言'}\``;
    const meta = `⭐ ${fmtNum(r.stars)}  ·  ＋${fmtNum(r.starsSince)} ${sinceLabel}`;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `${title}\n${meta}\n${summary}` },
    });
    if (i < repos.length - 1) elements.push({ tag: 'hr' });
  });

  elements.push({
    tag: 'note',
    elements: [{ tag: 'lark_md', content: `数据来源 [GitHub Trending](${url}) · ${date}` }],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `🔥 GitHub 今日热门 · ${date}` },
    },
    elements,
  };
}

/** 发送卡片；返回飞书响应对象。 */
async function sendToFeishu(card, config = resolveConfig()) {
  const { webhook, secret } = config;
  if (!webhook) throw new Error('未配置 FEISHU_WEBHOOK（环境变量或 ~/.dsh/.credentials.yaml 的 refs）');

  const body = { msg_type: 'interactive', card };
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = sign(timestamp, secret);
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  // 飞书成功判定：code === 0 或 StatusCode === 0
  const ok = json.code === 0 || json.StatusCode === 0;
  if (!res.ok || !ok) {
    // 只保留飞书的错误码与消息字段，不回显完整响应体，
    // 也不回显 webhook 地址本身，避免任何形式的密钥外泄。
    const code = json.code ?? json.StatusCode ?? 'unknown';
    const msg = json.msg ?? json.StatusMessage ?? json.raw ?? '';
    const detail = redact(String(msg)).slice(0, 300);
    throw new Error(`飞书推送失败 HTTP ${res.status}，code=${code}：${detail}`);
  }
  return json;
}

module.exports = { renderCard, sendToFeishu, sign, resolveConfig, readCredentialRef, fmtNum };
