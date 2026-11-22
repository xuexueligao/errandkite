# 参考仓库研究

> 按《KiteAI 第二期开发者参与指南》要求，在设计 Errandkite 之前，先阅读第二期指定的五个仓库，比较功能完整度、代码组织、运行方式和质量检查，再提出方案。本文只记录**实际读到的内容**，读取范围写在每节开头。
>
> 阅读时间：2026-11-22。阅读方式：AI 辅助（Claude）在本地克隆后读源码，由我本人审阅。

## 0. 读取范围总表

| 仓库 | 版本 | 规模（源码文件 / 行数，约） | 实际读了什么 | 没读的 |
|---|---|---|---|---|
| [CarryWang/kite-x402-explorer](https://github.com/CarryWang/kite-x402-explorer) | `9cfcda6`（2026-11-21） | 152 / 23,000 | 目录结构、`package.json` 脚本、CI、`server/mock-settlement.ts`、`src/types/probe.ts` 与 `proof.ts` 的证据类型；模块引用关系（脚本统计）。我在任务一中向它贡献过代码，读过签名示例和 Manifest 生成器相关模块 | 大部分 React 组件、`src/lib` 下多数工具模块 |
| kite-x402-hono | `31f6425`（2026-11-21） | 102 / 11,200 | `src/app.ts`（支付接线部分）、`src/networks.ts`、`src/payment-protection.ts` 开头、`nonce-guard.ts` 与 `idempotency.ts` 的接口和注释、`NOTICE`、`package.json`、测试文件清单；模块引用关系（脚本统计） | 多数中间件实现、56 个测试文件的具体内容 |
| kite-x402-axum | `6b16f3c`（2026-11-21） | 49 / 17,200 | `README.md`、`middleware.rs` 中验证与结算逻辑、`settlement_ledger.rs` 开头、`.github/workflows/ci.yml`、文件清单 | `facilitator.rs`、`proxy.rs`、`service/src/main.rs` 全文、e2e 测试全文 |
| kite-agent-zk-attestation | `f8f40f6`（2026-11-21） | 26 / 1,700 | `src/attestation.ts` 全文、`contracts/KiteAgentZKAttestation.sol` 前 80 行、`contracts/MockGroth16Verifier.sol` 全文、一个 `active_telemetry_*.ts` 全文、`package.json` | 其余 `src` 模块、测试文件内容 |
| gokite-ai/kite_counter_dapp | `42e33d7`（2026-11-10） | 24 个 src 文件 | `contracts/Counter.sol` 全文、`src/kite-network.*`、`src/App.jsx` 中合约交互部分、`useBatchCounterSimulation.ts` 开头、`package.json`、`README.md`；模块引用关系（脚本统计） | 各 UI 组件实现 |

另外读了 Kite 官方的 [gokite-ai/kite-x402-services](https://github.com/gokite-ai/kite-x402-services)（`893a275`，2026-09-11）：`templates/typescript-express/src/kite.ts` 全文和 `index.ts` 的支付接线部分；以及 [gokite-ai/passport-skills](https://github.com/gokite-ai/passport-skills) 中 `kite-discovery`、`x402-execute`、`activity` 三个技能的说明。

**没有运行**任何一个仓库的测试或构建，下文对测试和 CI 的判断来自读配置和文件清单，不是运行结果。

## 1. 逐个仓库

### 1.1 kite-x402-explorer（TypeScript + React + Express）

- **做什么**：浏览 Kite x402 服务目录，探测服务、生成接入代码和登记文件
- **运行方式**：`vite` 前端 + `tsx server/index.ts` 后端，`dev:all` 同时启动；有 Dockerfile 和 nginx 配置；`test:production` 冒烟脚本
- **质量检查**：47 个测试文件（`node --test`），CI 跑测试、构建和 Docker 冒烟
- **值得学**
  - **证据分级**：模拟结果显式标 `simulated: true, settledOnChain: false`（`server/mock-settlement.ts`），探测结果区分 `observed` 和不可用。Errandkite 会照这个思路给每个悬赏标"agent 发布 / 人工测试"，给每笔资金动作标是否已上链
- **不学**
  - 97 个前端源码模块里有 10 个没有被任何地方引用（脚本按文件名统计，可能有少量误差）：做了但没接入页面的原型模块

### 1.2 kite-x402-hono（Bun + Hono 反向代理，v0.7.0）

- **做什么**：把任意上游 API 包成 x402 付费接口，在 Kite 上结算
- **运行方式**：`bun src/cli.ts`；`npm run check` = 类型检查 + 测试 + 构建；发布 npm 包
- **质量检查**：56 个测试文件，含大量回归测试（`pr-52-61-regressions.test.ts` 等），格式检查用 prettier
- **值得学**
  - **它用的就是 `@x402/hono`**（2.29.0）+ `ExactEvmScheme` + `HTTPFacilitatorClient`，证明 Hono 版 x402 中间件能接 Kite 测试网和 pieverse facilitator。Errandkite 计划的技术路线有了先例
  - **`NOTICE` 文件**写明从官方仓库改编了哪些内容，并钉住上游版本号 `893a275…`。Errandkite 复用 `kite.ts` 时照此做
  - 网络常量（chainId、pieUSD 合约地址、18 位小数、EIP-712 name/version）和精确价格换算（字符串拼接成 BigInt，不用浮点）
  - 防重放（payer + nonce）、幂等键、请求体大小限制、并发上限返回 503
- **不学 / 要注意**
  - 主流程 `app.ts` 只引用 10 个模块，另有约 29 个模块只从 `index.ts` 导出，没有接入代理主流程（如 `tiered-fee-scheduler`、`traffic-shaper`、`brotli-compression`）。功能清单很长，但不少没在实际运行路径上
  - 防重放和幂等缓存都存在**进程内存**。Errandkite 跑在 Cloudflare Workers 上，请求可能落到不同实例，内存状态不可靠，**这类状态必须存 D1**
  - 用了 `node:async_hooks`、`node:crypto`，在 Workers 上需要 `nodejs_compat`

### 1.3 kite-x402-axum（Rust workspace）

- **做什么**：与 hono 相同的反向代理，Rust 实现；库 crate 已发布 crates.io
- **运行方式**：`cargo run`；`docker compose` 一键起
- **质量检查**：CI 最完整：rustfmt、clippy（`-D warnings`）、单元 + 集成 + e2e 测试、MSRV 检查、rustdoc、`cargo package`、Python 客户端脚本测试、docker compose 冒烟（含"缺配置必须启动失败"的检查）；另有 `cargo deny` 依赖审计
- **值得学**
  - **"上游成功才结算"写得最清楚**：上游返回 ≥400 时跳过结算，买家不被扣款（`middleware.rs` 约 401–425 行）。Errandkite 的"发布参数非法不扣款"照此验收
  - CI 里测"缺配置必须启动失败"，Errandkite 的配置检查也要有对应测试
  - 依赖审计（Errandkite 用 `npm audit` 对应）
- **不学**
  - 一个 Rust 仓库的 `src/modules/` 下有 8 个 `active_telemetry_<日期>.ts`，与项目无关，内容是写死的指标。这是为了制造提交记录的文件，指南明确禁止
  - 结算台账 `settlement_ledger.rs` 是内存实现，重启即丢

### 1.4 kite-agent-zk-attestation（TypeScript + Solidity）

- **做什么**：对 agent 执行结果做零知识证明、在 Kite 链上锚定
- **运行方式**：`tsc` 构建、`vitest` 测试、`node --test` 跑合约测试（ganache + solc）
- **质量检查**：11 个测试文件；**没有 CI**
- **值得学**
  - 用 zod 校验输入；网络配置校验拒绝带用户名密码的 URL
  - 异步验证完成后**再查一次 epoch**，防并发下的回退（`attestation.ts`）。Errandkite 的"采纳放款"同样要在写库前再检查一次状态，防重复放款
  - 合约用两步转移所有权、自定义 error
  - 合约注释给出 Kite 主网 chainId 2366、测试网 2368
- **不学**
  - 链上验证器是 `MockGroth16Verifier`（`shouldPass` 开关），README 名为 ZK，实际没有真实证明验证
  - epoch 记录存在内存 `Map`，重启即丢
  - `src/modules/` 下 5 个 `active_telemetry_<日期>.ts`，内容是写死的会话和 `Math.random()` 延迟，与 axum 同类

### 1.5 kite_counter_dapp（React + ethers，官方示例）

- **做什么**：Kite 测试网上的计数器合约 + 前端
- **运行方式**：`npm install && npm run dev`
- **质量检查**：只有 eslint 配置；**没有测试、没有 CI**
- **值得学**
  - Kite 测试网接入参数：chainId 2368、RPC `https://rpc-testnet.gokite.ai/`、浏览器 `https://testnet.kitescan.ai`、原生币 KITE（18 位小数）。Errandkite 放款时平台钱包需要 KITE 付 gas
  - 切换网络前检查 chainId
- **不学**
  - `node_modules/`（约 7,600 个文件）和 `dist/` 构建产物提交进了仓库
  - 20 个源码模块里有 16 个没有被引用

### 1.6 官方模板 kite-x402-services / typescript-express

- `kite.ts`（81 行）只依赖 `@x402/core/types`，定义 Kite 主网和测试网参数、facilitator 地址 `https://facilitator.pieverse.io/v2`、按网络名选链、以及把 `"$0.001"` 换算成 pieUSD 最小单位的价格解析器
- `index.ts`（100 行）用 `@x402/express` 把 `/v1/*` 包成**单一固定价格**的付费代理，上游返回非错误状态才结算

## 2. 横向比较

| | explorer | hono | axum | zk-attestation | counter_dapp |
|---|---|---|---|---|---|
| 功能是否端到端 | 是（含模拟模式，有标注） | 是 | 是 | 否（验证器是 Mock） | 是（最简） |
| 代码组织 | 前后端分目录；有未接入模块 | 平铺 `src/`；不少模块未接入主流程 | 库 + 服务两个 crate，最清楚 | 小而清楚；混入刷量文件 | 有大量未引用组件 |
| 一键运行 | `dev:all` / Docker | `bun` / npm 包 | `cargo run` / compose | `npm test` | `npm run dev` |
| 测试 | 47 文件 | 56 文件 | 单元 + 集成 + e2e | 11 文件 | 无 |
| CI | 测试 + 构建 + Docker 冒烟 | 有 | 最完整（含依赖审计） | 无 | 无 |
| 文档 | ARCHITECTURE、ROADMAP | 中英 README、CHANGELOG、CONTRIBUTING、SECURITY、NOTICE | README、CHANGELOG | 4 篇格式文档 | README |
| 状态持久化 | — | 内存 | 内存 | 内存 | 链上 |

## 3. 对 Errandkite 的结论

1. **照 hono 的方式接 x402**：`@x402/hono` + `ExactEvmScheme` + `HTTPFacilitatorClient`，`kite.ts` 原样复用，加 `NOTICE` 钉住上游版本
2. **照 axum 的方式定结算规则和 CI**：失败不扣款；CI 包含格式、类型检查、测试、构建、依赖审计、"缺配置必须失败"
3. **照 explorer 的方式标注证据**：每个悬赏和每笔资金动作都写明来源和是否上链
4. **状态全部持久化**：五个仓库里四个把关键状态放内存。Errandkite 涉及托管资金，悬赏、付款、放款、退款、防重放记录都存 D1，状态变更要在写库时检查，防并发重复放款
5. **不做的事**：不提交刷量文件、构建产物、`node_modules`；不写没有接入主流程的模块；不把 Mock 当真实能力宣传
6. **官方模板只支持固定价格**，悬赏金额却每次不同。设计上要解决，见 [PROPOSAL.md](PROPOSAL.md) 第 5 节
