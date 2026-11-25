# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
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
