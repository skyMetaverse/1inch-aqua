/**
 * 私钥加密脚本：交互式读取不回显的私钥与密码，使用 scrypt 和 AES-256-GCM 加密后写入 .env。
 * 核心功能：加密结果以 Base58 保存到 ENCRYPTED_PRIVATE_KEY；decrypt 子命令可验证并读取该密文。
 * 主要流程：TTY 隐藏输入 -> 派生密钥 -> 加密/解密 -> 安全写入或读取 .env。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const ENV_FILE = ".env";
const ENV_FIELD = "ENCRYPTED_PRIVATE_KEY";
const FORMAT_HEADER = Buffer.from([0x41, 0x51, 0x50, 0x01]);
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DERIVED_KEY_LENGTH = 32;
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
 * 使用固定且足够高成本的 scrypt 参数从密码派生 AES-256 密钥。
 * 每份密文携带独立 salt，防止相同密码产生可关联的派生密钥。
 */
function deriveKey(password: Buffer, salt: Buffer): Buffer {
  return scryptSync(password, salt, DERIVED_KEY_LENGTH, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
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
 * 将 salt、IV、认证标签与密文封装为带版本头的二进制数据，便于将来安全扩展格式。
 */
function encryptPrivateKey(privateKey: Buffer, password: Buffer): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const derivedKey = deriveKey(password, salt);

  try {
    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return encodeBase58(Buffer.concat([FORMAT_HEADER, salt, iv, authTag, ciphertext]));
  } finally {
    // 派生密钥仅用于本次操作，尽早覆盖 Buffer 中的敏感内容。
    derivedKey.fill(0);
  }
}

/**
 * 校验二进制格式后执行 AES-GCM 解密；认证失败统一提示，避免暴露密码或密文细节。
 */
function decryptPrivateKey(encryptedPrivateKey: string, password: Buffer): Buffer {
  const payload = decodeBase58(encryptedPrivateKey);
  const minimumLength = FORMAT_HEADER.length + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;

  if (payload.length < minimumLength || !payload.subarray(0, FORMAT_HEADER.length).equals(FORMAT_HEADER)) {
    throw new Error("加密私钥格式不受支持或已损坏");
  }

  const saltStart = FORMAT_HEADER.length;
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
  chmodSync(ENV_FILE, 0o600);
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
 * 加密入口：要求两次输入相同密码，避免不可恢复地写入输错密码的密文。
 */
async function runEncrypt(): Promise<void> {
  const privateKey = Buffer.from(await readHidden("请输入私钥："), "utf8");
  if (privateKey.length === 0) {
    throw new Error("私钥不能为空");
  }

  const password = Buffer.from(await readHidden("请输入加密密码："), "utf8");
  const passwordConfirmation = Buffer.from(await readHidden("请再次输入加密密码："), "utf8");

  try {
    if (password.length === 0) {
      throw new Error("加密密码不能为空");
    }
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
 * 解密入口：密码读取保持不回显，并将解密出的私钥写到标准输出供人工确认或其他程序接收。
 */
async function runDecrypt(): Promise<void> {
  const password = Buffer.from(await readHidden("请输入解密密码："), "utf8");

  try {
    if (password.length === 0) {
      throw new Error("解密密码不能为空");
    }

    const privateKey = decryptPrivateKey(readEncryptedPrivateKey(), password);
    try {
      process.stdout.write(`${privateKey.toString("utf8")}\n`);
    } finally {
      privateKey.fill(0);
    }
  } finally {
    password.fill(0);
  }
}

/**
 * 根据子命令执行对应流程，默认加密以减少日常使用时的参数负担。
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? "encrypt";
  if (command === "encrypt") {
    await runEncrypt();
    return;
  }
  if (command === "decrypt") {
    await runDecrypt();
    return;
  }

  throw new Error("用法：bun run encrypt-private-key [encrypt|decrypt]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "发生未知错误";
  process.stderr.write(`操作失败：${message}\n`);
  process.exitCode = 1;
});
