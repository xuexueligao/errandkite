# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- Cloudflare Workers 服务骨架（Hono + D1）：`POST /v1/bounties` 用 x402 在 Kite 测试网按悬赏金额收 pieUSD；参数校验在付费之前；结算成功才把悬赏设为 `open`，失败作废
- 管理令牌：发布时返回一次，只存哈希
- 公开接口 `GET /api/bounties`、`GET /api/bounties/:id`、`GET /healthz`
- D1 迁移 `0001_bounties.sql`
- 40 条测试（在 Workers 运行环境里跑，用假 facilitator）；GitHub Actions CI：类型检查、测试、打包
- `src/kite.ts` 原样复用官方模板，`NOTICE` 写明来源；`.dev.vars.example`；`docs/API.md`
- 仓库初始化：README（项目目标与计划，标明尚未实现）、Apache-2.0 许可证、CHANGELOG
- `docs/REFERENCE_STUDY.md`：五个参考仓库与官方模板的研究，写明实际读取范围
- `docs/PROPOSAL.md`：项目提案（用户、场景、KiteAI 关联点、功能、技术方案、验收标准）
