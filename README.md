# github-trending-feishu

每日抓取 GitHub Trending 榜单，用智谱 `glm-4-flash` 生成中文摘要，推送到飞书。

由 GitHub Actions 在云端运行，**不依赖本机开机**。

## 效果

飞书群内每天收到一张卡片：整榜趋势综述 + 每个项目的 AI 中文摘要、语言、star 总数与当日增量。

## 定时与兜底机制

定时任务设置了**三个时间点**，后两个是兜底：

| 时间（北京） | UTC cron | 角色 |
|---|---|---|
| 09:00 | `0 1 * * *` | 主时间 |
| 09:40 | `40 1 * * *` | 兜底一 |
| 10:20 | `20 2 * * *` | 兜底二 |

GitHub 的 schedule 在高峰期可能延迟甚至跳过，所以用多点触发提高成功率。

**去重保证**：脚本通过 `push-state.js` 记录"当天是否已推送"。三个时间点都会触发 workflow，但只有**第一个成功的**会真正发送到飞书，后续时间点检测到当天已推送会直接跳过并在日志中说明。

- 状态存放在 Actions Cache 中（每次运行用 `run_id` 作 key，`restore-keys` 取回最近状态），跨容器保留
- 只保留最近 30 天的记录
- 手动触发时如需强制重发，勾选 `force=true` 或加 `--force`

## 部署步骤

### 1. 配置仓库 Secrets

进入 `Settings` → `Secrets and variables` → `Actions` → `New repository secret`，依次添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `ZHIPU_API_KEY` | ✅ | 智谱开放平台 API Key，[获取地址](https://open.bigmodel.cn) |
| `FEISHU_WEBHOOK` | ✅ | 飞书群机器人 Webhook 地址 |
| `FEISHU_SECRET` | ❌ | 仅当机器人开启「签名校验」时填写 |

> 变量名必须**完全一致**。写成 `FEISHU_WEBHOOK_URL` 之类的变体不会被读取，运行时会报缺少配置。

### 2. 手动验证一次

`Actions` → `GitHub Trending Daily Push` → `Run workflow`，可调整条数、周期，或勾选 `dry_run` 只生成不发送。

### 3. 等待定时执行

无需额外操作，到点自动运行。

## 本地运行

```bash
cp .env.example .env.local   # 填入真实密钥
node daily.js                # 完整推送
node daily.js --dry-run      # 只看内容不推送
node daily.js --force        # 忽略当天去重，强制重发
node daily.js --limit 5 --since weekly
node daily.js --no-ai        # 跳过 AI 摘要
```

需要 Node.js 18+（内置 fetch）。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--limit N` | 10 | 推送条数（网页默认 15，最多 25） |
| `--since` | daily | `daily` / `weekly` / `monthly` |
| `--dry-run` | 关 | 只输出卡片 JSON，不推送 |
| `--no-ai` | 关 | 跳过 AI，使用原始描述 |
| `--force` | 关 | 忽略当天去重，强制重发 |
| `--out <path>` | — | 额外把卡片 JSON 写到指定路径 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `ZHIPU_API_KEY` | 智谱 API Key |
| `FEISHU_WEBHOOK` | 飞书机器人 Webhook |
| `FEISHU_SECRET` | 飞书签名密钥（可选） |
| `ZHIPU_MODEL` | 默认 `glm-4-flash` |
| `TRENDING_ARCHIVE_DIR` | 归档目录（可选） |
| `TRENDING_STATE_DIR` | 推送状态目录（可选，默认与归档同目录） |

## 安全设计

- **无硬编码密钥**：所有凭据仅从环境变量读取，代码中没有任何默认值或回退密钥。
- **日志自动脱敏**：`redact.js` 在进程启动时接管 `console`，密钥、webhook、长令牌一律替换为 `***REDACTED***`；即使某处代码误打日志也不会泄露。
- **错误信息收敛**：API 与推送失败时只输出状态码和脱敏后的消息摘要，不回显完整响应体。
- **触发面收敛**：工作流只监听 `schedule` 与手动 `workflow_dispatch`，不接受 `pull_request` 等外部可控事件。
- **提交前扫描**：`node scripts/check-secrets.js` 检查仓库中是否有密钥残留。

### 密钥一旦泄露怎么办

若密钥被提交到 Git 历史或出现在日志中，**改代码不等于安全** —— 必须到对应平台重置：

- 智谱：控制台删除旧 Key 并新建
- 飞书：群设置中移除该机器人，重新添加并生成新 Webhook

## 目录结构

```
.
├── .github/workflows/daily.yml   # Actions 工作流（三 cron + 缓存）
├── daily.js                      # 主流程：去重 → 抓取 → 摘要 → 推送
├── fetch-trending.js             # 抓取并解析 Trending 页面
├── summarize.js                  # 调用智谱 GLM 生成摘要
├── feishu.js                     # 渲染卡片并推送到飞书
├── push-state.js                 # 当天推送去重状态
├── redact.js                     # 日志脱敏
├── .env.js                       # .env.local 加载器
├── .env.example                  # 配置模板
└── scripts/check-secrets.js      # 提交前密钥扫描
```

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `[跳过] 今天已推送过` | 正常行为，兜底 cron 触发了但当天已发送 |
| 今天没收到推送 | 检查 Actions 是否有运行记录；如三个 cron 都没跑，点 Run workflow 手动补发 |
| `fetch failed` | 网络抖动，脚本自动重试 4 次；持续失败检查出口网络 |
| `智谱 API 401` | Key 无效或额度耗尽 |
| `飞书 code=19021` | 签名校验失败，检查 `FEISHU_SECRET` |
| `飞书 code=19024` | 机器人设了关键词，需让消息包含该词 |
| 解析出 0 条 | GitHub 页面结构变更，需更新 `fetch-trending.js` 的选择器 |

## License

MIT
