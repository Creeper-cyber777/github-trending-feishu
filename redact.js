/**
 * 日志脱敏：确保任何密钥、webhook、token 都不会出现在控制台或 CI 日志里。
 *
 * 设计原则：
 *   1. 白名单式脱敏 —— 已知敏感值全部替换为固定占位符；
 *   2. 兜底规则 —— 即使出现未登记的疑似密钥（长随机串、hook 路径、Bearer 串），也按模式抹掉；
 *   3. 幂等 —— 多次调用结果一致。
 */
'use strict';

const REDACTED = '***REDACTED***';

/** 从环境变量收集需要抹掉的具体值。 */
function collectSecrets() {
  const keys = [
    'ZHIPU_API_KEY',
    'FEISHU_WEBHOOK',
    'FEISHU_SECRET',
    'DEEPSEEK_API_KEY',
  ];
  const values = [];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim().length >= 8) values.push(v.trim());
  }
  return values;
}

/**
 * 兜底正则：捕获常见密钥形态。
 * - 飞书 webhook：/open-apis/bot/v2/hook/<uuid>
 * - 智谱 key：<32位hex>.<16位以上字母数字>
 * - 通用 Bearer 后的长串
 */
const PATTERNS = [
  /(open-apis\/bot\/v\d+\/hook\/)[\w-]+/gi,
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{16,}\b/g,
  /\b(sk|pk|api[_-]?key)[-_]?[A-Za-z0-9]{16,}\b/gi,
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi,
  /\b[0-9a-f]{32,}\b/g,
];

/**
 * 脱敏一段文本。
 * @param {unknown} input 任意值，会被转成字符串
 * @returns {string}
 */
function redact(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');

  // 1. 先替换已知的具体值
  for (const secret of collectSecrets()) {
    if (!secret) continue;
    text = text.split(secret).join(REDACTED);
    // webhook 可能以 URL 形式部分出现，替换其路径段
    const tail = secret.split('/').pop();
    if (tail && tail.length >= 8 && tail !== secret) {
      text = text.split(tail).join(REDACTED);
    }
  }

  // 2. 兜底模式匹配
  text = text.replace(PATTERNS[0], `$1${REDACTED}`);
  text = text.replace(PATTERNS[1], REDACTED);
  text = text.replace(PATTERNS[2], REDACTED);
  text = text.replace(PATTERNS[3], `$1${REDACTED}`);
  text = text.replace(PATTERNS[4], (m) => (m.length >= 32 ? REDACTED : m));

  return text;
}

/** 包装 console，使所有输出自动脱敏（仅需在主流程入口调用一次）。 */
function installSafeConsole() {
  const original = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
  };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      original[level](...args.map((a) => (typeof a === 'string' ? redact(a) : a)));
    };
  }
}

module.exports = { redact, installSafeConsole, REDACTED };
