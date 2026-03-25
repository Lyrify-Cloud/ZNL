/**
 * Capture frames test: plain vs encrypted
 *
 * 目标：
 *  1) 明文模式：抓取到的 payloadFrames 与原始 payload 一致（不含加密信封）。
 *  2) 加密模式：抓取到的 payloadFrames 为安全信封（version/iv/tag/ciphertext），
 *     并且能够用 authKey 解密回原始 payload。
 *
 * 说明：
 *  - 使用 ZNL 事件（router/dealer）抓取原始帧。
 *  - 使用协议解析 + 安全模块解密验证内容。
 */

import { ZNL } from "../index.js";
import {
  parseControlFrames,
  payloadFromFrames,
  identityToString,
} from "../src/protocol.js";
import { SECURITY_ENVELOPE_VERSION } from "../src/constants.js";
import { deriveKeys, decryptFrames, encryptFrames } from "../src/security.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForEvent(emitter, event, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      emitter.off(event, handler);
    };
    const handler = (...args) => {
      cleanup();
      resolve(args.length <= 1 ? args[0] : args);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待事件超时: ${event}`));
    }, timeoutMs);
    emitter.on(event, handler);
  });
}

function expectThrow(fn, label) {
  let thrown = false;
  try {
    fn();
  } catch {
    thrown = true;
  }
  assert(thrown, label);
}

/**
 * 断言工具
 */
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`    ✓ ${label}`);
    passed++;
  } else {
    console.error(`    ✗ ${label}`);
    failed++;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function frameToDecoded(frame) {
  if (frame == null) return null;
  if (Buffer.isBuffer(frame)) return safeJsonParse(frame.toString("utf8"));
  if (frame instanceof Uint8Array)
    return safeJsonParse(Buffer.from(frame).toString("utf8"));
  return safeJsonParse(String(frame));
}

function formatFrames(frames) {
  const list = Array.isArray(frames) ? frames : [];
  return JSON.stringify(list.map((f) => frameToDecoded(f)));
}

function printFrames(label, frames) {
  console.log(`    [${label}] ${formatFrames(frames)}`);
}

/**
 * 从 ZNL 事件中解析 payloadFrames
 * @param {object} event
 * @returns {{ kind: string, requestId: string|null, payloadFrames: Array }}
 */
function extractPayloadFrames(event) {
  const frames = Array.isArray(event.frames) ? event.frames : [];
  const channel = event.channel;

  if (channel === "router") {
    // Router 事件帧结构：[identity, ...controlFrames]
    const [, ...bodyFrames] = frames;
    const parsed = parseControlFrames(bodyFrames);
    return {
      kind: parsed.kind,
      requestId: parsed.requestId,
      payloadFrames: parsed.payloadFrames,
    };
  }

  // Dealer 事件帧结构：[...controlFrames]
  const parsed = parseControlFrames(frames);
  return {
    kind: parsed.kind,
    requestId: parsed.requestId,
    payloadFrames: parsed.payloadFrames,
  };
}

/**
 * 解密 payloadFrames（encrypted=true）
 * @param {string} authKey
 * @param {"request"|"response"} kind
 * @param {string} requestId
 * @param {string} senderNodeId
 * @param {Array} payloadFrames
 * @returns {Array<Buffer>}
 */
function decryptEnvelope(
  authKey,
  kind,
  requestId,
  senderNodeId,
  payloadFrames,
) {
  const [version, iv, tag, ciphertext] = payloadFrames;
  assert(
    String(version?.toString?.() ?? "") === SECURITY_ENVELOPE_VERSION,
    "安全信封版本匹配",
  );

  const { encryptKey } = deriveKeys(authKey);
  const aad = Buffer.from(
    `znl-aad-v1|${String(kind)}|${String(senderNodeId)}|${String(requestId ?? "")}`,
    "utf8",
  );

  return decryptFrames(encryptKey, iv, ciphertext, tag, aad);
}

/**
 * 打印测试标题
 */
function section(title) {
  console.log(`\n【${title}】`);
}

console.log("=".repeat(56));
console.log("  ZNL 帧抓取测试");
console.log("=".repeat(56));

/**
 * 测试 1：明文模式
 */
section("明文模式：抓包验证");

{
  const EP = "tcp://127.0.0.1:16100";

  const master = new ZNL({
    role: "master",
    id: "m-plain",
    endpoints: { router: EP },
  });
  const slave = new ZNL({
    role: "slave",
    id: "s-plain",
    endpoints: { router: EP },
  });

  const captured = {
    routerReq: null,
    dealerRes: null,
    dealerReq: null,
    routerRes: null,
  };

  master.on("router", (ev) => {
    printFrames("plain-router", ev.frames);
    const { kind, requestId, payloadFrames } = extractPayloadFrames(ev);
    if (kind === "request") {
      captured.routerReq = { requestId, payloadFrames };
    } else if (kind === "response") {
      captured.routerRes = { requestId, payloadFrames };
    }
  });

  slave.on("dealer", (ev) => {
    printFrames("plain-dealer", ev.frames);
    const { kind, requestId, payloadFrames } = extractPayloadFrames(ev);
    if (kind === "response") {
      captured.dealerRes = { requestId, payloadFrames };
    } else if (kind === "request") {
      captured.dealerReq = { requestId, payloadFrames };
    }
  });

  // echo
  master.ROUTER(async ({ payload }) => payload);
  slave.DEALER(async ({ payload }) => payload);

  await master.start();
  await slave.start();
  await delay(150);

  // slave -> master
  const ping1 = "plain-ping";
  const r1 = await slave.DEALER(ping1, { timeoutMs: 2000 });
  assert(String(r1) === ping1, "slave → master 响应内容一致");

  // master -> slave
  const ping2 = "plain-pong";
  const r2 = await master.ROUTER("s-plain", ping2, { timeoutMs: 2000 });
  assert(String(r2) === ping2, "master → slave 响应内容一致");

  // 验证抓包 payloadFrames 为明文帧（非信封）
  const reqFrames = captured.routerReq?.payloadFrames ?? [];
  const resFrames = captured.dealerRes?.payloadFrames ?? [];
  assert(
    reqFrames.length === 1 && String(reqFrames[0]) === ping1,
    "抓取到的 request payloadFrames 为明文",
  );
  assert(
    resFrames.length === 1 && String(resFrames[0]) === ping1,
    "抓取到的 response payloadFrames 为明文",
  );

  const reqFrames2 = captured.dealerReq?.payloadFrames ?? [];
  const resFrames2 = captured.routerRes?.payloadFrames ?? [];
  assert(
    reqFrames2.length === 1 && String(reqFrames2[0]) === ping2,
    "抓取到的 master→slave request payloadFrames 为明文",
  );
  assert(
    resFrames2.length === 1 && String(resFrames2[0]) === ping2,
    "抓取到的 master→slave response payloadFrames 为明文",
  );

  await slave.stop();
  await master.stop();
}

/**
 * 测试 2：加密模式
 */
section("加密模式：抓包验证");

{
  const EP = "tcp://127.0.0.1:16101";
  const KEY = "capture-secret-key";

  const master = new ZNL({
    role: "master",
    id: "m-enc",
    endpoints: { router: EP },
    authKey: KEY,
    encrypted: true,
  });
  const slave = new ZNL({
    role: "slave",
    id: "s-enc",
    endpoints: { router: EP },
    authKey: KEY,
    encrypted: true,
  });

  const captured = {
    routerReq: null,
    dealerRes: null,
    dealerReq: null,
    routerRes: null,
    routerReqFrom: null,
    routerResFrom: null,
  };

  master.on("router", (ev) => {
    printFrames("enc-router", ev.frames);
    const { kind, requestId, payloadFrames } = extractPayloadFrames(ev);
    if (kind === "request") {
      captured.routerReq = { requestId, payloadFrames };
      captured.routerReqFrom =
        ev.identityText ?? identityToString(ev.identity ?? "");
    } else if (kind === "response") {
      captured.routerRes = { requestId, payloadFrames };
      captured.routerResFrom =
        ev.identityText ?? identityToString(ev.identity ?? "");
    }
  });

  slave.on("dealer", (ev) => {
    printFrames("enc-dealer", ev.frames);
    const { kind, requestId, payloadFrames } = extractPayloadFrames(ev);
    if (kind === "response") {
      captured.dealerRes = { requestId, payloadFrames };
    } else if (kind === "request") {
      captured.dealerReq = { requestId, payloadFrames };
    }
  });

  master.ROUTER(async ({ payload }) => payload);
  slave.DEALER(async ({ payload }) => payload);

  await master.start();
  await slave.start();
  await delay(150);

  const ping1 = "enc-ping";
  const r1 = await slave.DEALER(ping1, { timeoutMs: 2000 });
  assert(String(r1) === ping1, "encrypted slave → master 响应内容一致");

  const ping2 = "enc-pong";
  const r2 = await master.ROUTER("s-enc", ping2, { timeoutMs: 2000 });
  assert(String(r2) === ping2, "encrypted master → slave 响应内容一致");

  // 解密并校验：slave -> master
  {
    const req = captured.routerReq;
    const res = captured.dealerRes;
    assert(
      req?.payloadFrames?.length === 4,
      "request payloadFrames 为加密信封",
    );
    assert(
      res?.payloadFrames?.length === 4,
      "response payloadFrames 为加密信封",
    );

    const reqFrames = decryptEnvelope(
      KEY,
      "request",
      req.requestId,
      captured.routerReqFrom,
      req.payloadFrames,
    );
    const reqPayload = payloadFromFrames(reqFrames);
    assert(String(reqPayload) === ping1, "解密 request payload 匹配");

    const resFrames = decryptEnvelope(
      KEY,
      "response",
      res.requestId,
      "m-enc",
      res.payloadFrames,
    );
    const resPayload = payloadFromFrames(resFrames);
    assert(String(resPayload) === ping1, "解密 response payload 匹配");
  }

  // 解密并校验：master -> slave
  {
    const req = captured.dealerReq;
    const res = captured.routerRes;
    assert(req?.payloadFrames?.length === 4, "master→slave request 为加密信封");
    assert(
      res?.payloadFrames?.length === 4,
      "master→slave response 为加密信封",
    );

    const reqFrames = decryptEnvelope(
      KEY,
      "request",
      req.requestId,
      "m-enc",
      req.payloadFrames,
    );
    const reqPayload = payloadFromFrames(reqFrames);
    assert(
      String(reqPayload) === ping2,
      "解密 master→slave request payload 匹配",
    );

    const resFrames = decryptEnvelope(
      KEY,
      "response",
      res.requestId,
      captured.routerResFrom,
      res.payloadFrames,
    );
    const resPayload = payloadFromFrames(resFrames);
    assert(
      String(resPayload) === ping2,
      "解密 master→slave response payload 匹配",
    );
  }

  await slave.stop();
  await master.stop();
}

/**
 * 测试 3：加密模式（双方 key 不一致）
 */
section("加密模式：双方 key 不一致");

{
  const EP = "tcp://127.0.0.1:16102";
  const KEY_MASTER = "capture-master-key";
  const KEY_SLAVE = "capture-slave-key";

  const master = new ZNL({
    role: "master",
    id: "m-bad",
    endpoints: { router: EP },
    authKey: KEY_MASTER,
    encrypted: true,
  });
  const slave = new ZNL({
    role: "slave",
    id: "s-bad",
    endpoints: { router: EP },
    authKey: KEY_SLAVE,
    encrypted: true,
  });

  master.ROUTER(async ({ payload }) => payload);
  slave.DEALER(async ({ payload }) => payload);

  await master.start();
  await slave.start();
  await delay(150);

  // slave -> master 应触发 master 侧 auth_failed，且请求超时/失败
  const masterAuthFailed = waitForEvent(master, "auth_failed", 1500).catch(
    () => null,
  );
  let err1 = null;
  try {
    await slave.DEALER("bad-ping", { timeoutMs: 800 });
  } catch (e) {
    err1 = e;
  }
  assert(!!err1, "key 不一致: slave → master 请求应失败");
  assert(!!(await masterAuthFailed), "key 不一致: master 收到 auth_failed");

  // master -> slave 应触发 slave 侧 auth_failed，且请求超时/失败
  const slaveAuthFailed = waitForEvent(slave, "auth_failed", 1500).catch(
    () => null,
  );
  let err2 = null;
  try {
    await master.ROUTER("s-bad", "bad-pong", { timeoutMs: 800 });
  } catch (e) {
    err2 = e;
  }
  assert(!!err2, "key 不一致: master → slave 请求应失败");
  assert(!!(await slaveAuthFailed), "key 不一致: slave 收到 auth_failed");

  await slave.stop();
  await master.stop();
}

/**
 * 测试 4：加密模式（双方 encrypted 不一致）
 */
section("加密模式：双方 encrypted 不一致");

{
  // master encrypted=true, slave encrypted=false
  const EP = "tcp://127.0.0.1:16103";

  const master = new ZNL({
    role: "master",
    id: "m-mix1",
    endpoints: { router: EP },
    authKey: "mix-key-1",
    encrypted: true,
  });
  const slave = new ZNL({
    role: "slave",
    id: "s-mix1",
    endpoints: { router: EP },
    encrypted: false,
  });

  master.ROUTER(async ({ payload }) => payload);
  slave.DEALER(async ({ payload }) => payload);

  await master.start();
  await slave.start();
  await delay(150);

  const masterAuthFailed1 = waitForEvent(master, "auth_failed", 1500).catch(
    () => null,
  );
  let err1 = null;
  try {
    await slave.DEALER("mix1-ping", { timeoutMs: 800 });
  } catch (e) {
    err1 = e;
  }
  assert(!!err1, "encrypted 不一致: slave → master 请求应失败");
  assert(
    !!(await masterAuthFailed1),
    "encrypted 不一致: master 收到 auth_failed",
  );

  const masterAuthFailed2 = waitForEvent(master, "auth_failed", 1500).catch(
    () => null,
  );
  let err2 = null;
  try {
    await master.ROUTER("s-mix1", "mix1-pong", { timeoutMs: 800 });
  } catch (e) {
    err2 = e;
  }
  assert(!!err2, "encrypted 不一致: master → slave 请求应失败");
  assert(
    !!(await masterAuthFailed2),
    "encrypted 不一致: master 收到 auth_failed",
  );

  await slave.stop();
  await master.stop();
}

{
  // master encrypted=false, slave encrypted=true
  const EP = "tcp://127.0.0.1:16104";

  const master = new ZNL({
    role: "master",
    id: "m-mix2",
    endpoints: { router: EP },
    encrypted: false,
  });
  const slave = new ZNL({
    role: "slave",
    id: "s-mix2",
    endpoints: { router: EP },
    authKey: "mix-key-2",
    encrypted: true,
  });

  master.ROUTER(async ({ payload }) => payload);
  slave.DEALER(async ({ payload }) => payload);

  await master.start();
  await slave.start();
  await delay(150);

  const slaveAuthFailed1 = waitForEvent(slave, "auth_failed", 1500).catch(
    () => null,
  );
  let err3 = null;
  try {
    await slave.DEALER("mix2-ping", { timeoutMs: 800 });
  } catch (e) {
    err3 = e;
  }
  assert(!!err3, "encrypted 不一致: slave → master 请求应失败");
  assert(
    !!(await slaveAuthFailed1),
    "encrypted 不一致: slave 收到 auth_failed",
  );

  const slaveAuthFailed2 = waitForEvent(slave, "auth_failed", 1500).catch(
    () => null,
  );
  let err4 = null;
  try {
    await master.ROUTER("s-mix2", "mix2-pong", { timeoutMs: 800 });
  } catch (e) {
    err4 = e;
  }
  assert(!!err4, "encrypted 不一致: master → slave 请求应失败");
  assert(
    !!(await slaveAuthFailed2),
    "encrypted 不一致: slave 收到 auth_failed",
  );

  await slave.stop();
  await master.stop();
}

/**
 * 测试 5：加密模式（篡改信封）
 */
section("加密模式：篡改信封");

{
  const KEY = "capture-tamper-key";
  const { encryptKey } = deriveKeys(KEY);

  const payloadFrames = [Buffer.from("tamper-1", "utf8")];
  const aad = Buffer.from("znl-aad-v1|request|node-x|rid-1", "utf8");
  const { iv, ciphertext, tag } = encryptFrames(encryptKey, payloadFrames, aad);

  const badTag = Buffer.from(tag);
  badTag[0] ^= 0x01;

  const badIv = Buffer.from(iv);
  badIv[0] ^= 0x01;

  expectThrow(
    () => decryptFrames(encryptKey, iv, ciphertext, badTag, aad),
    "篡改 tag 导致解密失败",
  );
  expectThrow(
    () => decryptFrames(encryptKey, badIv, ciphertext, tag, aad),
    "篡改 iv 导致解密失败",
  );

  const badVersion = Buffer.from("v0", "utf8");
  assert(String(badVersion) !== SECURITY_ENVELOPE_VERSION, "篡改版本号不匹配");
}

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(56));
console.log(`  通过: ${passed}   失败: ${failed}`);
console.log("=".repeat(56));

if (failed > 0) {
  process.exit(1);
} else {
  console.log("\n  ✓ 帧抓取测试通过\n");
  process.exit(0);
}
