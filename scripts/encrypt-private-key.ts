/**
 * 私钥加密模块：交互式读取不回显的私钥与密码，使用 scrypt 和 AES-256-GCM 加密后写入 .env。
 * 核心功能：命令行主动加密；导出 getDecryptedPrivateKey() 供其他程序在内存中取得解密后的私钥。
 * 主要流程：TTY 隐藏输入 -> 格式校验 -> 派生密钥 -> 加密/解密 -> 安全写入或内存返回。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const ENV_FILE = ".env";
const ENV_FIELD = "ENCRYPTED_PRIVATE_KEY";
const FORMAT_MAGIC = Buffer.from([0x41, 0x51, 0x50]);
const FORMAT_VERSION = 0x02;
const FORMAT_HEADER_LENGTH = FORMAT_MAGIC.length + 1;
const ETHEREUM_PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
const ETHEREUM_PRIVATE_KEY_MAX = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const PASSWORD_MIN_LENGTH = 9;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DERIVED_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

/**
 * 以 TTY 原始模式读取敏感信息，终端不会回显任何输入字符。
 * 使用原始模式而非普通 readline，是为了避免密码或私钥在任何平台显示为星号或明文。
 */
async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("需要在交互式终端中运行，无法安全读取隐藏输入");
  }

  // 必须先关闭终端回显再展示提示符，避免自动化终端或快速粘贴在状态切换间隙泄露首个字符。
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(prompt);

  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let value = "";
    let completed = false;

    // 无论成功、取消或异常都恢复终端状态，避免后续 shell 保持无回显状态。
    const finish = (error?: Error, result?: string): void => {
      if (completed) {
        return;
      }
      completed = true;
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");

      if (error) {
        reject(error);
        return;
      }
      resolve(result ?? "");
    };

    const onData = (chunk: Buffer): void => {
      for (const character of decoder.write(chunk)) {
        if (character === "\r" || character === "\n") {
          finish(undefined, value);
          return;
        }
        if (character === "\u0003") {
          finish(new Error("输入已取消"));
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          // 按 Unicode 字符回退，避免多字节密码被截断为无效 UTF-8。
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= "\u0020" && character !== "\u007f") {
          value += character;
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * 使用 OWASP 建议的 scrypt 参数派生 AES-256 密钥；较高内存成本用于抬高离线猜密成本。
 */
function deriveKey(password: Buffer, salt: Buffer): Buffer {
  return scryptSync(password, salt, DERIVED_KEY_LENGTH, SCRYPT_OPTIONS);
}

/**
 * 校验 Ethereum 私钥必须是 32 字节十六进制数，并且落在 secp256k1 有效范围内。
 * 统一输出带 0x 前缀的小写形式，避免同一私钥因输入写法不同产生不同明文格式。
 */
function validatePrivateKey(privateKey: string): string {
  if (!ETHEREUM_PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error("私钥格式错误：请输入 64 位十六进制 Ethereum 私钥，可带 0x 前缀");
  }

  const normalized = `0x${privateKey.replace(/^0x/i, "").toLowerCase()}`;
  const numericValue = BigInt(normalized);
  if (numericValue === 0n || numericValue >= ETHEREUM_PRIVATE_KEY_MAX) {
    throw new Error("私钥数值无效：必须大于 0 且小于 secp256k1 曲线阶数");
  }
  return normalized;
}

/**
 * 强制密码具备足够的字符多样性，降低字典猜测成功率；密码不接受空白字符以避免复制和终端输入歧义。
 */
function validatePassword(password: string): void {
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) {
    throw new Error(`密码长度必须大于 8 位（至少 ${PASSWORD_MIN_LENGTH} 位）`);
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
    throw new Error("密码必须同时包含小写字母、大写字母、数字和特殊字符");
  }
  if (/\s/.test(password)) {
    throw new Error("密码不能包含空白字符");
  }
}

/**
 * 将二进制密文编码为 Base58，同时保留前导零字节以确保格式可逆。
 */
function encodeBase58(bytes: Buffer): string {
  let leadingZeroCount = 0;
  while (leadingZeroCount < bytes.length && bytes[leadingZeroCount] === 0) {
    leadingZeroCount += 1;
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }

  return "1".repeat(leadingZeroCount) + encoded;
}

/**
 * 解码 Base58 文本并拒绝格式外字符，防止把错误的 .env 内容送入解密流程。
 */
function decodeBase58(encoded: string): Buffer {
  if (encoded.length === 0) {
    throw new Error("加密私钥不能为空");
  }

  let leadingZeroCount = 0;
  while (encoded[leadingZeroCount] === "1") {
    leadingZeroCount += 1;
  }

  let value = 0n;
  for (const character of encoded) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) {
      throw new Error("加密私钥不是有效的 Base58 格式");
    }
    value = value * 58n + BigInt(digit);
  }

  const decoded: number[] = [];
  while (value > 0n) {
    decoded.unshift(Number(value & 0xffn));
    value >>= 8n;
  }

  return Buffer.from([...Array<number>(leadingZeroCount).fill(0), ...decoded]);
}

/**
 * 将 salt、IV、认证标签与密文封装为 v2 格式，便于将来安全扩展且每次加密都有独立随机数据。
 */
function encryptPrivateKey(privateKey: Buffer, password: Buffer): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const derivedKey = deriveKey(password, salt);

  try {
    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return encodeBase58(Buffer.concat([FORMAT_MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv, authTag, ciphertext]));
  } finally {
    // 派生密钥仅用于本次操作，尽早覆盖 Buffer 中的敏感内容。
    derivedKey.fill(0);
  }
}

/**
 * 校验二进制格式后执行 AES-GCM 解密；仅接受当前 v2 格式，认证失败统一提示以避免暴露密码或密文细节。
 */
function decryptPrivateKey(encryptedPrivateKey: string, password: Buffer): Buffer {
  const payload = decodeBase58(encryptedPrivateKey);
  const minimumLength = FORMAT_HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
  const version = payload[FORMAT_MAGIC.length];

  if (
    payload.length < minimumLength ||
    !payload.subarray(0, FORMAT_MAGIC.length).equals(FORMAT_MAGIC) ||
    version !== FORMAT_VERSION
  ) {
    throw new Error("加密私钥格式不受支持或已损坏");
  }

  const saltStart = FORMAT_HEADER_LENGTH;
  const ivStart = saltStart + SALT_LENGTH;
  const tagStart = ivStart + IV_LENGTH;
  const ciphertextStart = tagStart + AUTH_TAG_LENGTH;
  const salt = payload.subarray(saltStart, ivStart);
  const iv = payload.subarray(ivStart, tagStart);
  const authTag = payload.subarray(tagStart, ciphertextStart);
  const ciphertext = payload.subarray(ciphertextStart);
  const derivedKey = deriveKey(password, salt);

  try {
    const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("密码错误或加密私钥已损坏");
  } finally {
    derivedKey.fill(0);
  }
}

/**
 * 只替换目标字段，保留 .env 内其他配置；新文件限制为当前用户可读写。
 */
function writeEncryptedPrivateKey(encryptedPrivateKey: string): void {
  const existingContent = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const newline = existingContent.includes("\r\n") ? "\r\n" : "\n";
  const fieldPattern = new RegExp(`^\\s*${ENV_FIELD}\\s*=.*$`);
  const lines = existingContent.split(/\r?\n/);
  const fieldLine = `${ENV_FIELD}=${encryptedPrivateKey}`;
  const fieldIndex = lines.findIndex((line) => fieldPattern.test(line));

  if (fieldIndex >= 0) {
    lines[fieldIndex] = fieldLine;
  } else {
    if (lines.length === 1 && lines[0] === "") {
      lines.length = 0;
    }
    lines.push(fieldLine);
  }

  writeFileSync(ENV_FILE, `${lines.join(newline).replace(/(?:\r?\n)+$/, "")}${newline}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // Windows 不采用 POSIX 权限位，文件访问保护由创建目录及文件的 NTFS ACL 决定。
  if (process.platform !== "win32") {
    chmodSync(ENV_FILE, 0o600);
  }
}

/**
 * 从 .env 精确读取 Base58 密文；不加载环境变量，避免将密文扩散到进程环境。
 */
function readEncryptedPrivateKey(): string {
  if (!existsSync(ENV_FILE)) {
    throw new Error("未找到 .env 文件");
  }

  const fieldPattern = new RegExp(`^\\s*${ENV_FIELD}\\s*=\\s*(.*?)\\s*$`);
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(fieldPattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error(`.env 中未找到 ${ENV_FIELD}`);
}

/**
 * 主动加密入口：校验 Ethereum 私钥与强密码，并要求两次输入同一密码后才写入 .env。
 */
async function runEncrypt(): Promise<void> {
  const normalizedPrivateKey = validatePrivateKey(await readHidden("请输入 Ethereum 私钥："));
  const passwordText = await readHidden("请输入加密密码：");
  const passwordConfirmationText = await readHidden("请再次输入加密密码：");
  const privateKey = Buffer.from(normalizedPrivateKey, "utf8");
  const password = Buffer.from(passwordText, "utf8");
  const passwordConfirmation = Buffer.from(passwordConfirmationText, "utf8");

  try {
    validatePassword(passwordText);
    if (!password.equals(passwordConfirmation)) {
      throw new Error("两次输入的密码不一致");
    }

    writeEncryptedPrivateKey(encryptPrivateKey(privateKey, password));
    process.stdout.write(`加密完成，已写入 ${ENV_FILE} 的 ${ENV_FIELD} 字段。\n`);
  } finally {
    privateKey.fill(0);
    password.fill(0);
    passwordConfirmation.fill(0);
  }
}

/**
 * 为其他程序提供解密后的私钥 Buffer；私钥只通过返回值驻留在调用进程内存中，不会打印或写入文件。
 * 调用方应在不再使用时执行 privateKey.fill(0)，尽快清除其持有的敏感数据。
 */
export async function getDecryptedPrivateKey(): Promise<Buffer> {
  const passwordText = await readHidden("请输入解密密码：");
  const password = Buffer.from(passwordText, "utf8");

  try {
    validatePassword(passwordText);
    const decryptedPrivateKey = decryptPrivateKey(readEncryptedPrivateKey(), password);
    try {
      // 即使密文已通过认证，仍校验明文，确保调用方只能得到有效的 Ethereum 私钥。
      return Buffer.from(validatePrivateKey(decryptedPrivateKey.toString("utf8")), "utf8");
    } finally {
      decryptedPrivateKey.fill(0);
    }
  } finally {
    password.fill(0);
  }
}

/**
 * 仅在直接执行该文件时触发主动加密；被其他程序导入时不产生副作用。
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? "encrypt";
  if (command !== "encrypt") {
    throw new Error("用法：bun run encrypt-private-key [encrypt]");
  }
  await runEncrypt();
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "发生未知错误";
    process.stderr.write(`操作失败：${message}\n`);
    process.exitCode = 1;
  });
}
