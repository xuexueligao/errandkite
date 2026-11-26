# API

> 只列出**已实现**的接口。还没做的（MCP 工具）见 [PROPOSAL.md](PROPOSAL.md) 5.4 节。

所有响应都是 JSON。错误统一是：

```json
{ "error": { "code": "invalid_request", "message": "The bounty is not valid.", "details": [{ "field": "reward_usd", "message": "must be between 0.01 and 1" }] } }
```

| HTTP | `error.code` | 什么时候 |
|---|---|---|
| 400 | `invalid_json` | 请求体不是 JSON |
| 400 | `invalid_request` | 字段不合法，`details` 列出每个字段的问题 |
| 402 | —（x402 格式） | 没付款、付款无效或结算失败，见下文 |
| 401 | `unauthorized` | 发布方接口没带 `Authorization: Bearer mt_…` |
| 403 | `forbidden` | 管理令牌和这个悬赏不匹配（悬赏不存在也返回 403，避免用来探测 ID） |
| 404 | `not_found` | 悬赏或回答不存在、未公开，或路由不存在 |
| 409 | `bounty_closed` | 悬赏已到期或已结束，不再收回答 |
| 409 | `duplicate_answer` | 这个地址已经回答过这个悬赏 |
| 409 | `too_many_answers` | 这个悬赏的回答已到上限（50） |
| 409 | `bounty_expired` | 采纳时悬赏已到期，会被退款 |
| 409 | `bounty_not_acceptable` | 悬赏不在可采纳状态（例如已经采纳过） |
| 409 | `bounty_not_cancellable` | 只有还没人回答的 `open` 悬赏能取消 |
| 429 | `rate_limited` | 回答太频繁；响应头 `Retry-After` 和 `details.retry_after` 是要等的秒数 |
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
     **`manage_token` 只返回这一次**，服务端只存它的 SHA-256 哈希。之后读取回答、采纳、取消都要用它。
   - 结算失败：返回 402，悬赏标为 `void`，不会公开。

## `GET /api/bounties`：公开列表

查询参数：`status`（`open`、`answered`、`accepting`、`paid`、`refunding`、`refunded` 之一，可选）、`limit`（1 到 100，默认 20）、`before`（unix 秒，翻页用，取上一页的 `next_before`）。

```json
{ "bounties": [{ "id": "bty_…", "status": "paid", "question": "…", "reward_usd": "0.10", "reward_units": "…", "network": "eip155:2368", "asset": "0x…", "source": "agent", "payer": "0x…", "payment_tx": "0x…", "created_at": 1794913600, "expires_at": 1795000000, "answer_count": 2, "payout_tx": "0x…", "payout_to": "0x…", "refund_tx": null }], "next_before": null }
```

- `payout_tx` / `payout_to`：状态是 `accepting` 或 `paid` 时有值。`accepting` 时交易可能还没上链，以 `paid` 为准
- `refund_tx`：状态是 `refunding` 或 `refunded` 时有值，退款收款方就是 `payer`
- 回答的内容不在公开接口里，只有 `answer_count`

`pending_payment` 和 `void` 状态的悬赏永远不会出现在公开接口里。

## `GET /api/bounties/:id`：公开详情

返回 `{ "bounty": { … } }`，字段同列表。不存在或未公开返回 404。

## `GET /healthz`

```json
{ "ok": true, "network": "eip155:2368", "asset": "0x38129cf4…", "asset_symbol": "pieUSD", "pay_to": "0x7ec5…", "min_reward_usd": "0.01", "max_reward_usd": "1" }
```

## `POST /api/bounties/:id/answers`：回答（公开，不用登录）

```json
{ "answer": "Yes, it loads in about 2 seconds on 4G in São Paulo.", "payout_address": "0x…" }
```

| 字段 | 规则 |
|---|---|
| `answer` | 1 到 2000 个字符 |
| `payout_address` | Kite 测试网地址。大小写混合时必须通过 EIP-55 校验和（防手误）；不能是零地址或平台钱包 |

返回 **201** `{ "answer": { "id": "ans_…", "bounty_id": "bty_…", "payout_address": "0x…（校验和格式）", "created_at": … } }`。第一个回答会把悬赏从 `open` 变成 `answered`。同一地址对同一悬赏只能答一次（不分大小写）；到期后返回 409 `bounty_closed`，即使定时任务还没跑。

**限流**（状态存 D1，不存内存）：

| 维度 | 上限 | 说明 |
|---|---|---|
| 客户端 IP（`CF-Connecting-IP`） | 10 分钟 10 个 | Cloudflare 线上总会带这个头；本地没有这个头时只按地址限 |
| 收款地址（跨所有悬赏） | 1 小时 20 个 | 不分大小写 |

只有成功提交的回答才计数，被拒绝的（400、409）不算。超限返回 429 `rate_limited`。数据库里只存 IP 和地址的 SHA-256 哈希，定时任务删除一天以前的记录。检查和计数是两步，同时并发的请求可能多放过几个；这是防刷，不涉及资金。

## 发布方接口（要管理令牌）

请求头：`Authorization: Bearer mt_…`

### `GET /api/bounties/:id/answers`

```json
{ "bounty_status": "answered", "accepted_answer_id": null, "answers": [{ "id": "ans_…", "answer": "…", "payout_address": "0x…", "created_at": 1794913700, "accepted": false }] }
```

### `POST /api/bounties/:id/accept`

请求体 `{ "answer_id": "ans_…" }`。只能在 `answered` 状态、到期之前采纳，只能采纳一次。

服务端把悬赏设为 `accepting`，然后从平台钱包把 `reward_units` 的 pieUSD 转给这个回答的 `payout_address`，最多等 20 秒回执：

- 已确认：返回 `{ "bounty": { "status": "paid", "payout_tx": "0x…", … } }`
- 还没确认或出错：返回 `"status": "accepting"`，`transfer_error` 写原因；定时任务会继续推进，用 `GET /api/bounties/:id` 查结果

### `POST /api/bounties/:id/cancel`

只能取消还没人回答的 `open` 悬赏。悬赏变为 `refunding`，全额退回 `payer`，响应格式同采纳（`refunded` 或 `refunding`）。

## `GET /api/stats`：公开统计和托管对账

```json
{
  "network": "eip155:2368", "asset": "0x38129cf4…", "asset_symbol": "pieUSD", "escrow_address": "0x7ec5…", "generated_at": 1795705224,
  "bounties": { "total": 3, "by_source": { "agent": 2, "manual": 1 }, "by_status": { "open": 1, "answered": 0, "accepting": 0, "paid": 1, "refunding": 0, "refunded": 1 }, "accepted": 1, "refunded": 1 },
  "answers": { "total": 1, "distinct_answerers": 1 },
  "distinct_payers": 1,
  "median_seconds_to_first_answer": 90,
  "escrow": {
    "status": "ok",
    "received": { "units": "300000000000000000", "usd": "0.3" },
    "paid_out": { "units": "100000000000000000", "usd": "0.1" },
    "refunded": { "units": "100000000000000000", "usd": "0.1" },
    "held": { "units": "100000000000000000", "usd": "0.1" },
    "in_flight": { "units": "0", "usd": "0" },
    "wallet_balance": { "units": "100000000000000000", "usd": "0.1" },
    "gas_balance_wei": "499731103113000000",
    "gas_low": false
  }
}
```

- 只统计付款已结算的悬赏（作废的、没付成的不算）。`by_source` 把 agent 发布和人工测试分开
- `held` = 还在托管里的钱 = `received` − `paid_out` − `refunded`，按 bigint 精确相加（18 位小数的金额超过约 9 pieUSD 就会超出 SQLite 整数范围，所以不在 SQL 里求和）
- `wallet_balance` 是平台钱包在链上的 pieUSD 余额。`escrow.status`：
  - `ok`：钱包余额 ≥ `held`
  - `settling`：差额不超过 `in_flight`（已签名、可能已上链但还没记账的放款或退款），定时任务会补上
  - `short`：钱少了，需要人工处理
  - `unknown`：链上余额没读到（RPC 超时等）
- `gas_low`：钱包的 KITE 少于 0.01，放款和退款可能付不起 gas
- 每个 Worker 实例缓存 30 秒（`Cache-Control: public, max-age=30`），因为要读两次 RPC

## 定时任务（每 5 分钟）

1. `open` / `answered` 且已过 `expires_at` 的悬赏 → `refunding`，退款对象是 `payer`
2. 推进所有 `accepting` / `refunding` 的转账，每次最多 10 个
3. 删除一天以前的限流记录
4. 托管对账：和 `/api/stats` 的 `escrow` 同样的检查，每次都写一条 `escrow_check` 日志；`short` 或 `gas_low` 用 error 级别，`settling` / `unknown` 用 warn 级别

### 转账怎么保证只到账一次

每个悬赏最多对应一笔有效转账，记录在 `transfer_tx` / `transfer_raw`：

1. 签名后**先**把交易哈希和签名后的原始交易写进数据库，再广播。两个请求同时签名时，只有先写入的那个会广播
2. 链上查不到这笔交易：重发**同一笔**原始交易（同一个 nonce，最多被打包一次）
3. 重发时链返回 nonce 已用，而且我们这笔仍查不到：说明它永远不会上链，才丢弃并重新签名
4. 交易回滚：算一次失败，重新签名。累计 5 次后停止，`transfer_error` 写明需要人工处理
