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

脚本会以不回显方式读取私钥、加密密码和确认密码，使用带随机 16 字节 salt 的 `scrypt`（`N=2^17, r=8, p=1`，约需 128 MiB 内存）派生密钥，并使用 `AES-256-GCM` 加密和认证。结果以 Base58 文本整行写入 `.env`：

```dotenv
ENCRYPTED_PRIVATE_KEY=<Base58 密文>
```

在 macOS/Linux 上，`.env` 会被设置为仅当前用户可读写（`0600`）；Windows 请依赖并检查 NTFS ACL。每次加密都会产生独立 salt，因此预先计算的彩虹表不能跨文件复用；但攻击者拿到 `.env` 后仍可离线猜测弱密码。请使用密码管理器生成的高熵随机密码，建议至少 16 个随机字符。丢失密码后无法恢复私钥。

可通过以下命令读取并校验已加密私钥，解密密码也不会回显。该命令会将私钥打印到标准输出，请仅在可信终端中使用。脚本兼容此前生成的 v1 密文，新生成的密文使用更高成本的 v2 格式：

```bash
bun run encrypt-private-key -- decrypt
```

## 运行

```bash
bun run index.ts
```
