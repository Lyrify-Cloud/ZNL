/**
 * 安全辅助模块（security.js）
 *
 * 目标：
 *  1) 从 authKey 派生“签名密钥 / 加密密钥”
 *  2) 生成与校验签名（HMAC-SHA256）
 *  3) 生成 nonce 与重放检测缓存
 *  4) 使用 AES-256-GCM 对 payload 帧进行加密/解密
 *
 * 设计原则：
 *  - 保持纯函数优先，易测试、易审计
 *  - 二进制优先，避免字符串编码歧义
 *  - 所有比较使用 timingSafeEqual，规避时序侧信道
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  ENCRYPT_ALGORITHM,
  ENCRYPT_IV_BYTES,
  ENCRYPT_TAG_BYTES,
  KDF_INFO_ENCRYPT,
  KDF_INFO_SIGN,
  MAX_TIME_SKEW_MS,
  REPLAY_WINDOW_MS,
} from "./constants.js";

/** HKDF 输出密钥长度（AES-256 / HMAC-SHA256） */
const KEY_BYTES = 32;

/** 固定盐值（用于 HKDF，非机密） */
const KDF_SALT = Buffer.from("znl-kdf-salt-v1", "utf8");

/**
 * 将任意输入标准化为 Buffer
 * @param {string|Buffer|Uint8Array|null|undefined} value
 * @returns {Buffer}
 */
function toBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

/**
 * 将输入标准化为帧数组（每帧为 Buffer）
 * @param {string|Buffer|Uint8Array|Array<string|Buffer|Uint8Array|null|undefined>} payload
 * @returns {Buffer[]}
 */
export function toFrameBuffers(payload) {
  if (Array.isArray(payload)) return payload.map(toBuffer);
  return [toBuffer(payload)];
}

/**
 * 将帧数组编码为紧凑二进制：
 * [count:u32be][len:u32be][frame-bytes]...
 *
 * @param {Buffer[]} frames
 * @returns {Buffer}
 */
export function encodeFrames(frames) {
  const safeFrames = Array.isArray(frames) ? frames : [];
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(safeFrames.length, 0);

  const chunks = [head];
  for (const frame of safeFrames) {
    const buf = toBuffer(frame);
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(buf.length, 0);
    chunks.push(len, buf);
  }
  return Buffer.concat(chunks);
}

/**
 * 将二进制还原为帧数组
 * @param {Buffer|Uint8Array|string} packed
 * @returns {Buffer[]}
 */
export function decodeFrames(packed) {
  const data = toBuffer(packed);
  if (data.length < 4) {
    throw new Error("无效帧数据：长度不足（缺少 count）。");
  }

  let offset = 0;
  const count = data.readUInt32BE(offset);
  offset += 4;

  const out = [];
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.length) {
      throw new Error(`无效帧数据：第 ${i} 帧缺少长度字段。`);
    }
    const len = data.readUInt32BE(offset);
    offset += 4;

    if (offset + len > data.length) {
      throw new Error(`无效帧数据：第 ${i} 帧长度越界。`);
    }
    out.push(data.slice(offset, offset + len));
    offset += len;
  }

  if (offset !== data.length) {
    throw new Error("无效帧数据：存在未消费的尾部字节。");
  }

  return out;
}

/**
 * 从 authKey 派生签名密钥与加密密钥（HKDF-SHA256）
 * @param {string} authKey
 * @returns {{ signKey: Buffer, encryptKey: Buffer }}
 */
export function deriveKeys(authKey) {
  const ikm = toBuffer(authKey);
  if (ikm.length === 0) {
    throw new Error("authKey 不能为空：启用安全功能时必须提供非空 authKey。");
  }

  const signKey = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      KDF_SALT,
      Buffer.from(KDF_INFO_SIGN, "utf8"),
      KEY_BYTES,
    ),
  );
  const encryptKey = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      KDF_SALT,
      Buffer.from(KDF_INFO_ENCRYPT, "utf8"),
      KEY_BYTES,
    ),
  );

  return { signKey, encryptKey };
}

/**
 * 生成随机 nonce（hex）
 * @param {number} [bytes=16]
 * @returns {string}
 */
export function generateNonce(bytes = 16) {
  return randomBytes(Math.max(8, bytes)).toString("hex");
}

/**
 * 生成当前时间戳（毫秒）
 * @returns {number}
 */
export function nowMs() {
  return Date.now();
}

/**
 * 校验时间戳是否在允许漂移窗口内
 * @param {number|string} timestampMs
 * @param {number} [maxSkewMs=MAX_TIME_SKEW_MS]
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isTimestampFresh(
  timestampMs,
  maxSkewMs = MAX_TIME_SKEW_MS,
  now = Date.now(),
) {
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return (
    Math.abs(now - ts) <= Math.max(1, Number(maxSkewMs) || MAX_TIME_SKEW_MS)
  );
}

/**
 * 将签名输入标准化为稳定字符串
 * @param {{
 *   kind: string,
 *   nodeId: string,
 *   requestId?: string|null,
 *   timestamp: number|string,
 *   nonce: string,
 *   payloadDigest?: string|null,
 * }} envelope
 * @returns {string}
 */
export function canonicalSignInput(envelope) {
  const {
    kind,
    nodeId,
    requestId = "",
    timestamp,
    nonce,
    payloadDigest = "",
  } = envelope ?? {};

  return [
    "znl-sign-v1",
    String(kind ?? ""),
    String(nodeId ?? ""),
    String(requestId ?? ""),
    String(timestamp ?? ""),
    String(nonce ?? ""),
    String(payloadDigest ?? ""),
  ].join("|");
}

/**
 * 对文本计算 HMAC-SHA256 签名（hex）
 * @param {Buffer|string} signKey
 * @param {string|Buffer} text
 * @returns {string}
 */
export function signText(signKey, text) {
  return createHmac("sha256", toBuffer(signKey))
    .update(toBuffer(text))
    .digest("hex");
}

/**
 * 验证 HMAC 签名（hex），使用 timingSafeEqual
 * @param {Buffer|string} signKey
 * @param {string|Buffer} text
 * @param {string} signatureHex
 * @returns {boolean}
 */
export function verifyTextSignature(signKey, text, signatureHex) {
  try {
    const expected = Buffer.from(signText(signKey, text), "hex");
    const provided = Buffer.from(String(signatureHex || ""), "hex");
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/**
 * base64url 编码（无填充）
 * @param {Buffer|string|Uint8Array} value
 * @returns {string}
 */
export function toBase64Url(value) {
  return toBuffer(value).toString("base64url");
}

/**
 * base64url 解码
 * @param {string} text
 * @returns {Buffer}
 */
export function fromBase64Url(text) {
  return Buffer.from(String(text ?? ""), "base64url");
}

/**
 * 将防重放信封编码为“签名证明令牌”
 *
 * 令牌结构：
 *   <base64url(header)>.<base64url(payload)>.<hmac-hex>
 *
 * header 固定为：
 *   { alg: "HS256", typ: "ZNL-AUTH-PROOF", v: 1 }
 *
 * payload 建议字段：
 *   - kind / nodeId / requestId / timestamp / nonce / payloadDigest
 *
 * @param {Buffer|string} signKey
 * @param {{
 *   kind: string,
 *   nodeId: string,
 *   requestId?: string|null,
 *   timestamp: number|string,
 *   nonce: string,
 *   payloadDigest?: string|null
 * }} envelope
 * @returns {string}
 */
export function encodeAuthProofToken(signKey, envelope) {
  const header = { alg: "HS256", typ: "ZNL-AUTH-PROOF", v: 1 };
  const payload = {
    kind: String(envelope?.kind ?? ""),
    nodeId: String(envelope?.nodeId ?? ""),
    requestId: envelope?.requestId == null ? "" : String(envelope.requestId),
    timestamp: Number(envelope?.timestamp ?? 0),
    nonce: String(envelope?.nonce ?? ""),
    payloadDigest:
      envelope?.payloadDigest == null ? "" : String(envelope.payloadDigest),
  };

  const h = toBase64Url(JSON.stringify(header));
  const p = toBase64Url(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const signatureHex = signText(signKey, signingInput);
  return `${signingInput}.${signatureHex}`;
}

/**
 * 解码并验证签名证明令牌
 *
 * 返回结构：
 *   - ok=true  : envelope 可用
 *   - ok=false : error 描述失败原因
 *
 * @param {Buffer|string} signKey
 * @param {string} token
 * @param {{ maxSkewMs?: number, now?: number }} [options]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   envelope?: {
 *     kind: string,
 *     nodeId: string,
 *     requestId: string,
 *     timestamp: number,
 *     nonce: string,
 *     payloadDigest: string
 *   }
 * }}
 */
export function decodeAuthProofToken(
  signKey,
  token,
  { maxSkewMs = MAX_TIME_SKEW_MS, now = Date.now() } = {},
) {
  try {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3) {
      return { ok: false, error: "令牌格式非法：必须为 3 段。" };
    }

    const [h, p, signatureHex] = parts;
    const signingInput = `${h}.${p}`;

    if (!verifyTextSignature(signKey, signingInput, signatureHex)) {
      return { ok: false, error: "签名校验失败。" };
    }

    const header = JSON.parse(fromBase64Url(h).toString("utf8"));
    const payload = JSON.parse(fromBase64Url(p).toString("utf8"));

    if (header?.alg !== "HS256" || header?.typ !== "ZNL-AUTH-PROOF") {
      return { ok: false, error: "令牌头非法：alg/typ 不匹配。" };
    }

    const envelope = {
      kind: String(payload?.kind ?? ""),
      nodeId: String(payload?.nodeId ?? ""),
      requestId: String(payload?.requestId ?? ""),
      timestamp: Number(payload?.timestamp ?? 0),
      nonce: String(payload?.nonce ?? ""),
      payloadDigest: String(payload?.payloadDigest ?? ""),
    };

    if (!envelope.kind || !envelope.nodeId || !envelope.nonce) {
      return { ok: false, error: "令牌负载非法：缺少关键字段。" };
    }

    if (!isTimestampFresh(envelope.timestamp, maxSkewMs, now)) {
      return { ok: false, error: "令牌已过期或时间戳异常。" };
    }

    return { ok: true, envelope };
  } catch (error) {
    return { ok: false, error: `令牌解析失败：${error?.message ?? error}` };
  }
}

/**
 * 计算 payload 帧摘要（sha256 hex）
 * 说明：按协议顺序增量写入，避免一次性拼接大 Buffer
 * @param {Buffer[]} frames
 * @returns {string}
 */
export function digestFrames(frames) {
  const safeFrames = Array.isArray(frames) ? frames : [];
  const hash = createHash("sha256");

  // 写入帧数量（u32be）
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(safeFrames.length, 0);
  hash.update(head);

  // 逐帧写入长度与内容（u32be + bytes）
  for (const frame of safeFrames) {
    const buf = toBuffer(frame);
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(buf.length, 0);
    hash.update(len);
    if (buf.length > 0) hash.update(buf);
  }

  return hash.digest("hex");
}

/**
 * AES-256-GCM 加密
 * @param {Buffer|string} encryptKey
 * @param {Buffer|string|Uint8Array} plaintext
 * @param {Buffer|string|Uint8Array} [aad]
 * @returns {{ iv: Buffer, ciphertext: Buffer, tag: Buffer }}
 */
export function encryptBytes(encryptKey, plaintext, aad = Buffer.alloc(0)) {
  const key = toBuffer(encryptKey);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `加密密钥长度非法：期望 ${KEY_BYTES} 字节，实际 ${key.length} 字节。`,
    );
  }

  const iv = randomBytes(ENCRYPT_IV_BYTES);
  const cipher = createCipheriv(ENCRYPT_ALGORITHM, key, iv, {
    authTagLength: ENCRYPT_TAG_BYTES,
  });

  const aadBuf = toBuffer(aad);
  if (aadBuf.length > 0) cipher.setAAD(aadBuf);

  const ciphertext = Buffer.concat([
    cipher.update(toBuffer(plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return { iv, ciphertext, tag };
}

/**
 * AES-256-GCM 解密
 * @param {Buffer|string} encryptKey
 * @param {Buffer|string|Uint8Array} iv
 * @param {Buffer|string|Uint8Array} ciphertext
 * @param {Buffer|string|Uint8Array} tag
 * @param {Buffer|string|Uint8Array} [aad]
 * @returns {Buffer}
 */
export function decryptBytes(
  encryptKey,
  iv,
  ciphertext,
  tag,
  aad = Buffer.alloc(0),
) {
  const key = toBuffer(encryptKey);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `解密密钥长度非法：期望 ${KEY_BYTES} 字节，实际 ${key.length} 字节。`,
    );
  }

  const ivBuf = toBuffer(iv);
  if (ivBuf.length !== ENCRYPT_IV_BYTES) {
    throw new Error(
      `IV 长度非法：期望 ${ENCRYPT_IV_BYTES} 字节，实际 ${ivBuf.length} 字节。`,
    );
  }

  const tagBuf = toBuffer(tag);
  if (tagBuf.length !== ENCRYPT_TAG_BYTES) {
    throw new Error(
      `认证标签长度非法：期望 ${ENCRYPT_TAG_BYTES} 字节，实际 ${tagBuf.length} 字节。`,
    );
  }

  const decipher = createDecipheriv(ENCRYPT_ALGORITHM, key, ivBuf, {
    authTagLength: ENCRYPT_TAG_BYTES,
  });
  decipher.setAuthTag(tagBuf);

  const aadBuf = toBuffer(aad);
  if (aadBuf.length > 0) decipher.setAAD(aadBuf);

  return Buffer.concat([
    decipher.update(toBuffer(ciphertext)),
    decipher.final(),
  ]);
}

/**
 * 对帧数组进行加密（先打包后加密）
 * @param {Buffer|string} encryptKey
 * @param {Buffer[]} frames
 * @param {Buffer|string|Uint8Array} [aad]
 * @returns {{ iv: Buffer, ciphertext: Buffer, tag: Buffer }}
 */
export function encryptFrames(encryptKey, frames, aad = Buffer.alloc(0)) {
  const packed = encodeFrames(frames);
  return encryptBytes(encryptKey, packed, aad);
}

/**
 * 解密并还原帧数组
 * @param {Buffer|string} encryptKey
 * @param {Buffer|string|Uint8Array} iv
 * @param {Buffer|string|Uint8Array} ciphertext
 * @param {Buffer|string|Uint8Array} tag
 * @param {Buffer|string|Uint8Array} [aad]
 * @returns {Buffer[]}
 */
export function decryptFrames(
  encryptKey,
  iv,
  ciphertext,
  tag,
  aad = Buffer.alloc(0),
) {
  const packed = decryptBytes(encryptKey, iv, ciphertext, tag, aad);
  return decodeFrames(packed);
}

/**
 * 重放检测缓存（基于 nonce）
 * - seenOrAdd(nonce): 首次出现返回 false，重复返回 true
 * - 自动清理过期条目，防止内存增长
 */
export class ReplayGuard {
  /**
   * @param {{ windowMs?: number }} [options]
   */
  constructor({ windowMs = REPLAY_WINDOW_MS } = {}) {
    /** @type {Map<string, number>} nonce -> expiresAt */
    this._map = new Map();
    this._windowMs = Math.max(10_000, Number(windowMs) || REPLAY_WINDOW_MS);
  }

  /**
   * 清理过期 nonce
   * @param {number} [now=Date.now()]
   */
  sweep(now = Date.now()) {
    for (const [nonce, expiresAt] of this._map) {
      if (expiresAt <= now) this._map.delete(nonce);
    }
  }

  /**
   * 检查 nonce 是否重复；若非重复则写入缓存
   * @param {string} nonce
   * @param {number} [now=Date.now()]
   * @returns {boolean} true=重复(疑似重放), false=首次出现
   */
  seenOrAdd(nonce, now = Date.now()) {
    const key = String(nonce ?? "");
    if (!key) return true; // 空 nonce 直接判定异常
    this.sweep(now);

    if (this._map.has(key)) return true;
    this._map.set(key, now + this._windowMs);
    return false;
  }

  /** 当前缓存条目数（便于监控） */
  get size() {
    return this._map.size;
  }

  /** 清空缓存 */
  clear() {
    this._map.clear();
  }
}
