# github-trending-feishu

每日抓取 GitHub Trending 榜单，用智谱 `glm-4-flash` 生成中文摘要，推送到飞书。

每天定时抓取 [GitHub Trending](https://github.com/trending) 榜单，用智谱 `glm-4-flash` 生成中文摘要，推送到飞书群机器人。由 GitHub Actions 在云端运行，**不依赖本机开机**。

## 效果

飞书群内每天收到一张卡片：整榜趋势综述 + 每个项目的 AI 中文摘要、语言、star 总数与当日增量。

## 部署步骤

### 1. 配置仓库 Secrets

进入 `Settings` → `Secrets and variables` → `Actions` → `New repository secret`，依次添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `ZHIPU_API_KEY` | ✅ | 智谱开放平台 API Key，[获取地址](https://open.bigmodel.cn) |
| `FEISHU_WEBHOOK` | ✅ | 飞书群机器人 Webhook 地址 |
| `FEISHU_SECRET` | ❌ | 仅当机器人开启「签名校验」时填写 |

> 密钥只存在于 Secrets 中，工作流通过环境变量注入，不会写入任何文件，也不会出现在日志里。

### 2. 启用 Actions

若仓库是首次使用 Actions，进 `Actions` 标签页确认已启用。

### 3. 手动验证一次

`Actions` → `GitHub Trending Daily Push` → `Run workflow`，可以调整条数与周期，也可勾选 `dry_run` 只生成不发送。

### 4. 等待定时执行

默认每天 **北京时间 09:00**（UTC 01:00）自动运行。

> GitHub 的定时任务在高峰期可能延迟数分钟至十几分钟，这是平台侧排队行为。若要求严格准点，需要改用带固定执行器的调度服务。

## 本地运行

```bash
cp .env.example .env.local   # 填入真实密钥
node daily.js                # 完整推送
node daily.js --dry-run      # 只看内容不推送
node daily.js --limit 5 --since weekly
node daily.js --no-ai        # 跳过 AI 摘要
```

需要 Node.js 18+（内置 fetch）。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--limit N` | 10 | 推送条数 |
| `--since` | daily | `daily` / `weekly` / `monthly` |
| `--dry-run` | 关 | 只输出卡片 JSON，不推送 |
| `--no-ai` | 关 | 跳过 AI，使用原始描述 |
| `--out <path>` | — | 额外把卡片 JSON 写到指定路径 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `ZHIPU_API_KEY` | 智谱 API Key |
| `FEISHU_WEBHOOK` | 飞书机器人 Webhook |
| `FEISHU_SECRET` | 飞书签名密钥（可选） |
| `ZHIPU_MODEL` | 默认 `glm-4-flash` |
| `TRENDING_ARCHIVE_DIR` | 归档目录（可选） |

## 安全设计

- **无硬编码密钥**：所有凭据仅从环境变量读取，代码中没有任何默认值或回退密钥。
- **日志自动脱敏**：`redact.js` 在进程启动时接管 `console`，密钥、webhook、长令牌一律替换为 `***REDACTED***`；即使某处代码误打日志也不会泄露。
- **错误信息收敛**：API 与推送失败时只输出状态码和脱敏后的消息摘要，不回显完整响应体。
- **触发面收敛**：工作流只监听 `schedule` 与手动 `workflow_dispatch`，不接受 `pull_request` 等外部可控事件。
- **提交前扫描**：`node scripts/check-secrets.js` 检查仓库中是否有密钥残留，建议配合 pre-commit 钩子使用。

### 密钥一旦泄露怎么办

若密钥被提交到 Git 历史或出现在日志中，**改代码不等于安全** —— 必须到对应平台重置：

- 智谱：控制台删除旧 Key 并新建
- 飞书：群设置中移除该机器人，重新添加并生成新 Webhook

## 目录结构

```
.
├── .github/workflows/daily.yml   # Actions 工作流
├── daily.js                      # 主流程：抓取 → 摘要 → 推送
├── fetch-trending.js             # 抓取并解析 Trending 页面
├── summarize.js                  # 调用智谱 GLM 生成摘要
├── feishu.js                     # 渲染卡片并推送到飞书
├── redact.js                     # 日志脱敏
├── .env.js                       # .env.local 加载器
├── .env.example                  # 配置模板
└── scripts/check-secrets.js      # 提交前密钥扫描
```

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `fetch failed` | 网络抖动，脚本自动重试 4 次；持续失败检查出口网络 |
| `智谱 API 401` | Key 无效或额度耗尽 |
| `飞书 code=19021` | 签名校验失败，检查 `FEISHU_SECRET` |
| `飞书 code=19024` | 机器人设了关键词，需让消息包含该词 |
| 解析出 0 条 | GitHub 页面结构变更，需更新 `fetch-trending.js` 的选择器 |

## License

MIT
