import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  encodeFrames,
  decodeFrames,
  digestFrames,
  encryptBytes,
  decryptBytes,
  encryptFrames,
  decryptFrames,
  deriveKeys,
  generateNonce,
  isTimestampFresh,
  ReplayGuard,
} from "../../src/security.js";

/**
 * 单元测试说明：
 * - 覆盖帧编码/解码一致性
 * - 覆盖摘要一致性（与 encodeFrames 结果一致）
 * - 覆盖加解密正确性
 * - 覆盖重放检测与时间戳校验
 */

test("encodeFrames/decodeFrames 应保持帧内容一致", () => {
  const frames = [
    Buffer.from("a"),
    Buffer.from(""),
    Buffer.from("xyz"),
    Buffer.from([0, 1, 2, 3]),
  ];

  const packed = encodeFrames(frames);
  const restored = decodeFrames(packed);

  assert.equal(restored.length, frames.length, "帧数量一致");
  restored.forEach((buf, i) => {
    assert.equal(Buffer.compare(buf, frames[i]), 0, `第 ${i} 帧一致`);
  });
});

test("digestFrames 应与 encodeFrames 哈希结果一致", () => {
  const frames = [
    Buffer.from("hello"),
    Buffer.from("world"),
    Buffer.from([1, 2, 3, 4, 5]),
  ];

  const expected = createHash("sha256")
    .update(encodeFrames(frames))
    .digest("hex");

  const actual = digestFrames(frames);
  assert.equal(actual, expected, "摘要结果一致");
});

test("encryptBytes/decryptBytes 应可还原明文", () => {
  const { encryptKey } = deriveKeys("unit-test-key-1");
  const plaintext = Buffer.from("plain-text-123");
  const aad = Buffer.from("aad-sample");

  const { iv, ciphertext, tag } = encryptBytes(encryptKey, plaintext, aad);
  const recovered = decryptBytes(encryptKey, iv, ciphertext, tag, aad);

  assert.equal(
    recovered.toString("utf8"),
    plaintext.toString("utf8"),
    "解密结果一致",
  );
});

test("encryptFrames/decryptFrames 应可还原帧数组", () => {
  const { encryptKey } = deriveKeys("unit-test-key-2");
  const frames = [Buffer.from("f1"), Buffer.from("f2")];
  const aad = Buffer.from("aad-frames");

  const { iv, ciphertext, tag } = encryptFrames(encryptKey, frames, aad);
  const restored = decryptFrames(encryptKey, iv, ciphertext, tag, aad);

  assert.equal(restored.length, frames.length, "帧数量一致");
  restored.forEach((buf, i) => {
    assert.equal(buf.toString(), frames[i].toString(), `第 ${i} 帧一致`);
  });
});

test("ReplayGuard 应识别重复 nonce", () => {
  const guard = new ReplayGuard({ windowMs: 10_000 });
  const nonce = generateNonce();

  const first = guard.seenOrAdd(nonce);
  const second = guard.seenOrAdd(nonce);

  assert.equal(first, false, "首次出现应为 false");
  assert.equal(second, true, "重复出现应为 true");
});

test("isTimestampFresh 应正确判断时间漂移", () => {
  const now = Date.now();
  assert.equal(isTimestampFresh(now, 1000, now), true, "当前时间戳有效");
  assert.equal(
    isTimestampFresh(now - 5000, 1000, now),
    false,
    "过旧时间戳无效",
  );
  assert.equal(
    isTimestampFresh(now + 5000, 1000, now),
    false,
    "过新时间戳无效",
  );
});
