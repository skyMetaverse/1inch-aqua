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

## 运行

```bash
bun run index.ts
```
