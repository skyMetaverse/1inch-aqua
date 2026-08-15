# 1inch-aqua

## 运行环境

脚本基于 Bun 内置的 `node:crypto`、TTY 和文件系统 API，可运行在 macOS、Linux 和 Windows。请使用交互式终端执行：macOS/Linux 可使用 Terminal、iTerm2 等，Windows 可使用 Windows Terminal、PowerShell 或命令提示符；不支持通过管道、CI 或重定向标准输入传入敏感信息。

Windows 不使用 POSIX 的 `0600` 权限位，`.env` 的访问控制由所在目录和文件的 NTFS ACL 决定。请确保该文件仅对当前 Windows 用户可读取。

## 安装

```bash
bun install --frozen-lockfile
```

## 私钥加密

使用以下命令交互式加密私钥：

```bash
bun run encrypt-private-key
```

脚本会以不回显方式读取私钥、加密密码和确认密码。私钥必须是有效的 Ethereum/secp256k1 私钥：可带 `0x` 前缀，后跟恰好 64 位十六进制字符，且不能为零或超出曲线阶数。密码至少 9 个字符，并且必须同时包含小写字母、大写字母、数字和特殊字符，不能包含空白字符。加密使用带随机 16 字节 salt 的 `scrypt`（`N=2^17, r=8, p=1`，约需 128 MiB 内存）派生密钥，并使用 `AES-256-GCM` 加密和认证。结果以 Base58 文本整行写入 `.env`：

```dotenv
ENCRYPTED_PRIVATE_KEY=<Base58 密文>
```

在 macOS/Linux 上，`.env` 会被设置为仅当前用户可读写（`0600`）；Windows 请依赖并检查 NTFS ACL。每次加密都会产生独立 salt，因此预先计算的彩虹表不能跨文件复用；但攻击者拿到 `.env` 后仍可离线猜测弱密码。请使用密码管理器生成的高熵随机密码，建议至少 16 个随机字符。丢失密码后无法恢复私钥。

## 模块调用

其他程序可以导入 `getDecryptedPrivateKey()`，密码仍会以不回显方式交互输入，解密后的规范化私钥只通过内存中的 `Buffer` 返回，不会打印到标准输出或写入文件。调用方使用完后应立即清零：

```typescript
import { getDecryptedPrivateKey } from "./scripts/encrypt-private-key.ts";

const privateKey = await getDecryptedPrivateKey();
try {
  // 将 privateKey 传给需要签名的业务逻辑，不要记录或持久化它。
} finally {
  privateKey.fill(0);
}
```

当前只支持 v2 密文格式；不兼容旧 v1 密文。

## 添加 LP

添加 LP 使用带中文注释的 JSONC 文件。复制 [lp.add.example.jsonc](/Users/syskey/git/1inch-aqua/config/lp.add.example.jsonc) 为 `config/lp.add.jsonc`，填写 ERC20 地址、余额百分比、页面显示费率和单双边范围；完整字段规则见 [config/README.md](/Users/syskey/git/1inch-aqua/config/README.md)。

添加脚本只使用 EMSH `current` 实时价格，以配置 token 顺序作为显示价格方向。价格、百分比、费率和区间全程使用 `bigint` 定点运算，核心交易计算不使用 JavaScript 浮点数。脚本会读取两个 ERC-20 的真实 `decimals`，以 decimals-aware `sqrtPrice` 编码 Aqua 区间；这对 1INCH/WBTC、1INCH/cbBTC、1INCH/USDT 等不同精度代币对是交易安全边界。EMSH 超过 Aqua 的 18 位价格精度时会在边界向下量化并记录舍弃小数；配置百分比和费率等输入仍严格拒绝超精度。交易使用本地解密私钥签名，通过 RPC 的 `eth_sendRawTransaction` 广播。

先执行 dry-run。它会读取实际余额、allowance、current 价格，计算区间并模拟 approve/ship，但不广播交易：

```bash
bun run add-lp config/lp.add.jsonc --dry-run
```

核对 `logs/` 中的价格、区间、投入数量、费率和 strategy hash 后，再真实执行：

```bash
bun run add-lp config/lp.add.jsonc
```

真实执行会在本次投入尚未被现有 allowance 覆盖时尝试 `MAX_UINT256` 授权；确认后以链上实际回读的 allowance 是否覆盖本次投入为准。这样可兼容内部存储小于 `uint256` 或采用无限授权哨兵值的 ERC20。若 ship 失败，已确认的授权会保留，脚本不会自动撤销。

当配置中的仓位数不少于 2 个时，脚本会先完成全部仓位的余额、价格、授权和单笔 `ship` 模拟，按 token 汇总最新余额后，再模拟并广播一笔 Aqua registry `multicall([ship...])`。任一子调用失败时整批回滚，不会出现部分创建；成功后在同一 receipt 中逐策略校验 `Shipped`、`Pushed` 和 `rawBalances`。授权交易仍按顺序确认，尤其是同一 token 的 `approve(0) -> approve(MAX)` 不能并发。multicall raw 广播失败不会自动重发。

## 一键取消全部活跃 LP 仓位

脚本通过 1inch Aqua 网页端的 maker 策略查询接口获取当前钱包的 `open` 仓位。仓位数为 1 时发送单笔 Aqua registry `dock`；不少于 2 时，先预检和模拟所有 dock，再模拟并广播一笔 Aqua registry `multicall([dock...])`。`dock` 只关闭策略的虚拟余额配置，代币始终留在钱包中；脚本不会撤销已有 ERC20 最大授权。

交易在本机用解密私钥签名，RPC 仅接收已签名交易的 `eth_sendRawTransaction` 广播请求，不要求也不使用节点托管账户的 `eth_sendTransaction`。广播层会显式读取 pending nonce、估算 gas，并在每笔签名前从最新链上区块读取 EIP-1559 `baseFeePerGas`；不会调用部分 RPC 不兼容的隐式 `eth_fillTransaction`。若 RPC 返回 `maxPriorityFeePerGas=0`，广播层仅将 priority fee 归一化为 `1 wei`，以兼容拒绝 zero-tip 的节点；不改变 max fee，也不会自动重试 raw 广播。不少于两个仓位的批量 dock/ship 通过单笔 Aqua registry multicall 完成，不依赖 JSON-RPC request batch 的排序语义。因此应使用支持标准 raw transaction 广播的 RPC。

`.env` 除 `ENCRYPTED_PRIVATE_KEY` 外还必须配置可广播交易的 RPC。可选的两项自定义 EIP-1559 上限必须同时填写，单位为 gwei；两项留空时回退到 RPC 估算。`MAX_FEE_PER_GAS_GWEI` 是标准交易 `maxFeePerGas` 的绝对上限，必须覆盖每笔从链上读取的 `baseFeePerGas + MAX_PRIORITY_FEE_PER_GAS_GWEI`，否则脚本拒绝签名和广播。

```dotenv
RPC_URL=https://your-rpc.example
# 例如：请按自身成本上限填写，不要复制示例值作为市场报价。
MAX_FEE_PER_GAS_GWEI=
MAX_PRIORITY_FEE_PER_GAS_GWEI=
```

先运行 dry-run。该模式会查询仓位、校验 `strategyBytes` 哈希、读取链上 `rawBalances` 并模拟每笔 `dock`，但绝不广播交易：

```bash
bun run cancel-all-active-lp --dry-run
```

确认日志中的仓位信息无误后，再执行真实关闭：

```bash
bun run cancel-all-active-lp
```

执行过程会隐藏输入解密密码，在 `logs/` 下生成本次运行日志。日志文件名为 `YYYY-MM-DD HH-mm-ss.SSS.log`，内容格式为 `YYYY-MM-DD HH:mm:ss.SSS [info]: ...`。串行模式下任一仓位预检、模拟、广播、回执、`Docked` 事件或关闭后链上状态复核失败时，立即停止后续仓位；multicall 模式下任一子调用失败会让整笔交易回滚，成功 receipt 后仍逐仓位校验 `Docked` 和 docked `rawBalances`。

为避免把单页查询结果误认为全部仓位，如果查询结果达到接口当前使用的 `limit=100`，脚本会直接停止，不会只关闭前 100 个仓位。关闭成功以链上 receipt、Aqua registry 的 `Docked` 事件以及 `rawBalances` 复核为准，策略查询接口仅用于发现候选仓位。

查看命令帮助：

```bash
bun run cancel-all-active-lp --help
```

## LP 只读价格检查

针对 `1INCH/WBTC`、`1INCH/cbBTC`、`1INCH/USDT`，可以先执行本地只读检查。脚本要求显式传入 maker 地址，不读取或解密私钥；只查询 RPC 的链上 `decimals`、余额、allowance、Aqua `rawBalances`，以及 EMSH current 和官方 Pair/策略 API。它不会调用交易模拟，不会发送 `approve`、`dock`、`ship` 或 `eth_sendRawTransaction`。

```bash
bun run check-lp-prices --maker 0x01162202AC4A4C686FE95B946E4833b8869CF961 config/lp.add.jsonc
```

日志会分别输出三个交易对的链上余额和计划投入 raw amount、EMSH current、配置价格区间、decimals-aware `sqrtPriceMin/Max`、sqrt 回读量化误差、Pair 市场交叉价格，以及已有 active 策略的 Aqua raw balance 和区间。只有三个目标 pair 都完成只读检查后才会正常退出；任一 sqrt 区间不能表达，或 Pair/EMSH 偏差超过该仓位最窄单侧宽度时都会失败退出，禁止将该次快照用于真实资金建仓。

## 自动再平衡 Bot

Bot 监控 1inch 官方策略 API 返回的当前 maker 全部受支持 active concentrated 仓位，以策略 API 的 `currentBalance` 判断当前资产状态，以 EMSH current 计算新的 5 bp 区间。Pair API 的 `volumeUsd` 仅记录为观察数据；自动重挂仍要求 Pair 最少 swaps 和 Pair/EMSH 价格交叉校验。它不提供 `--dry-run`：解密私钥后会持续运行，并在满足连续越界、冷却期和上述价格安全条件时自动执行 `dock -> ship`。

先创建本地运行配置：

```bash
cp config/rebalance.example.jsonc config/rebalance.jsonc
```

再使用交互式终端启动：

```bash
bun run rebalance-bot config/rebalance.jsonc
```

Bot 只自动处理当前 SDK 支持的两 token concentrated 策略。API 分页未确认、价格源偏离过大、API 快照与链上预检不一致或任一交易失败时，该仓位会停止自动处理并写中文日志；同一 pair 的多个 active strategyHash 会分别监控、分别决策、分别保存状态。计划使用 decimals-aware `sqrtPrice` 持久化与恢复；旧 v1 rawPrice 状态文件会被拒绝，不能在未人工审计的情况下恢复自动交易。`dock` 已确认但 `ship` 未完成时，状态文件会保存同一策略计划，进程重启后优先恢复，避免重新生成冲突仓位。完整策略、恢复和风险边界见 [Aqua自动再平衡Bot开发设计.md](/Users/syskey/git/1inch-aqua/docs/Aqua自动再平衡Bot开发设计.md)。

运行回归测试：

```bash
bun test
```

## 运行

```bash
bun run index.ts
```
