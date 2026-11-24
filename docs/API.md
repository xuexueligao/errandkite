# API

> 只列出**已实现**的接口。计划中的接口（回答、采纳、取消等）见 [PROPOSAL.md](PROPOSAL.md) 5.3 节。

所有响应都是 JSON。错误统一是：

```json
{ "error": { "code": "invalid_request", "message": "The bounty is not valid.", "details": [{ "field": "reward_usd", "message": "must be between 0.01 and 1" }] } }
```

| HTTP | `error.code` | 什么时候 |
|---|---|---|
| 400 | `invalid_json` | 请求体不是 JSON |
| 400 | `invalid_request` | 字段不合法，`details` 列出每个字段的问题 |
| 402 | —（x402 格式） | 没付款、付款无效或结算失败，见下文 |
| 404 | `not_found` | 悬赏不存在或未公开，或路由不存在 |
| 500 | `server_misconfigured` | 部署配置有误（例如 `KITE_NETWORK` 不是 testnet） |
| 500 | `activation_failed` | 付款已结算但悬赏没能写成 `open`；响应里有 `bounty_id` 和 `payment_tx`，请保留，用于人工对账 |
| 500 | `internal_error` | 其他未预期错误 |
| 502 | — | facilitator 返回异常（由 `@x402/hono` 生成） |

## `POST /v1/bounties`：发布悬赏（x402 付费）

请求体：

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `question` | string | 是 | 10 到 1000 个字符（按字符数，不按字节） |
| `reward_usd` | string | 是 | 十进制字符串，例如 `"0.10"`；范围由 `MIN_REWARD_USD` / `MAX_REWARD_USD` 决定（默认 0.01 到 1）；**必须是字符串**，避免浮点误差 |
| `ttl_seconds` | integer | 否 | 600 到 259200（10 分钟到 72 小时），默认 86400 |
| `source` | string | 否 | `"agent"`（默认）或 `"manual"`，人工测试请填 `manual`，统计时分开计 |

流程：

1. **校验**：不合法直接返回 400，不会出现 402，也不会验证或结算任何付款。
2. **没带付款**：返回 402，响应头 `PAYMENT-REQUIRED` 是 base64 编码的 x402 v2 付款要求：
   ```json
   {
     "x402Version": 2,
     "accepts": [{
       "scheme": "exact",
       "network": "eip155:2368",
       "amount": "100000000000000000",
       "asset": "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
       "payTo": "0x7ec512bAcF9F3a1EC024F9bC5AbFDA3836ADDEa9",
       "maxTimeoutSeconds": 120,
       "extra": { "name": "pieUSD", "version": "1" }
     }]
   }
   ```
   `amount` = `reward_usd` × 10¹⁸（pieUSD 有 18 位小数），按字符串精确换算。
3. **带 `PAYMENT-SIGNATURE` 重发同一个请求体**：facilitator 验证通过后创建悬赏（状态 `pending_payment`），然后结算。
   - 结算成功：悬赏变为 `open`，返回 **201**，响应头带 `PAYMENT-RESPONSE`：
     ```json
     {
       "id": "bty_…",
       "manage_token": "mt_…",
       "status": "open",
       "reward_usd": "0.10",
       "reward_units": "100000000000000000",
       "expires_at": 1795000000,
       "payer": "0x…",
       "payment_tx": "0x…"
     }
     ```
     **`manage_token` 只返回这一次**，服务端只存它的 SHA-256 哈希。之后读取回答、采纳、取消都要用它（这些接口还没实现）。
   - 结算失败：返回 402，悬赏标为 `void`，不会公开。

## `GET /api/bounties`：公开列表

查询参数：`status`（`open`、`answered`、`accepting`、`paid`、`refunding`、`refunded` 之一，可选）、`limit`（1 到 100，默认 20）、`before`（unix 秒，翻页用，取上一页的 `next_before`）。

```json
{ "bounties": [{ "id": "bty_…", "status": "open", "question": "…", "reward_usd": "0.10", "reward_units": "…", "network": "eip155:2368", "asset": "0x…", "source": "agent", "payer": "0x…", "payment_tx": "0x…", "created_at": 1794913600, "expires_at": 1795000000 }], "next_before": null }
```

`pending_payment` 和 `void` 状态的悬赏永远不会出现在公开接口里。

## `GET /api/bounties/:id`：公开详情

返回 `{ "bounty": { … } }`，字段同列表。不存在或未公开返回 404。

## `GET /healthz`

```json
{ "ok": true, "network": "eip155:2368", "asset": "0x38129cf4…", "asset_symbol": "pieUSD", "pay_to": "0x7ec5…", "min_reward_usd": "0.01", "max_reward_usd": "1" }
```
