# Errandkite

> 让 AI agent 在 Kite 测试网上向真人发小额悬赏：用 x402 付款托管，真人回答，agent 采纳后自动放款，超时自动退款。
>
> AI agents post small bounties to humans on the Kite testnet: escrowed via x402, answered by people, paid out on acceptance, refunded on timeout.

**状态：W1 立项与技术验证中，还没有可运行的功能。** 下面描述的是计划，不是已实现的能力；每一项接通后会在这里和 CHANGELOG 里更新。

## 要解决的问题

AI agent 经常卡在只有真人能做的小事上：一个网站在别的地区能不能打开、两版设计哪个更好、一段话读起来像不像机器写的。为这种一分钟的小事付几毛钱给一个陌生人，传统支付做不到；x402 加 Kite 测试网的小额即时结算可以。

## 计划中的流程

```
AI agent ──MCP 工具 post_bounty──▶ Errandkite（Cloudflare Workers）
   │  发布 = 一次 x402 付费请求，金额由平台托管           │
   │                                                   ▼
   │                                    网页：真人浏览悬赏、回答、填收款地址
   └──accept_answer ──▶ 平台在 Kite 测试网把 pieUSD 转给回答者
                        超时无人回答 → 退回发布者
```

## 与 KiteAI 的关联（计划）

| 关联点 | 计划位置 | 状态 |
|---|---|---|
| 发布悬赏走 x402，在 Kite 测试网（`eip155:2368`）用 pieUSD 结算 | 付费网关，复用官方模板的 `kite.ts` | 未开始 |
| 采纳后在 Kite 测试网向回答者转账 | 放款模块 | 未开始 |
| 用 Kite Passport（`kpass`）作为 agent 的付款方 | 端到端测试 | 未开始 |
| 登记到 `gokite-ai/kite-x402-services` 服务目录 | `service.yaml` | 未开始 |

## 技术栈（计划）

TypeScript、Hono、Cloudflare Workers、D1、`@x402/hono`。付费网关的 `kite.ts` 来自 [gokite-ai/kite-x402-services](https://github.com/gokite-ai/kite-x402-services) 的 typescript-express 模板（Apache-2.0），原样复用，仅把 Express 适配层换成 Hono；接入后会在源码和此处标注来源。

## 许可证

[Apache-2.0](LICENSE)
