/**
 * ZNL 集成测试（增强版）
 *
 * 覆盖项一览：
 *  1) 构造参数校验：role / id / encrypted + authKey|authKeyMap
 *  2) 基础双向通信：slave→master / master→slave / Buffer payload
 *  3) 并发请求：100 条并发一致性校验
 *  4) 载荷边界：Uint8Array、多帧 payload、非法 payload
 *  5) API 行为：start/stop 幂等、stop→start 恢复、未 start 抛错
 *  6) 并发上限：maxPending 达到上限拒绝新请求
 *  7) 认证失败：错误 authKey / 错误 master key
 *  8) 超时控制：无处理器时超时 & 超时时机
 *  9) stop() 取消 pending：in-flight 立即 reject
 * 10) PUB/SUB：订阅过滤、多 slave 广播、connected/disconnected、UNSUBSCRIBE
 * 11) 心跳：禁用心跳不移除、自定义 heartbeatTimeoutMs 生效
 * 12) 加密：RPC + PUB 正常（透明加解密）
 * 13) 加密：PUBLISH digest mismatch 触发 auth_failed
 * 14) 安全：防重放（同 nonce+requestId）拒绝
 * 15) 安全：时间漂移超限拒绝
 * 16) authKeyMap：命中优先级不回退
 * 17) authKeyMap：更新在线 key 立即切换
 * 18) authKeyMap：未命中回退到 authKey
 * 19) authKeyMap：动态 add/remove 立即生效
 * 20) SendQueue 顺序：master→slave 顺序保持
 * 21) PendingManager：key 含 identity 避免碰撞
 * 22) 外部 API：slave 侧 masterOnline / isMasterOnline 状态正确
 * 23) 心跳应答：heartbeat_ack 驱动单飞心跳与主节点恢复
 * 24) 输出结构：分组、统一格式、汇总统计
 */

import * as zmq from "zeromq";
import { ZNL } from "../index.js";
import {
  CONTROL_PREFIX,
  CONTROL_REGISTER,
  SECURITY_ENVELOPE_VERSION,
} from "../src/constants.js";
import { buildRequestFrames } from "../src/protocol.js";
import {
  deriveKeys,
  digestFrames,
  encodeAuthProofToken,
  encryptFrames,
  toFrameBuffers,
} from "../src/security.js";
import { PendingManager } from "../src/PendingManager.js";

// ─── 基础工具 ────────────────────────────────────────────────────────────────

const toText = (p) => (Buffer.isBuffer(p) ? p.toString() : String(p));
const TIMEOUT_SCALE = /^(1|true|yes)$/i.test(process.env.CI ?? "") ? 2 : 1;
const scaleMs = (ms) => Math.round(ms * TIMEOUT_SCALE);
const delay = (ms) => new Promise((r) => setTimeout(r, scaleMs(ms)));
const VERBOSE = /^(1|true|yes)$/i.test(process.env.ZNL_TEST_VERBOSE ?? "");
const log = (...args) => {
  if (VERBOSE) console.log(...args);
};

const fmt = (p) => {
  const s = Array.isArray(p) ? p.map(toText).join(" | ") : toText(p);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

const wrapTimeoutOptions = (options) => {
  if (!options || typeof options.timeoutMs !== "number") return options;
  return { ...options, timeoutMs: scaleMs(options.timeoutMs) };
};

const _origDEALER = ZNL.prototype.DEALER;
ZNL.prototype.DEALER = async function (payloadOrHandler, options = {}) {
  if (typeof payloadOrHandler === "function") {
    return _origDEALER.call(this, payloadOrHandler);
  }
  const nextOptions = wrapTimeoutOptions(options);
  return _origDEALER.call(this, payloadOrHandler, nextOptions);
};

const _origROUTER = ZNL.prototype.ROUTER;
ZNL.prototype.ROUTER = async function (
  identityOrHandler,
  payload,
  options = {},
) {
  if (typeof identityOrHandler === "function") {
    return _origROUTER.call(this, identityOrHandler);
  }
  const nextOptions = wrapTimeoutOptions(options);
  return _origROUTER.call(this, identityOrHandler, payload, nextOptions);
};

async function waitForSlave(master, slaveId, maxMs = 2000) {
  const deadline = Date.now() + scaleMs(maxMs);
  while (Date.now() < deadline) {
    if (master.slaves.includes(slaveId)) return true;
    await delay(100);
  }
  return false;
}

class TestRunner {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.index = 0;
  }

  banner(title) {
    console.log("=".repeat(64));
    console.log(`  ${title}`);
    console.log("=".repeat(64));
    console.log(`  verbose=${VERBOSE ? "on" : "off"}`);
  }

  section(title) {
    console.log(`\n【${title}】`);
  }

  pass(label) {
    console.log(`    ✓ ${label}`);
    this.passed++;
  }

  fail(label) {
    console.error(`    ✗ ${label}`);
    this.failed++;
  }

  assert(cond, label) {
    cond ? this.pass(label) : this.fail(label);
  }

  async test(label, fn) {
    this.index++;
    const idx = String(this.index).padStart(2, "0");
    console.log(`\n  ▶ [${idx}] ${label}`);
    try {
      await fn();
    } catch (e) {
      this.fail(`未预期异常：${e?.message ?? e}`);
    }
  }

  summary() {
    console.log("\n" + "=".repeat(64));
    console.log(`  通过: ${this.passed}   失败: ${this.failed}`);
    console.log("=".repeat(64));
    if (this.failed > 0) {
      process.exit(1);
    } else {
      console.log("\n  ✓ 全部测试通过\n");
      process.exit(0);
    }
  }
}

const runner = new TestRunner();

// ─── 收发日志 ────────────────────────────────────────────────────────────────

let logSilent = false;

function attachLogger(node, label) {
  node.on("request", ({ identityText, payload }) => {
    if (logSilent) return;
    const from = identityText ? `  from=${identityText}` : "";
    log(`    [${label}] ◀ REQ${from}  "${fmt(payload)}"`);
  });

  node.on("response", ({ identityText, payload }) => {
    if (logSilent) return;
    const from = identityText ? `  from=${identityText}` : "";
    log(`    [${label}] ◀ RES${from}  "${fmt(payload)}"`);
  });
}

// ─── 低层构造辅助（用于安全/重放测试）────────────────────────────────────────

function buildEncryptedRequestFrames({
  authKey,
  nodeId,
  requestId,
  payload,
  nonce,
  timestamp,
}) {
  const { signKey, encryptKey } = deriveKeys(authKey);
  const rawFrames = toFrameBuffers(payload);

  const aad = Buffer.from(
    `znl-aad-v1|request|${String(nodeId)}|${String(requestId ?? "")}`,
    "utf8",
  );
  const { iv, ciphertext, tag } = encryptFrames(encryptKey, rawFrames, aad);

  const payloadFrames = [
    Buffer.from(SECURITY_ENVELOPE_VERSION),
    iv,
    tag,
    ciphertext,
  ];

  const envelope = {
    kind: "request",
    nodeId: String(nodeId),
    requestId: String(requestId ?? ""),
    timestamp: Number(timestamp),
    nonce: String(nonce),
    payloadDigest: digestFrames(payloadFrames),
  };

  const proof = encodeAuthProofToken(signKey, envelope);
  const frames = buildRequestFrames(requestId, payloadFrames, proof);
  return { frames, payloadFrames };
}

// ─── 开始 ─────────────────────────────────────────────────────────────────────

runner.banner("ZNL 集成测试（增强版）");

// ══════════════════════════════════════════════════════════
//  构造参数校验
// ══════════════════════════════════════════════════════════

runner.section("构造参数校验");

await runner.test("role 非法应抛错", async () => {
  let threw = false;
  try {
    new ZNL({ role: "bad-role", id: "x" });
  } catch (e) {
    threw = true;
    runner.assert(
      String(e?.message ?? e).includes("role"),
      `错误信息包含 role → "${e?.message ?? e}"`,
    );
  }
  if (!threw) runner.fail("未抛错（role 非法）");
});

await runner.test("id 缺失应抛错", async () => {
  let threw = false;
  try {
    new ZNL({ role: "master" });
  } catch (e) {
    threw = true;
    runner.assert(
      String(e?.message ?? e).includes("id"),
      `错误信息包含 id → "${e?.message ?? e}"`,
    );
  }
  if (!threw) runner.fail("未抛错（id 缺失）");
});

await runner.test(
  "encrypted=true 但未提供 authKey/authKeyMap 应抛错",
  async () => {
    let threw = false;
    try {
      new ZNL({ role: "master", id: "m-enc", encrypted: true });
    } catch (e) {
      threw = true;
      const msg = String(e?.message ?? e);
      runner.assert(
        msg.includes("authKey") || msg.includes("authKeyMap"),
        `错误信息包含 authKey/authKeyMap → "${e?.message ?? e}"`,
      );
    }
    if (!threw) runner.fail("未抛错（encrypted=true 缺少 authKey/authKeyMap）");
  },
);

// ══════════════════════════════════════════════════════════
//  基础双向通信 & 并发
// ══════════════════════════════════════════════════════════

runner.section("基础双向通信 & 并发");

const EP1 = "tcp://127.0.0.1:16003";

const master = new ZNL({
  role: "master",
  id: "test-master",
  endpoints: { router: EP1 },
  maxPending: 200,
});
const slave = new ZNL({
  role: "slave",
  id: "test-slave",
  endpoints: { router: EP1 },
  maxPending: 200,
});

master.ROUTER(async ({ payload }) => `M:${toText(payload)}`);
slave.DEALER(async ({ payload }) => `S:${toText(payload)}`);

attachLogger(master, "MASTER");
attachLogger(slave, "SLAVE ");

await master.start();
await slave.start();
await delay(200);

await runner.test("slave → master：基础请求", async () => {
  const r = await slave.DEALER("hello", { timeoutMs: 3000 });
  runner.assert(toText(r) === "M:hello", `响应内容匹配 → "${toText(r)}"`);
});

await runner.test("master → slave：主动发送", async () => {
  const r = await master.ROUTER("test-slave", "ping", { timeoutMs: 3000 });
  runner.assert(toText(r) === "S:ping", `响应内容匹配 → "${toText(r)}"`);
});

await runner.test("Buffer payload", async () => {
  const r = await slave.DEALER(Buffer.from("bin-data"), { timeoutMs: 3000 });
  runner.assert(
    toText(r) === "M:bin-data",
    `Buffer payload 正常 → "${toText(r)}"`,
  );
});

await runner.test("并发 100 条请求（全部内容一致性校验）", async () => {
  logSilent = true;
  log("    [并发] 正在发送 100 条请求...");

  const tasks = Array.from({ length: 100 }, (_, i) =>
    slave.DEALER(`item-${i}`, { timeoutMs: 5000 }),
  );
  const results = await Promise.all(tasks);

  logSilent = false;
  log(`    [并发] 全部完成：发出 100 条 / 收到 ${results.length} 条`);

  const allOk = results.every((r, i) => toText(r) === `M:item-${i}`);
  runner.assert(allOk, "100 条并发响应内容全部匹配，无乱序");
});

// ══════════════════════════════════════════════════════════
//  载荷与 API 边界
// ══════════════════════════════════════════════════════════

runner.section("载荷与 API 边界");

await runner.test("Uint8Array payload", async () => {
  const r = await slave.DEALER(new Uint8Array([65, 66, 67]), {
    timeoutMs: 3000,
  });
  runner.assert(toText(r) === "M:ABC", `Uint8Array 正常 → "${toText(r)}"`);
});

await runner.test("多帧 payload 保持顺序与内容", async () => {
  const EP_PAYLOAD = "tcp://127.0.0.1:16015";
  const mP = new ZNL({
    role: "master",
    id: "m-payload",
    endpoints: { router: EP_PAYLOAD },
  });
  const sP = new ZNL({
    role: "slave",
    id: "s-payload",
    endpoints: { router: EP_PAYLOAD },
  });

  mP.ROUTER(async ({ payload }) => payload);

  await mP.start();
  await sP.start();
  await delay(150);

  const frames = ["a", Buffer.from("b"), new Uint8Array([99])];
  const rep = await sP.DEALER(frames, { timeoutMs: 3000 });

  runner.assert(Array.isArray(rep), "多帧响应类型为数组");
  const texts = rep.map(toText);
  runner.assert(
    texts.join("|") === "a|b|c",
    `多帧内容匹配 → "${texts.join("|")}"`,
  );

  await sP.stop();
  await mP.stop();
});

await runner.test("非法 payload 类型应抛错", async () => {
  let threw = false;
  try {
    await slave.DEALER({ bad: true }, { timeoutMs: 1000 });
  } catch (e) {
    threw = true;
    runner.assert(
      String(e?.message ?? e).includes("payload"),
      `错误信息包含 payload → "${e?.message ?? e}"`,
    );
  }
  if (!threw) runner.fail("未抛错（非法 payload）");
});

await runner.test("start()/stop() 可重复调用且无异常", async () => {
  const EP_IDEMP = "tcp://127.0.0.1:16016";
  const mI = new ZNL({
    role: "master",
    id: "m-idemp",
    endpoints: { router: EP_IDEMP },
  });
  const sI = new ZNL({
    role: "slave",
    id: "s-idemp",
    endpoints: { router: EP_IDEMP },
  });

  await mI.start();
  await mI.start();
  await sI.start();
  await sI.start();

  await sI.stop();
  await sI.stop();
  await mI.stop();
  await mI.stop();

  runner.assert(true, "start/stop 重复调用正常");
});

await runner.test("stop 后重新 start 可恢复通信", async () => {
  const EP_RS = "tcp://127.0.0.1:16023";
  const mR = new ZNL({
    role: "master",
    id: "m-r",
    endpoints: { router: EP_RS },
  });
  const sR = new ZNL({
    role: "slave",
    id: "s-r",
    endpoints: { router: EP_RS },
  });

  mR.ROUTER(async ({ payload }) => `MR:${toText(payload)}`);

  await mR.start();
  await sR.start();
  await delay(100);

  const r1 = await sR.DEALER("first", { timeoutMs: 2000 });
  runner.assert(toText(r1) === "MR:first", `首次通信正常 → "${toText(r1)}"`);

  await sR.stop();
  await mR.stop();

  await mR.start();
  await sR.start();
  await delay(150);

  const r2 = await sR.DEALER("second", { timeoutMs: 2000 });
  runner.assert(toText(r2) === "MR:second", `重启后通信正常 → "${toText(r2)}"`);

  await sR.stop();
  await mR.stop();
});

await runner.test("未 start 时调用 DEALER/ROUTER 应抛错", async () => {
  const EP_PRE = "tcp://127.0.0.1:16017";
  const mPre = new ZNL({
    role: "master",
    id: "m-pre",
    endpoints: { router: EP_PRE },
  });
  const sPre = new ZNL({
    role: "slave",
    id: "s-pre",
    endpoints: { router: EP_PRE },
  });

  let dealerErr = null;
  let routerErr = null;

  try {
    await sPre.DEALER("ping", { timeoutMs: 200 });
  } catch (e) {
    dealerErr = e;
  }

  try {
    await mPre.ROUTER("s-pre", "ping", { timeoutMs: 200 });
  } catch (e) {
    routerErr = e;
  }

  runner.assert(
    String(dealerErr?.message ?? dealerErr).includes("socket"),
    `DEALER 未 start 抛错 → "${dealerErr?.message ?? dealerErr}"`,
  );
  runner.assert(
    String(routerErr?.message ?? routerErr).includes("socket"),
    `ROUTER 未 start 抛错 → "${routerErr?.message ?? routerErr}"`,
  );
});

await runner.test("maxPending 达到上限时拒绝新请求", async () => {
  const EP_MP = "tcp://127.0.0.1:16018";
  const mMp = new ZNL({
    role: "master",
    id: "m-mp",
    endpoints: { router: EP_MP },
  });
  const sMp = new ZNL({
    role: "slave",
    id: "s-mp",
    endpoints: { router: EP_MP },
    maxPending: 1,
  });

  mMp.ROUTER(async () => {
    await delay(300);
    return "ok";
  });

  await mMp.start();
  await sMp.start();
  await delay(150);

  const p1 = sMp.DEALER("one", { timeoutMs: 1000 });
  let err = null;

  try {
    await sMp.DEALER("two", { timeoutMs: 300 });
  } catch (e) {
    err = e;
  }

  runner.assert(
    String(err?.message ?? err).includes("并发请求数已达上限"),
    `maxPending 拒绝新请求 → "${err?.message ?? err}"`,
  );

  await p1;
  await sMp.stop();
  await mMp.stop();
});

// ══════════════════════════════════════════════════════════
//  认证失败检测
// ══════════════════════════════════════════════════════════

runner.section("认证失败检测");

await runner.test(
  "错误 authKey（encrypted=true）→ master 丢弃请求并触发 auth_failed 事件",
  async () => {
    const EP_AUTH = "tcp://127.0.0.1:16014";
    const mAuth = new ZNL({
      role: "master",
      id: "m-auth",
      endpoints: { router: EP_AUTH },
      authKey: "right-key",
      encrypted: true,
    });
    const badSlave = new ZNL({
      role: "slave",
      id: "bad-slave",
      endpoints: { router: EP_AUTH },
      authKey: "wrong-key",
      encrypted: true,
    });

    let authFailedFired = false;
    mAuth.once("auth_failed", ({ identityText, reason }) => {
      authFailedFired = true;
      log(
        `    [MASTER] ✗ AUTH  from=${identityText}  reason="${reason ?? "<unknown>"}"`,
      );
    });

    await mAuth.start();
    await badSlave.start();
    await delay(100);

    try {
      await badSlave.DEALER("forbidden", { timeoutMs: 800 });
      runner.fail("不应收到响应");
    } catch (e) {
      runner.assert(
        e.message.includes("请求超时"),
        `请求正确超时 → "${e.message}"`,
      );
      runner.assert(authFailedFired, "auth_failed 事件已触发");
    } finally {
      await badSlave.stop();
      await mAuth.stop();
    }
  },
);

await runner.test(
  "错误 master key（encrypted=true）→ slave 触发 auth_failed",
  async () => {
    const EP_AUTH2 = "tcp://127.0.0.1:16019";
    const mWrong = new ZNL({
      role: "master",
      id: "m-wrong",
      endpoints: { router: EP_AUTH2 },
      authKey: "wrong-master-key",
      encrypted: true,
    });
    const sRight = new ZNL({
      role: "slave",
      id: "s-right",
      endpoints: { router: EP_AUTH2 },
      authKey: "right-slave-key",
      encrypted: true,
    });

    let slaveAuthFailed = false;
    sRight.on("auth_failed", ({ reason }) => {
      slaveAuthFailed = true;
      log(`    [SLAVE] ✗ AUTH  reason="${reason ?? "<unknown>"}"`);
    });

    await mWrong.start();
    await sRight.start();
    await delay(150);

    try {
      await mWrong.ROUTER("s-right", "ping", { timeoutMs: 800 });
      runner.fail("错误 master key 不应收到响应");
    } catch (e) {
      runner.assert(
        e.message.includes("请求超时"),
        `请求正确超时 → "${e.message}"`,
      );
      runner.assert(slaveAuthFailed, "slave 侧 auth_failed 事件已触发");
    } finally {
      await sRight.stop();
      await mWrong.stop();
    }
  },
);

// ══════════════════════════════════════════════════════════
//  超时控制
// ══════════════════════════════════════════════════════════

runner.section("超时控制");

await runner.test("master 无处理器 → slave 在指定时间内正确超时", async () => {
  const EP2 = "tcp://127.0.0.1:16004";
  const m2 = new ZNL({ role: "master", id: "m2", endpoints: { router: EP2 } });
  const s2 = new ZNL({ role: "slave", id: "s2", endpoints: { router: EP2 } });

  attachLogger(m2, "M2    ");
  attachLogger(s2, "S2    ");

  await m2.start();
  await s2.start();
  await delay(100);

  const t0 = Date.now();
  try {
    await s2.DEALER("no-reply", { timeoutMs: 400 });
    runner.fail("不应收到响应");
  } catch (e) {
    const elapsed = Date.now() - t0;
    runner.assert(e.message.includes("请求超时"), `正确超时 → "${e.message}"`);
    runner.assert(
      elapsed >= scaleMs(380) && elapsed < scaleMs(1500),
      `超时时机合理 → ${elapsed}ms`,
    );
  } finally {
    await s2.stop();
    await m2.stop();
  }
});

// ══════════════════════════════════════════════════════════
//  stop() 取消 pending
// ══════════════════════════════════════════════════════════

runner.section("stop() 取消 pending");

await runner.test("stop() 期间所有 in-flight 请求立即 reject", async () => {
  const EP3 = "tcp://127.0.0.1:16005";
  const m3 = new ZNL({ role: "master", id: "m3", endpoints: { router: EP3 } });
  const s3 = new ZNL({ role: "slave", id: "s3", endpoints: { router: EP3 } });

  attachLogger(m3, "M3    ");
  attachLogger(s3, "S3    ");

  m3.ROUTER(async () => {
    await delay(3000);
    return "late";
  });

  await m3.start();
  await s3.start();
  await delay(100);

  const reqPromise = s3.DEALER("long-req", { timeoutMs: 10000 });

  await delay(150);
  await s3.stop();

  try {
    await reqPromise;
    runner.fail("stop 后不应收到响应");
  } catch (e) {
    runner.assert(
      e.message.includes("已停止") || e.message.includes("cancelled"),
      `stop 后正确 reject → "${e.message}"`,
    );
  } finally {
    await m3.stop();
  }
});

// ══════════════════════════════════════════════════════════
//  PUB/SUB/PUSH 广播
// ══════════════════════════════════════════════════════════

runner.section("PUB/SUB/PUSH 广播");

await runner.test(
  "slave 只收到已订阅的 topic，未订阅的 topic 静默丢弃",
  async () => {
    const EP4 = "tcp://127.0.0.1:16006";
    const m4 = new ZNL({
      role: "master",
      id: "m4",
      endpoints: { router: EP4 },
    });
    const s4 = new ZNL({ role: "slave", id: "s4", endpoints: { router: EP4 } });

    const received = [];

    s4.SUBSCRIBE("news", ({ topic, payload }) => {
      received.push({ topic, text: toText(payload) });
    });

    await m4.start();
    await s4.start();
    await delay(200);

    runner.assert(
      m4.slaves.includes("s4"),
      `master.slaves 包含 s4 → ${m4.slaves}`,
    );

    m4.PUBLISH("news", "breaking news!");
    m4.PUBLISH("weather", "sunny day");
    await delay(100);

    runner.assert(
      received.length === 1,
      `只收到 1 条（news）→ 实际 ${received.length} 条`,
    );
    runner.assert(
      received[0]?.text === "breaking news!",
      `内容匹配 → "${received[0]?.text}"`,
    );
    runner.assert(
      received[0]?.topic === "news",
      `topic 匹配 → "${received[0]?.topic}"`,
    );

    await s4.stop();
    await m4.stop();
  },
);

await runner.test(
  "多 slave 广播：每个 slave 都能收到，slave.on('publish') 兜底监听（PUBLISH）",
  async () => {
    const EP5 = "tcp://127.0.0.1:16007";
    const m5 = new ZNL({
      role: "master",
      id: "m5",
      endpoints: { router: EP5 },
    });
    const s5a = new ZNL({
      role: "slave",
      id: "s5a",
      endpoints: { router: EP5 },
    });
    const s5b = new ZNL({
      role: "slave",
      id: "s5b",
      endpoints: { router: EP5 },
    });

    const s5aLog = [];
    const s5bLog = [];

    s5a.SUBSCRIBE("chat", ({ payload }) => s5aLog.push(toText(payload)));
    s5b.on("publish", ({ topic, payload }) =>
      s5bLog.push(`${topic}:${toText(payload)}`),
    );

    await m5.start();
    await s5a.start();
    await s5b.start();
    await delay(200);

    runner.assert(m5.slaves.length === 2, `2 个 slave 已注册 → ${m5.slaves}`);

    m5.PUBLISH("chat", "hello everyone");
    m5.PUBLISH("system", "server ok");
    await delay(100);

    runner.assert(s5aLog.length === 1, `s5a 收到 1 条 → 实际 ${s5aLog.length}`);
    runner.assert(
      s5aLog[0] === "hello everyone",
      `s5a 内容匹配 → "${s5aLog[0]}"`,
    );

    runner.assert(s5bLog.length === 2, `s5b 收到 2 条 → 实际 ${s5bLog.length}`);
    runner.assert(s5bLog.includes("chat:hello everyone"), "s5b 包含 chat 消息");
    runner.assert(s5bLog.includes("system:server ok"), "s5b 包含 system 消息");

    await s5a.stop();
    await s5b.stop();
    await m5.stop();
  },
);

await runner.test(
  "slave_connected / slave_disconnected 事件在 start/stop 时正确触发",
  async () => {
    const EP6 = "tcp://127.0.0.1:16008";
    const m6 = new ZNL({
      role: "master",
      id: "m6",
      endpoints: { router: EP6 },
    });
    const s6 = new ZNL({ role: "slave", id: "s6", endpoints: { router: EP6 } });

    const connected = [];
    const disconnected = [];
    m6.on("slave_connected", (id) => connected.push(id));
    m6.on("slave_disconnected", (id) => disconnected.push(id));

    await m6.start();
    await s6.start();
    await delay(200);

    runner.assert(
      connected.includes("s6"),
      `slave_connected 事件触发 → ${connected}`,
    );
    runner.assert(m6.slaves.includes("s6"), `master.slaves 包含 s6`);
    runner.assert(disconnected.length === 0, "尚未触发 slave_disconnected");

    await s6.stop();
    await delay(100);

    runner.assert(
      disconnected.includes("s6"),
      `slave_disconnected 事件触发 → ${disconnected}`,
    );
    runner.assert(
      !m6.slaves.includes("s6"),
      `master.slaves 已移除 s6 → ${m6.slaves}`,
    );

    await m6.stop();
  },
);

await runner.test("UNSUBSCRIBE() 后不再收到该 topic 的消息", async () => {
  const EP7 = "tcp://127.0.0.1:16009";
  const m7 = new ZNL({ role: "master", id: "m7", endpoints: { router: EP7 } });
  const s7 = new ZNL({ role: "slave", id: "s7", endpoints: { router: EP7 } });

  const logList = [];
  s7.SUBSCRIBE("ping", ({ payload }) => logList.push(toText(payload)));

  await m7.start();
  await s7.start();
  await delay(200);

  m7.PUBLISH("ping", "first");
  await delay(100);
  runner.assert(
    logList.length === 1,
    `订阅期间收到第 1 条 → ${logList.length} 条`,
  );

  s7.UNSUBSCRIBE("ping");
  m7.PUBLISH("ping", "second");
  await delay(100);
  runner.assert(
    logList.length === 1,
    `取消订阅后不再收到消息 → 仍是 ${logList.length} 条`,
  );

  await s7.stop();
  await m7.stop();
});

await runner.test("PUSH：slave 单向推送 master 收到 push 事件", async () => {
  const EP_PUSH = "tcp://127.0.0.1:16010";
  const mPush = new ZNL({
    role: "master",
    id: "m-push",
    endpoints: { router: EP_PUSH },
  });
  const sPush = new ZNL({
    role: "slave",
    id: "s-push",
    endpoints: { router: EP_PUSH },
  });

  const received = [];
  mPush.on("push", ({ identityText, topic, payload }) => {
    received.push({ identityText, topic, text: toText(payload) });
  });

  await mPush.start();
  await sPush.start();
  await delay(200);

  sPush.PUSH("metrics", "cpu=0.42");
  await delay(120);

  runner.assert(received.length === 1, `收到 1 条 push → ${received.length}`);
  runner.assert(
    received[0]?.identityText === "s-push",
    `identity 匹配 → "${received[0]?.identityText}"`,
  );
  runner.assert(
    received[0]?.topic === "metrics",
    `topic 匹配 → "${received[0]?.topic}"`,
  );
  runner.assert(
    received[0]?.text === "cpu=0.42",
    `payload 匹配 → "${received[0]?.text}"`,
  );

  await sPush.stop();
  await mPush.stop();
});

await runner.test("master 重启后 slave 自动补注册并恢复广播", async () => {
  const EP_RESTART = "tcp://127.0.0.1:16011";

  const m9 = new ZNL({
    role: "master",
    id: "m9",
    endpoints: { router: EP_RESTART },
    heartbeatInterval: scaleMs(200),
  });
  const s9 = new ZNL({
    role: "slave",
    id: "s9",
    endpoints: { router: EP_RESTART },
    heartbeatInterval: scaleMs(200),
  });

  const received = [];
  s9.SUBSCRIBE("news", ({ payload }) => received.push(toText(payload)));

  await m9.start();
  await s9.start();
  await delay(200);

  runner.assert(m9.slaves.includes("s9"), `首次注册成功 → ${m9.slaves}`);

  await m9.stop();
  await delay(300);

  const m9b = new ZNL({
    role: "master",
    id: "m9b",
    endpoints: { router: EP_RESTART },
    heartbeatInterval: scaleMs(200),
  });
  await m9b.start();

  let registered = false;
  for (let i = 0; i < 20; i++) {
    if (m9b.slaves.includes("s9")) {
      registered = true;
      break;
    }
    await delay(100);
  }
  runner.assert(registered, `重启后自动补注册成功 → ${m9b.slaves}`);

  m9b.PUBLISH("news", "after-restart");
  await delay(150);
  runner.assert(
    received.includes("after-restart"),
    `重启后广播可达 → ${received.join(",")}`,
  );

  await s9.stop();
  await m9b.stop();
});

await runner.test(
  "slave 侧外部 API：masterOnline / isMasterOnline 状态正确",
  async () => {
    const EP_ONLINE = "tcp://127.0.0.1:16030";

    const mOnline = new ZNL({
      role: "master",
      id: "m-online",
      endpoints: { router: EP_ONLINE },
      heartbeatInterval: scaleMs(120),
      heartbeatTimeoutMs: scaleMs(240),
    });
    const sOnline = new ZNL({
      role: "slave",
      id: "s-online",
      endpoints: { router: EP_ONLINE },
      heartbeatInterval: scaleMs(120),
      heartbeatTimeoutMs: scaleMs(240),
    });

    runner.assert(
      sOnline.masterOnline === false,
      "启动前 masterOnline 默认为 false",
    );
    runner.assert(
      sOnline.isMasterOnline() === false,
      "启动前 isMasterOnline() 默认为 false",
    );

    await mOnline.start();
    await sOnline.start();

    let becameOnline = false;
    for (let i = 0; i < 20; i++) {
      if (sOnline.masterOnline && sOnline.isMasterOnline()) {
        becameOnline = true;
        break;
      }
      await delay(100);
    }

    runner.assert(becameOnline, "收到 heartbeat_ack 后主节点状态变为在线");
    runner.assert(sOnline.masterOnline === true, "masterOnline 属性为 true");
    runner.assert(
      sOnline.isMasterOnline() === true,
      "isMasterOnline() 返回 true",
    );

    await mOnline.stop();

    let becameOffline = false;
    for (let i = 0; i < 25; i++) {
      if (!sOnline.masterOnline && !sOnline.isMasterOnline()) {
        becameOffline = true;
        break;
      }
      await delay(100);
    }

    runner.assert(becameOffline, "心跳应答超时后主节点状态变为离线");
    runner.assert(
      sOnline.masterOnline === false,
      "masterOnline 属性恢复为 false",
    );
    runner.assert(
      sOnline.isMasterOnline() === false,
      "isMasterOnline() 返回 false",
    );

    await sOnline.stop();
  },
);

await runner.test(
  "heartbeat_ack：master 重启后 slave 自动恢复在线并恢复 RPC",
  async () => {
    const EP_HB_ACK = "tcp://127.0.0.1:16031";

    const mAck1 = new ZNL({
      role: "master",
      id: "m-ack-1",
      endpoints: { router: EP_HB_ACK },
      heartbeatInterval: scaleMs(120),
      heartbeatTimeoutMs: scaleMs(240),
    });
    const sAck = new ZNL({
      role: "slave",
      id: "s-ack",
      endpoints: { router: EP_HB_ACK },
      heartbeatInterval: scaleMs(120),
      heartbeatTimeoutMs: scaleMs(240),
    });

    await mAck1.ROUTER(async ({ payload }) => `ack-1:${toText(payload)}`);
    await mAck1.start();
    await sAck.start();

    let online1 = false;
    for (let i = 0; i < 20; i++) {
      if (sAck.masterOnline) {
        online1 = true;
        break;
      }
      await delay(100);
    }
    runner.assert(online1, "首次 heartbeat_ack 建立在线状态");

    const reply1 = await sAck.DEALER("ping-before-restart", {
      timeoutMs: 1200,
    });
    runner.assert(
      toText(reply1) === "ack-1:ping-before-restart",
      `重启前 RPC 正常 → "${toText(reply1)}"`,
    );

    await mAck1.stop();

    let offline = false;
    for (let i = 0; i < 25; i++) {
      if (!sAck.masterOnline) {
        offline = true;
        break;
      }
      await delay(100);
    }
    runner.assert(offline, "master 下线后 slave 能感知离线");

    const mAck2 = new ZNL({
      role: "master",
      id: "m-ack-2",
      endpoints: { router: EP_HB_ACK },
      heartbeatInterval: scaleMs(120),
      heartbeatTimeoutMs: scaleMs(240),
    });
    await mAck2.ROUTER(async ({ payload }) => `ack-2:${toText(payload)}`);
    await mAck2.start();

    let reOnline = false;
    for (let i = 0; i < 30; i++) {
      if (sAck.masterOnline && mAck2.slaves.includes("s-ack")) {
        reOnline = true;
        break;
      }
      await delay(100);
    }

    runner.assert(reOnline, `重启后重新在线成功 → ${mAck2.slaves}`);
    runner.assert(
      sAck.isMasterOnline() === true,
      "重启后 isMasterOnline() 返回 true",
    );

    const reply2 = await sAck.DEALER("ping-after-restart", { timeoutMs: 1500 });
    runner.assert(
      toText(reply2) === "ack-2:ping-after-restart",
      `重启后 RPC 恢复正常 → "${toText(reply2)}"`,
    );

    await sAck.stop();
    await mAck2.stop();
  },
);

// ══════════════════════════════════════════════════════════
//  心跳
// ══════════════════════════════════════════════════════════

runner.section("心跳");

await runner.test("心跳禁用（heartbeatInterval=0）不移除节点", async () => {
  const EP_HB0 = "tcp://127.0.0.1:16028";
  const mH0 = new ZNL({
    role: "master",
    id: "m-hb0",
    endpoints: { router: EP_HB0 },
    heartbeatInterval: 0,
  });

  await mH0.start();

  const dealer = new zmq.Dealer({ routingId: "hb0-slave" });
  dealer.connect(EP_HB0);
  await dealer.send([CONTROL_PREFIX, CONTROL_REGISTER]);

  await delay(200);
  runner.assert(
    mH0.slaves.includes("hb0-slave"),
    `hb0-slave 已注册 → ${mH0.slaves}`,
  );

  await delay(1200);
  runner.assert(mH0.slaves.includes("hb0-slave"), "心跳禁用后未被移除");

  dealer.close();
  await mH0.stop();
});

await runner.test("自定义 heartbeatTimeoutMs 生效", async () => {
  const EP_HB = "tcp://127.0.0.1:16029";
  const mH = new ZNL({
    role: "master",
    id: "m-hb",
    endpoints: { router: EP_HB },
    heartbeatInterval: scaleMs(100),
    heartbeatTimeoutMs: scaleMs(250),
  });

  await mH.start();

  const dealer = new zmq.Dealer({ routingId: "hb-slave" });
  dealer.connect(EP_HB);
  await dealer.send([CONTROL_PREFIX, CONTROL_REGISTER]);

  await delay(150);
  runner.assert(
    mH.slaves.includes("hb-slave"),
    `hb-slave 已注册 → ${mH.slaves}`,
  );

  await delay(400);
  runner.assert(
    !mH.slaves.includes("hb-slave"),
    `超过 timeoutMs 后被移除 → ${mH.slaves}`,
  );

  dealer.close();
  await mH.stop();
});

// ══════════════════════════════════════════════════════════
//  安全集成（auth/encrypted）
/* eslint-disable max-statements */
// ══════════════════════════════════════════════════════════

runner.section("encrypted 安全集成");

await runner.test(
  "encrypted 模式：RPC + PUB/SUB 正常（透明加解密）",
  async () => {
    const EP10 = "tcp://127.0.0.1:16012";
    const KEY = "sec-encrypted-key-001";

    const m10 = new ZNL({
      role: "master",
      id: "m10",
      endpoints: { router: EP10 },
      authKey: KEY,
      encrypted: true,
    });
    const s10 = new ZNL({
      role: "slave",
      id: "s10",
      endpoints: { router: EP10 },
      authKey: KEY,
      encrypted: true,
    });

    const pubLog = [];
    s10.SUBSCRIBE("news", ({ payload }) => pubLog.push(toText(payload)));

    m10.ROUTER(async ({ payload }) => `ENC-M:${toText(payload)}`);
    s10.DEALER(async ({ payload }) => `ENC-S:${toText(payload)}`);

    await m10.start();
    await s10.start();
    await delay(250);

    const r1 = await s10.DEALER("hello-encrypted", { timeoutMs: 3000 });
    runner.assert(
      toText(r1) === "ENC-M:hello-encrypted",
      `encrypted slave→master 正常 → "${toText(r1)}"`,
    );

    const r2 = await m10.ROUTER("s10", "ping-encrypted", { timeoutMs: 3000 });
    runner.assert(
      toText(r2) === "ENC-S:ping-encrypted",
      `encrypted master→slave 正常 → "${toText(r2)}"`,
    );

    m10.PUBLISH("news", "encrypted-news-1");
    await delay(120);
    runner.assert(
      pubLog.length === 1,
      `encrypted 广播收到 1 条 → ${pubLog.length}`,
    );
    runner.assert(
      pubLog[0] === "encrypted-news-1",
      `encrypted 广播内容匹配 → "${pubLog[0]}"`,
    );

    await s10.stop();
    await m10.stop();
  },
);

await runner.test(
  "encrypted 模式：payloadDigest 配置不一致（PUBLISH）触发 auth_failed",
  async () => {
    const EP_PD = "tcp://127.0.0.1:16024";
    const KEY = "sec-encrypted-pub-digest";

    const mPD = new ZNL({
      role: "master",
      id: "m-pd",
      endpoints: { router: EP_PD },
      authKey: KEY,
      encrypted: true,
      enablePayloadDigest: false, // 故意不写 digest
    });
    const sPD = new ZNL({
      role: "slave",
      id: "s-pd",
      endpoints: { router: EP_PD },
      authKey: KEY,
      encrypted: true,
      enablePayloadDigest: true, // 强制校验
    });

    let authFailed = false;
    let received = false;
    sPD.on("auth_failed", () => {
      authFailed = true;
    });
    sPD.SUBSCRIBE("news", () => {
      received = true;
    });

    await mPD.start();
    await sPD.start();
    await delay(200);

    mPD.PUBLISH("news", "digest-mismatch");
    await delay(200);

    runner.assert(authFailed, "slave 侧 auth_failed 已触发");
    runner.assert(!received, "认证失败不应收到 PUBLISH");

    await sPD.stop();
    await mPD.stop();
  },
);

await runner.test("encrypted 模式：关闭 payloadDigest 后仍可通信", async () => {
  const EP_PD_OFF = "tcp://127.0.0.1:16037";
  const KEY = "sec-encrypted-digest-off";

  const mPD0 = new ZNL({
    role: "master",
    id: "m-pd0",
    endpoints: { router: EP_PD_OFF },
    authKey: KEY,
    encrypted: true,
    enablePayloadDigest: false,
  });
  const sPD0 = new ZNL({
    role: "slave",
    id: "s-pd0",
    endpoints: { router: EP_PD_OFF },
    authKey: KEY,
    encrypted: true,
    enablePayloadDigest: false,
  });

  mPD0.ROUTER(async ({ payload }) => `MPD0:${toText(payload)}`);

  await mPD0.start();
  await sPD0.start();
  await delay(150);

  const r = await sPD0.DEALER("no-digest", { timeoutMs: 2000 });
  runner.assert(
    toText(r) === "MPD0:no-digest",
    `关闭摘要仍可通信 → "${toText(r)}"`,
  );

  await sPD0.stop();
  await mPD0.stop();
});

await runner.test(
  "encrypted 模式：payloadDigest 配置不一致（RPC）可能导致认证失败",
  async () => {
    const EP_PD_RPC = "tcp://127.0.0.1:16038";
    const KEY = "sec-encrypted-digest-rpc";

    const mPR = new ZNL({
      role: "master",
      id: "m-pr",
      endpoints: { router: EP_PD_RPC },
      authKey: KEY,
      encrypted: true,
      enablePayloadDigest: true,
    });
    const sPR = new ZNL({
      role: "slave",
      id: "s-pr",
      endpoints: { router: EP_PD_RPC },
      authKey: KEY,
      encrypted: true,
      enablePayloadDigest: false, // 故意不一致
    });

    let authFailedFired = false;
    mPR.on("auth_failed", () => {
      authFailedFired = true;
    });

    mPR.ROUTER(async ({ payload }) => `MPR:${toText(payload)}`);

    await mPR.start();
    await sPR.start();
    await delay(150);

    try {
      await sPR.DEALER("digest-mismatch", { timeoutMs: 800 });
      runner.fail("配置不一致不应收到响应");
    } catch (e) {
      runner.assert(
        e.message.includes("请求超时"),
        `请求正确超时 → "${e.message}"`,
      );
      runner.assert(authFailedFired, "master 侧 auth_failed 事件已触发");
    } finally {
      await sPR.stop();
      await mPR.stop();
    }
  },
);

await runner.test(
  "encrypted 模式：防重放（同 nonce+requestId）触发拒绝",
  async () => {
    const EP_RP = "tcp://127.0.0.1:16030";
    const KEY = "sec-replay-key";
    const NODE = "replay-slave";

    const mR = new ZNL({
      role: "master",
      id: "m-replay",
      endpoints: { router: EP_RP },
      authKey: KEY,
      encrypted: true,
    });

    let requestCount = 0;
    let authFailed = 0;
    mR.on("request", () => {
      requestCount++;
    });
    mR.on("auth_failed", () => {
      authFailed++;
    });
    mR.ROUTER(async () => "ok");

    await mR.start();

    const dealer = new zmq.Dealer({ routingId: NODE });
    dealer.connect(EP_RP);
    await delay(100);

    const requestId = "replay-req-001";
    const nonce = "fixed-nonce-001";
    const ts = Date.now();

    const { frames } = buildEncryptedRequestFrames({
      authKey: KEY,
      nodeId: NODE,
      requestId,
      payload: "hello",
      nonce,
      timestamp: ts,
    });

    await dealer.send(frames);
    await delay(150);

    await dealer.send(frames); // 同 nonce + requestId
    await delay(200);

    runner.assert(requestCount === 1, `仅接受一次请求 → ${requestCount}`);
    runner.assert(authFailed >= 1, `重放触发 auth_failed → ${authFailed}`);

    dealer.close();
    await mR.stop();
  },
);

await runner.test(
  "encrypted 模式：同 nonce 不同 requestId 不应触发重放",
  async () => {
    const EP_RP2 = "tcp://127.0.0.1:16039";
    const KEY = "sec-replay-key-2";
    const NODE = "replay-slave-2";

    const mR2 = new ZNL({
      role: "master",
      id: "m-replay-2",
      endpoints: { router: EP_RP2 },
      authKey: KEY,
      encrypted: true,
    });

    let requestCount = 0;
    let authFailed = 0;
    mR2.on("request", () => {
      requestCount++;
    });
    mR2.on("auth_failed", () => {
      authFailed++;
    });
    mR2.ROUTER(async () => "ok");

    await mR2.start();

    const dealer = new zmq.Dealer({ routingId: NODE });
    dealer.connect(EP_RP2);
    await delay(100);

    const nonce = "fixed-nonce-002";
    const ts = Date.now();

    const { frames: frames1 } = buildEncryptedRequestFrames({
      authKey: KEY,
      nodeId: NODE,
      requestId: "replay-req-a",
      payload: "hello-a",
      nonce,
      timestamp: ts,
    });

    const { frames: frames2 } = buildEncryptedRequestFrames({
      authKey: KEY,
      nodeId: NODE,
      requestId: "replay-req-b",
      payload: "hello-b",
      nonce,
      timestamp: ts,
    });

    await dealer.send(frames1);
    await delay(120);
    await dealer.send(frames2);
    await delay(200);

    runner.assert(requestCount === 2, `两次请求均应接受 → ${requestCount}`);
    runner.assert(authFailed === 0, `不应触发 auth_failed → ${authFailed}`);

    dealer.close();
    await mR2.stop();
  },
);

await runner.test("encrypted 模式：时间漂移超限被拒绝", async () => {
  const EP_TS = "tcp://127.0.0.1:16033";
  const KEY = "sec-time-skew";
  const NODE = "time-skew-slave";

  const mT = new ZNL({
    role: "master",
    id: "m-time",
    endpoints: { router: EP_TS },
    authKey: KEY,
    encrypted: true,
    maxTimeSkewMs: 50,
  });

  let authFailed = false;
  mT.on("auth_failed", () => {
    authFailed = true;
  });
  mT.ROUTER(async () => "ok");

  await mT.start();

  const dealer = new zmq.Dealer({ routingId: NODE });
  dealer.connect(EP_TS);
  await delay(80);

  const requestId = "time-req-001";
  const nonce = "time-nonce-001";
  const oldTs = Date.now() - 10_000;

  const { frames } = buildEncryptedRequestFrames({
    authKey: KEY,
    nodeId: NODE,
    requestId,
    payload: "hello",
    nonce,
    timestamp: oldTs,
  });

  await dealer.send(frames);
  await delay(200);

  runner.assert(authFailed, "过期时间戳触发 auth_failed");

  dealer.close();
  await mT.stop();
});

await runner.test("authKeyMap 优先级：命中 map 时不回退", async () => {
  const EP_PRI = "tcp://127.0.0.1:16034";

  const mP = new ZNL({
    role: "master",
    id: "m-pri",
    endpoints: { router: EP_PRI },
    authKey: "fallback-key",
    authKeyMap: { sPri: "map-key" },
    encrypted: true,
  });

  let authFailed = false;
  mP.on("auth_failed", () => {
    authFailed = true;
  });

  const sPriWrong = new ZNL({
    role: "slave",
    id: "sPri",
    endpoints: { router: EP_PRI },
    authKey: "fallback-key", // 应失败（map 优先）
    encrypted: true,
  });

  mP.ROUTER(async ({ payload }) => `MP:${toText(payload)}`);

  await mP.start();
  await sPriWrong.start();
  await delay(150);

  try {
    await sPriWrong.DEALER("should-fail", { timeoutMs: 600 });
    runner.fail("map 命中时不应回退到 authKey");
  } catch (e) {
    runner.assert(
      e.message.includes("请求超时"),
      `请求正确超时 → "${e.message}"`,
    );
    runner.assert(authFailed, "auth_failed 已触发");
  }

  await sPriWrong.stop();
  await delay(200);

  const sPriRight = new ZNL({
    role: "slave",
    id: "sPri",
    endpoints: { router: EP_PRI },
    authKey: "map-key",
    encrypted: true,
  });

  await sPriRight.start();
  await delay(150);

  let ok = false;
  let lastError = null;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await sPriRight.DEALER("ok", { timeoutMs: 1500 });
      runner.assert(toText(r) === "MP:ok", `map key 正常 → "${toText(r)}"`);
      ok = true;
      break;
    } catch (e) {
      lastError = e;
      await delay(200);
    }
  }
  if (!ok) {
    runner.fail(`重连后仍未通信成功 → "${lastError?.message ?? lastError}"`);
  }

  await sPriRight.stop();
  await mP.stop();
});

await runner.test("authKeyMap 更新后在线 key 立即切换", async () => {
  const EP_SW = "tcp://127.0.0.1:16035";

  const mS = new ZNL({
    role: "master",
    id: "m-sw",
    endpoints: { router: EP_SW },
    authKeyMap: { sSw: "k1" },
    encrypted: true,
  });

  const sSw = new ZNL({
    role: "slave",
    id: "sSw",
    endpoints: { router: EP_SW },
    authKey: "k1",
    encrypted: true,
  });

  mS.ROUTER(async ({ payload }) => `MS:${toText(payload)}`);

  await mS.start();
  await sSw.start();
  await delay(150);

  const registeredBefore = await waitForSlave(mS, "sSw", 3000);
  runner.assert(registeredBefore, `切换前已注册 → ${mS.slaves}`);

  const r1 = await sSw.DEALER("before-switch", { timeoutMs: 1500 });
  runner.assert(toText(r1) === "MS:before-switch", "切换前通信正常");

  // 切换 master key
  mS.addAuthKey("sSw", "k2");
  await delay(200);

  let failed = false;
  try {
    await sSw.DEALER("after-switch", { timeoutMs: 600 });
  } catch (e) {
    failed = String(e?.message ?? e).includes("请求超时");
  }
  runner.assert(failed, "切换后旧 key 失效");

  await sSw.stop();
  // 给 ROUTING_ID 交接留出时间，避免旧连接残留导致新连接注册/收发抖动
  await delay(500);

  const sSw2 = new ZNL({
    role: "slave",
    id: "sSw",
    endpoints: { router: EP_SW },
    authKey: "k2",
    encrypted: true,
  });

  await sSw2.start();
  await delay(250);

  let registered = false;
  let r2;
  let r2Err;
  for (let i = 0; i < 8; i++) {
    registered = registered || (await waitForSlave(mS, "sSw", 800));
    try {
      r2 = await sSw2.DEALER("after-reconnect", { timeoutMs: 1200 });
      r2Err = null;
      break;
    } catch (e) {
      r2Err = e;
      await delay(250);
    }
  }

  runner.assert(registered, `重连后注册成功 → ${mS.slaves}`);
  runner.assert(
    r2 && toText(r2) === "MS:after-reconnect",
    r2 ? "切换后新 key 生效" : `切换后新 key 生效 → ${r2Err?.message ?? r2Err}`,
  );

  await sSw2.stop();
  await mS.stop();
});

await runner.test(
  "encrypted 模式：authKeyMap 未命中时回退到 authKey",
  async () => {
    const EP16 = "tcp://127.0.0.1:16026";

    const m16 = new ZNL({
      role: "master",
      id: "m16",
      endpoints: { router: EP16 },
      authKey: "fallback-key",
      authKeyMap: { s16a: "k16a" },
      encrypted: true,
    });

    const s16b = new ZNL({
      role: "slave",
      id: "s16b",
      endpoints: { router: EP16 },
      authKey: "fallback-key",
      encrypted: true,
    });

    m16.ROUTER(async ({ payload }) => `M16:${toText(payload)}`);

    await m16.start();
    await s16b.start();
    await delay(150);

    const r = await s16b.DEALER("should-pass", { timeoutMs: 1500 });
    runner.assert(
      toText(r) === "M16:should-pass",
      `回退到 authKey 生效 → "${toText(r)}"`,
    );

    await s16b.stop();
    await m16.stop();
  },
);

await runner.test(
  "encrypted 模式：authKeyMap 动态 add/remove 立即生效",
  async () => {
    const EP17 = "tcp://127.0.0.1:16027";

    const m17 = new ZNL({
      role: "master",
      id: "m17",
      endpoints: { router: EP17 },
      authKeyMap: {},
      encrypted: true,
    });

    const s17 = new ZNL({
      role: "slave",
      id: "s17",
      endpoints: { router: EP17 },
      authKey: "k17",
      encrypted: true,
    });

    let authFailedFired = false;
    let disconnected = false;
    m17.on("auth_failed", () => {
      authFailedFired = true;
    });
    m17.on("slave_disconnected", (id) => {
      if (id === "s17") disconnected = true;
    });

    m17.ROUTER(async ({ payload }) => `M17:${toText(payload)}`);

    await m17.start();
    await s17.start();
    await delay(150);

    try {
      await s17.DEALER("before-add", { timeoutMs: 500 });
      runner.fail("未 addAuthKey 前不应收到响应");
    } catch (e) {
      runner.assert(
        e.message.includes("请求超时"),
        `请求正确超时 → "${e.message}"`,
      );
      runner.assert(authFailedFired, "master 侧 auth_failed 事件已触发");
    }

    m17.addAuthKey("s17", "k17");
    await delay(100);

    const r1 = await s17.DEALER("after-add", { timeoutMs: 1500 });
    runner.assert(
      toText(r1) === "M17:after-add",
      `addAuthKey 生效 → "${toText(r1)}"`,
    );

    m17.removeAuthKey("s17");
    await delay(100);
    runner.assert(disconnected, "removeAuthKey 触发 slave_disconnected");

    try {
      await s17.DEALER("after-remove", { timeoutMs: 500 });
      runner.fail("removeAuthKey 后不应收到响应");
    } catch (e) {
      runner.assert(
        e.message.includes("请求超时"),
        `请求正确超时 → "${e.message}"`,
      );
    } finally {
      await s17.stop();
      await m17.stop();
    }
  },
);

// ══════════════════════════════════════════════════════════
//  SendQueue 顺序（主→从请求顺序）
// ══════════════════════════════════════════════════════════

runner.section("SendQueue 顺序");

await runner.test("master→slave 顺序保持（20 条）", async () => {
  const EP_SQ = "tcp://127.0.0.1:16036";
  const mQ = new ZNL({
    role: "master",
    id: "m-sq",
    endpoints: { router: EP_SQ },
  });
  const sQ = new ZNL({
    role: "slave",
    id: "s-sq",
    endpoints: { router: EP_SQ },
  });

  const seq = [];
  await sQ.DEALER(async ({ payload }) => {
    const n = Number(toText(payload).split("-")[1] ?? -1);
    seq.push(n);
    return `ACK-${n}`;
  });

  await mQ.start();
  await sQ.start();
  await delay(200);

  const tasks = Array.from({ length: 20 }, (_, i) =>
    mQ.ROUTER("s-sq", `seq-${i}`, { timeoutMs: 3000 }),
  );
  await Promise.all(tasks);

  const ok = seq.every((n, i) => n === i);
  runner.assert(ok, `顺序一致 → [${seq.join(", ")}]`);

  await sQ.stop();
  await mQ.stop();
});

// ══════════════════════════════════════════════════════════
//  PendingManager key 冲突保护（轻量单元）
// ══════════════════════════════════════════════════════════

runner.section("PendingManager key");

await runner.test("master→slave key 含 identity 避免碰撞", async () => {
  const pm = new PendingManager(10);
  const k1 = pm.key("req-1", "s1");
  const k2 = pm.key("req-1", "s2");
  runner.assert(k1 !== k2, `不同 identity key 不同 → ${k1} vs ${k2}`);
});

// ─── 清理主测试节点 ───────────────────────────────────────────────────────────

await slave.stop();
await master.stop();

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

runner.summary();
