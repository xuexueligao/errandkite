# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- MCP 工具（`mcp/server.ts`，stdio，Node 22.18+ 直接运行）：`post_bounty`、`get_bounty`、`get_answers`、`accept_answer`、`cancel_bounty`、`list_my_bounties`
- `mcp/client.ts`：用官方 x402 SDK（`@x402/core/client` + `@x402/evm/exact/client`）在本地签 EIP-3009 付款；签名前核对网络、代币、方案和金额（必须等于悬赏金额），SDK 花费上限设为该金额，另有客户端总上限 `ERRANDKITE_MAX_REWARD_USD`；管理令牌存本机文件（600 权限）；`get_answers` 结果标注回答为外来数据
- 依赖：`@modelcontextprotocol/sdk` 1.32.2、`zod` 4.6.6
- 18 条新测试（共 129 条）：用真实测试私钥签名，假 facilitator 真的验证 EIP-3009 签名（签名者、收款方、金额、Kite 链参数）；签名不对被拒、超上限和非法金额不联系服务器、参数错误不付款、服务器要的金额和悬赏不符时不签名、读回答、采纳放款、取消退款、管不了别人的悬赏
- 真实环境验证（2026-11-28）：本地 `wrangler dev` 连真实 pieverse facilitator，用 MCP 官方客户端通过 stdio 调用 6 个工具；用没有余额的临时钱包付费发布，真实 facilitator 返回 `insufficient_funds`（不是签名错误），说明付款格式和签名已被接受，只差 pieUSD；付款失败没有生成悬赏
- 网页（`public/`，Workers 静态资源，不用构建）：悬赏列表（"正在收回答 / 全部"筛选、加载更早的）、详情（金额、状态、回答数、截止时间、付款 / 放款 / 退款交易链接到 KiteScan）、回答表单（先在前端校验，再显示服务端的字段错误、重复回答、限流等提示）；加载中、没数据、出错三种状态；手机宽度和深色模式；所有外来文字用文本节点渲染，测试保证页面脚本不用 innerHTML 等写 HTML 的接口
- `npm run db:seed:local`：本地演示数据（标为人工测试，没有真实付款）
- 24 条新测试（共 111 条）：页面辅助函数、错误提示、防 XSS、静态资源可访问、接口仍由 Worker 处理、页面读取的字段在接口里都有
- 本地联调（2026-11-27）：`wrangler dev` + 无头 Edge 在 375 像素宽度下实际填写并提交表单，校验错误、提交成功（状态变为 Answered、回答数 +1）、重复回答、无效链接、不存在的悬赏、空列表、深色模式都截图确认
- `GET /api/stats`：公开使用统计（悬赏按来源和状态分开、回答数、不同回答者和付款方数、首个回答用时中位数）和托管对账（已收、已放款、已退款、托管中、在途金额，平台钱包链上 pieUSD 和 KITE 余额，状态 ok / settling / short / unknown，gas 不足标记）
- 定时任务每次运行都做托管对账并写 `escrow_check` 日志，同时清理一天以前的限流记录
- 回答限流：每个 IP 10 分钟 10 个、每个收款地址 1 小时 20 个，超限返回 429 和 `Retry-After`；D1 迁移 `0003_rate_hits.sql`，只存哈希
- 19 条新测试（共 87 条）：账目跟着放款、退款、在途转账走，未结算悬赏不计入，超过 SQLite 整数范围的金额精确相加，钱包读不到，gas 不足，限流窗口、跨 IP、跨悬赏、只计成功回答、哈希存储与清理
- 真实链上验证：本地 `wrangler dev` 下 `/api/stats` 读到平台钱包的链上余额（0 pieUSD、0.4997 KITE，与直接调用 RPC 结果一致），`/__scheduled` 触发定时任务写出 `escrow_check` 日志（2026-11-26）
- 回答：`POST /api/bounties/:id/answers`，不用登录，答案 + 收款地址（EIP-55 校验和、同地址每悬赏一次、每悬赏最多 50 个、到期不收）
- 发布方接口（要管理令牌）：`GET /api/bounties/:id/answers` 读回答，`POST /api/bounties/:id/accept` 采纳并放款，`POST /api/bounties/:id/cancel` 无人回答时取消并退款
- 放款 / 退款状态机 `src/transfers.ts`：先存签名交易再广播，重试只重发同一笔，确认 nonce 被占用且本笔不在链上才重签，5 次失败后停下等人工
- `src/chain.ts`：用 viem 从平台钱包签名 pieUSD 转账；私钥必须对应 `PAY_TO`
- 定时任务（每 5 分钟）：到期悬赏转入退款，推进未确认的放款和退款
- D1 迁移 `0002_answers_transfers.sql`：`answers` 表和转账字段
- 28 条新测试（共 68 条），用假区块链覆盖并发采纳、广播失败、节点未收到、nonce 被占、回滚、钱包没钱、超过重试上限、超时退款、取消
- 真实链上验证：平台钱包在 Kite 测试网发出 0 pieUSD 转账 `0x46d7cfee46af91bbb20acd429b84238cb812c32f4766c3f64efc664743f5e023`
- Cloudflare Workers 服务骨架（Hono + D1）：`POST /v1/bounties` 用 x402 在 Kite 测试网按悬赏金额收 pieUSD；参数校验在付费之前；结算成功才把悬赏设为 `open`，失败作废
- 管理令牌：发布时返回一次，只存哈希
- 公开接口 `GET /api/bounties`、`GET /api/bounties/:id`、`GET /healthz`
- D1 迁移 `0001_bounties.sql`
- 40 条测试（在 Workers 运行环境里跑，用假 facilitator）；GitHub Actions CI：类型检查、测试、打包
- `src/kite.ts` 原样复用官方模板，`NOTICE` 写明来源；`.dev.vars.example`；`docs/API.md`
- 仓库初始化：README（项目目标与计划，标明尚未实现）、Apache-2.0 许可证、CHANGELOG
- `docs/REFERENCE_STUDY.md`：五个参考仓库与官方模板的研究，写明实际读取范围
- `docs/PROPOSAL.md`：项目提案（用户、场景、KiteAI 关联点、功能、技术方案、验收标准）
