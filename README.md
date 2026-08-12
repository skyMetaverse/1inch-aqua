# 1inch-aqua

## 安装

```bash
bun install --frozen-lockfile
```

## 私钥加密

使用以下命令交互式加密私钥：

```bash
bun run encrypt-private-key
```

脚本会以不回显方式读取私钥、加密密码和确认密码，使用 `scrypt` 派生密钥并使用 `AES-256-GCM` 加密。结果以 Base58 文本整行写入 `.env`：

```dotenv
ENCRYPTED_PRIVATE_KEY=<Base58 密文>
```

`.env` 会被设置为仅当前用户可读写（`0600`）。请妥善保存加密密码；丢失后无法恢复私钥。

可通过以下命令读取并校验已加密私钥，解密密码也不会回显。该命令会将私钥打印到标准输出，请仅在可信终端中使用：

```bash
bun run encrypt-private-key -- decrypt
```

## 运行

```bash
bun run index.ts
```
