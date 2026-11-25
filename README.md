# Errandkite

> 让 AI agent 在 Kite 测试网上向真人发小额悬赏：用 x402 付款托管，真人回答，agent 采纳后自动放款，超时自动退款。
>
> AI agents post small bounties to humans on the Kite testnet: escrowed via x402, answered by people, paid out on acceptance, refunded on timeout.

**状态：W1 技术验证中。** 后端的完整悬赏流程（付费发布 → 回答 → 采纳放款 / 超时退款）已实现并有测试；网页和 MCP 工具还没做。真实链上只验证了 402 挑战和平台钱包的转账链路，**真实的付费发布和真实放款还没跑过**，因为拿不到测试网 pieUSD（见下方"测试方式如实说明"）。

## 现在能做什么

| 功能 | 状态 | 说明 |
|---|---|---|
| `POST /v1/bounties` 付费发布悬赏 | ✅ 已实现，有测试 | x402 付费，Kite 测试网 `eip155:2368`，pieUSD；402 挑战里的金额 = 请求里的悬赏金额（18 位小数精确换算） |
| 参数错误不扣款 | ✅ 已实现，有测试 | 校验在付费中间件之前，参数不对直接 400，不发 402、不验证也不结算付款 |
| 结算失败不建悬赏 | ✅ 已实现，有测试 | 悬赏先存为 `pending_payment`，结算成功才变 `open` 并记下交易哈希，失败则作废、不公开 |
| 管理令牌 | ✅ 已实现，有测试 | 发布成功时返回一次，数据库只存 SHA-256 哈希；读取回答、采纳、取消都要用它，没带返回 401，不对返回 403 |
| `GET /api/bounties`、`GET /api/bounties/:id` | ✅ 已实现，有测试 | 公开列表和详情，含回答数和放款 / 退款交易；不含令牌哈希和回答内容 |
| 回答 `POST /api/bounties/:id/answers` | ✅ 已实现，有测试 | 不用登录，填答案和 Kite 测试网收款地址；地址校验 EIP-55 校验和；同一地址每个悬赏只能答一次；每个悬赏最多 50 个回答；到期后不再收 |
| 采纳 + 放款 `POST /api/bounties/:id/accept` | ✅ 已实现，有测试 | 平台钱包把悬赏金额转给被采纳的回答者；并发采纳只放款一次 |
| 取消 `POST /api/bounties/:id/cancel` | ✅ 已实现，有测试 | 没人回答时发布方可提前取消，全额退回付款地址 |
| 超时退款（定时任务，每 5 分钟） | ✅ 已实现，有测试 | 到期未采纳的悬赏退回付款地址；没确认的放款 / 退款也由它继续推进 |
| 网页、MCP 工具、限流 | ⏳ 未开始 | 见 [提案](docs/PROPOSAL.md) 里程碑 |

### 放款为什么不会付两次

每笔放款或退款都是先在本地签好名，**先把交易哈希和签好的交易存进数据库，再发到链上**。之后不管是网络超时、节点没收到还是程序中途出错，重试时发的都是**同一笔已签名交易**：同一个 nonce 在链上只能被用一次，所以最多到账一次。只有在确认"这个 nonce 已被别的交易占用、而我们这笔不在链上"时，才会签一笔新的。连续 5 笔都失败（例如一直回滚）就停下来等人工处理。这些情况在 `test/lifecycle.test.ts` 里逐一有测试。

**测试方式如实说明**：

- 自动化测试（68 条）里的 facilitator 和区块链都是假的（`test/helpers.ts` 的 `FakeFacilitator`、`test/fake-chain.ts` 的 `FakeChain`）。它们证明的是"付款验证 / 结算、放款发送成功或出各种错时，我们的状态和资金流向是对的"，**不证明真实链上结算**。`FakeChain` 只模拟了一条规则：同一个 nonce 只能被一笔交易用掉。
- 真实链上已验证：本地用 `wrangler dev` 连真实 pieverse facilitator，未付费请求返回正确的 402 挑战（2026-11-24）；平台钱包用 `src/chain.ts` 在 Kite 测试网发了一笔 0 pieUSD 的转账，签名、广播、等回执、重发同一笔被链拒绝（nonce 已用）都和预期一致，交易 [`0x46d7cfee…`](https://testnet.kitescan.ai/tx/0x46d7cfee46af91bbb20acd429b84238cb812c32f4766c3f64efc664743f5e023)（2026-11-25）。
- **还没验证**：真实付费发布和真实放款 / 退款金额到账。原因是目前拿不到测试网 pieUSD：faucet.gokite.ai 只发 KITE 和 USDT（这个 USDT 不支持 x402 需要的 EIP-3009）；`kpass` 当前版本不支持 Kite 链，水龙头在正式环境也关了。拿到 pieUSD 后补测。

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

接口说明见 [docs/API.md](docs/API.md)。配置在 `wrangler.jsonc` 的 `vars` 里；`.dev.vars.example` 是本地密钥文件的示例。放款和退款需要平台钱包私钥 `PLATFORM_PRIVATE_KEY`（必须对应 `PAY_TO`，只用测试网钱包）：本地写在 `.dev.vars`，线上用 `wrangler secret put PLATFORM_PRIVATE_KEY`。没配置时采纳和退款会停在 `accepting` / `refunding` 并记录原因，配好后定时任务会接着处理。本地试定时任务：`npx wrangler dev --test-scheduled`，再访问 `http://localhost:8787/__scheduled`。

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
| 采纳后在 Kite 测试网向回答者转账，超时退回付款方 | `src/transfers.ts`（不重复付款的状态机）、`src/chain.ts`（viem 签名 pieUSD 转账）、`src/scheduled.ts`（定时任务）；测试 `test/lifecycle.test.ts` | 已实现；转账链路在测试网实测过（0 金额），真实金额待 pieUSD |
| 用 Kite Passport（`kpass`）作为 agent 的付款方 | 端到端测试 | 受阻：`kpass` 6.13.9 不支持 Kite 链（文档原话 "Kite Chain is not a Passport chain"），改用自写的 x402 付款脚本 |
| 登记到 `gokite-ai/kite-x402-services` 服务目录 | `service.yaml` | 未开始 |

## 技术栈

TypeScript、Hono、Cloudflare Workers、D1、`@x402/hono` + `@x402/evm` 2.32.0、viem。`src/kite.ts` 来自 [gokite-ai/kite-x402-services](https://github.com/gokite-ai/kite-x402-services) 的 typescript-express 模板（Apache-2.0，提交 `893a275`），**一行未改**，来源写在 [NOTICE](NOTICE)；只把模板的 Express 适配层换成了同版本的 `@x402/hono`。

**已知限制**：
- Workers 免费版每次请求只有 10 毫秒 CPU 时间，付费请求和签名转账的实际 CPU 耗时还没在线上测过
- 只支持测试网，配置成主网会拒绝启动
- 回答接口还没有限流
- 平台钱包托管：资金安全依赖私钥保管，之后改链上托管合约
- 同一个平台钱包同时发多笔转账时可能抢同一个 nonce；抢输的一笔会被识别出来重新签名，但会晚一轮定时任务到账

## 文档

- [项目提案](docs/PROPOSAL.md)：目标用户、使用场景、KiteAI 关联点、技术方案、验收标准
- [接口说明](docs/API.md)：已实现的接口、请求响应、错误码
- [参考仓库研究](docs/REFERENCE_STUDY.md)：五个参考仓库的比较和对本项目的结论

## 许可证

[Apache-2.0](LICENSE)
