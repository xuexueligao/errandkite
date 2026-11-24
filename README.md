# Errandkite

> 让 AI agent 在 Kite 测试网上向真人发小额悬赏：用 x402 付款托管，真人回答，agent 采纳后自动放款，超时自动退款。
>
> AI agents post small bounties to humans on the Kite testnet: escrowed via x402, answered by people, paid out on acceptance, refunded on timeout.

**状态：W1 技术验证中。** 已实现并有测试的只有"付费发布悬赏"和公开查询（见下方"现在能做什么"）。回答、采纳、放款、退款、网页、MCP 工具都还没做；每一项接通后会在这里和 CHANGELOG 里更新。

## 现在能做什么

| 功能 | 状态 | 说明 |
|---|---|---|
| `POST /v1/bounties` 付费发布悬赏 | ✅ 已实现，有测试 | x402 付费，Kite 测试网 `eip155:2368`，pieUSD；402 挑战里的金额 = 请求里的悬赏金额（18 位小数精确换算） |
| 参数错误不扣款 | ✅ 已实现，有测试 | 校验在付费中间件之前，参数不对直接 400，不发 402、不验证也不结算付款 |
| 结算失败不建悬赏 | ✅ 已实现，有测试 | 悬赏先存为 `pending_payment`，结算成功才变 `open` 并记下交易哈希，失败则作废、不公开 |
| 管理令牌 | ✅ 已实现，有测试 | 发布成功时返回一次，数据库只存 SHA-256 哈希；读取回答、采纳、取消要用它（这些接口还没做） |
| `GET /api/bounties`、`GET /api/bounties/:id` | ✅ 已实现，有测试 | 公开列表和详情，不含令牌哈希 |
| 回答、采纳、放款、超时退款、网页、MCP 工具 | ⏳ 未开始 | 见 [提案](docs/PROPOSAL.md) 里程碑 |

**测试方式如实说明**：自动化测试里的 facilitator 是假的（`test/helpers.ts` 的 `FakeFacilitator`），付款签名也是占位值，所以测试证明的是"我们的接口在付款验证 / 结算成功或失败时行为正确"，**不证明真实链上结算**。本地用 `wrangler dev` 连真实的 pieverse facilitator 时，未付费请求会返回正确的 402 挑战（2026-11-24 实测）；真实付款结算还没测，要等测试币和 `kpass`。

## 本地运行

需要 Node.js 22+。

```bash
npm install
npm run db:migrate:local   # 建本地 D1 表
npm run dev                # http://localhost:8787
npm run typecheck
npm test                   # 在 Workers 运行环境（Miniflare）里跑，含本地 D1
```

试一下（未付费，应返回 402，响应头 `PAYMENT-REQUIRED` 是 base64 编码的付款要求）：

```bash
curl -i -X POST http://localhost:8787/v1/bounties   -H 'content-type: application/json'   -d '{"question":"Does example.com load on your phone?","reward_usd":"0.10"}'
```

接口说明见 [docs/API.md](docs/API.md)。配置在 `wrangler.jsonc` 的 `vars` 里；`.dev.vars.example` 是本地密钥文件的示例。

## 要解决的问题

AI agent 经常卡在只有真人能做的小事上：一个网站在别的地区能不能打开、两版设计哪个更好、一段话读起来像不像机器写的。为这种一分钟的小事付几毛钱给一个陌生人，传统支付做不到；x402 加 Kite 测试网的小额即时结算可以。

## 完整流程（计划）

```
AI agent ──MCP 工具 post_bounty──▶ Errandkite（Cloudflare Workers）
   │  发布 = 一次 x402 付费请求，金额由平台托管           │
   │                                                   ▼
   │                                    网页：真人浏览悬赏、回答、填收款地址
   └──accept_answer ──▶ 平台在 Kite 测试网把 pieUSD 转给回答者
                        超时无人回答 → 退回发布者
```

## 与 KiteAI 的关联

| 关联点 | 计划位置 | 状态 |
|---|---|---|
| 发布悬赏走 x402，在 Kite 测试网（`eip155:2368`）用 pieUSD 结算 | `src/app.ts`（`@x402/hono` 付费中间件 + 按悬赏金额定价）、`src/kite.ts`（官方模板原样复用）；测试 `test/bounties.test.ts` | 402 挑战已实现并实测；真实结算待测 |
| 采纳后在 Kite 测试网向回答者转账 | 放款模块 | 未开始 |
| 用 Kite Passport（`kpass`）作为 agent 的付款方 | 端到端测试 | 未开始 |
| 登记到 `gokite-ai/kite-x402-services` 服务目录 | `service.yaml` | 未开始 |

## 技术栈

TypeScript、Hono、Cloudflare Workers、D1、`@x402/hono` + `@x402/evm` 2.32.0、viem。`src/kite.ts` 来自 [gokite-ai/kite-x402-services](https://github.com/gokite-ai/kite-x402-services) 的 typescript-express 模板（Apache-2.0，提交 `893a275`），**一行未改**，来源写在 [NOTICE](NOTICE)；只把模板的 Express 适配层换成了同版本的 `@x402/hono`。

**已知限制**：Workers 免费版每次请求只有 10 毫秒 CPU 时间，付费请求的实际 CPU 耗时还没在线上测过；只支持测试网，配置成主网会拒绝启动。

## 文档

- [项目提案](docs/PROPOSAL.md)：目标用户、使用场景、KiteAI 关联点、技术方案、验收标准
- [接口说明](docs/API.md)：已实现的接口、请求响应、错误码
- [参考仓库研究](docs/REFERENCE_STUDY.md)：五个参考仓库的比较和对本项目的结论

## 许可证

[Apache-2.0](LICENSE)
