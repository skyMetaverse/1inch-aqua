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

## 一键取消全部活跃 LP 仓位

脚本通过 1inch Aqua 网页端的 maker 策略查询接口获取当前钱包的 `open` 仓位，再对每个仓位串行发送 Aqua registry 的 `dock` 交易。`dock` 只关闭策略的虚拟余额配置，代币始终留在钱包中；脚本不会撤销已有 ERC20 最大授权。

交易在本机用解密私钥签名，RPC 仅接收已签名交易的 `eth_sendRawTransaction` 广播请求，不要求也不使用节点托管账户的 `eth_sendTransaction`。因此应使用支持标准 raw transaction 广播的 RPC。

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

运行回归测试：

```bash
bun test
```

## 运行

```bash
bun run index.ts
```
