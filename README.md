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

添加脚本只使用 EMSH `current` 实时价格，以配置 token 顺序作为显示价格方向。价格、百分比、费率和区间全程使用 `bigint` 定点运算，核心交易计算不使用 JavaScript 浮点数。EMSH 超过 Aqua 的 18 位价格精度时会在边界向下量化并记录舍弃小数；配置百分比和费率等输入仍严格拒绝超精度。交易使用本地解密私钥签名，通过 RPC 的 `eth_sendRawTransaction` 广播。

先执行 dry-run。它会读取实际余额、allowance、current 价格，计算区间并模拟 approve/ship，但不广播交易：

```bash
bun run add-lp config/lp.add.jsonc --dry-run
```

核对 `logs/` 中的价格、区间、投入数量、费率和 strategy hash 后，再真实执行：

```bash
bun run add-lp config/lp.add.jsonc
```

真实执行会在本次投入尚未被现有 allowance 覆盖时尝试 `MAX_UINT256` 授权；确认后以链上实际回读的 allowance 是否覆盖本次投入为准。这样可兼容内部存储小于 `uint256` 或采用无限授权哨兵值的 ERC20。若 ship 失败，已确认的授权会保留，脚本不会自动撤销。

当配置中的仓位数超过 2 个时，脚本会先完成全部仓位的余额、价格、授权和 `ship` 模拟，再为每笔 `ship` 分配连续 nonce 并按 nonce 顺序流水线提交本地签名的 `eth_sendRawTransaction`，不等待前一笔区块确认。这会减少“逐笔确认后再发送”的等待，但链上仍是多笔独立交易，并逐笔等待回执、校验事件和 `rawBalances`。授权交易仍按顺序确认，尤其是同一 token 的 `approve(0) -> approve(MAX)` 不能并发。任一 raw 交易提交失败时停止后续 nonce；已成功 hash 会先完成复核，且不会自动重发。

## 一键取消全部活跃 LP 仓位

脚本通过 1inch Aqua 网页端的 maker 策略查询接口获取当前钱包的 `open` 仓位，再对每个仓位串行发送 Aqua registry 的 `dock` 交易。`dock` 只关闭策略的虚拟余额配置，代币始终留在钱包中；脚本不会撤销已有 ERC20 最大授权。

交易在本机用解密私钥签名，RPC 仅接收已签名交易的 `eth_sendRawTransaction` 广播请求，不要求也不使用节点托管账户的 `eth_sendTransaction`。广播层会显式读取 pending nonce、估算 gas 和 EIP-1559 fee，再本地签名 raw transaction；不会调用部分 RPC 不兼容的隐式 `eth_fillTransaction`。多笔连续 nonce 交易也不依赖 RPC 的 JSON-RPC request batch 排序语义。因此应使用支持标准 raw transaction 广播的 RPC。

`.env` 除 `ENCRYPTED_PRIVATE_KEY` 外还必须配置可广播交易的 RPC：

```dotenv
RPC_URL=https://your-rpc.example
```

先运行 dry-run。该模式会查询仓位、校验 `strategyBytes` 哈希、读取链上 `rawBalances` 并模拟每笔 `dock`，但绝不广播交易：

```bash
bun run cancel-all-active-lp --dry-run
```

确认日志中的仓位信息无误后，再执行真实关闭：

```bash
bun run cancel-all-active-lp
```

执行过程会隐藏输入解密密码，在 `logs/` 下生成本次运行日志。日志文件名为 `YYYY-MM-DD HH-mm-ss.SSS.log`，内容格式为 `YYYY-MM-DD HH:mm:ss.SSS [info]: ...`。脚本逐仓位串行关闭；任一仓位预检、模拟、广播、回执、`Docked` 事件或关闭后链上状态复核失败时，立即停止后续仓位。

为避免把单页查询结果误认为全部仓位，如果查询结果达到接口当前使用的 `limit=100`，脚本会直接停止，不会只关闭前 100 个仓位。关闭成功以链上 receipt、Aqua registry 的 `Docked` 事件以及 `rawBalances` 复核为准，策略查询接口仅用于发现候选仓位。

查看命令帮助：

```bash
bun run cancel-all-active-lp --help
```

## 自动再平衡 Bot

Bot 监控 1inch 官方策略 API 返回的当前 maker 全部受支持 active concentrated 仓位，以策略 API 的 `currentBalance` 判断当前资产状态，以 Pair API 判断市场活跃度，以 EMSH current 计算新的 5 bp 区间。它不提供 `--dry-run`：解密私钥后会持续运行，并在满足连续越界、冷却期、市场活跃度和价格交叉校验条件时自动执行 `dock -> ship`。

先创建本地运行配置：

```bash
cp config/rebalance.example.jsonc config/rebalance.jsonc
```

再使用交互式终端启动：

```bash
bun run rebalance-bot config/rebalance.jsonc
```

Bot 只自动处理当前 SDK 支持的两 token concentrated 策略。API 分页未确认、同一 pair 有多条活跃策略、价格源偏离过大、API 快照与链上预检不一致或任一交易失败时，该仓位会停止自动处理并写中文日志。`dock` 已确认但 `ship` 未完成时，状态文件会保存同一策略计划，进程重启后优先恢复，避免重新生成冲突仓位。完整策略、恢复和风险边界见 [Aqua自动再平衡Bot开发设计.md](/Users/syskey/git/1inch-aqua/docs/Aqua自动再平衡Bot开发设计.md)。

运行回归测试：

```bash
bun test
```

## 运行

```bash
bun run index.ts
```
