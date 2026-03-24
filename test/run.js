/**
 * ZNL 集成测试
 *
 * 在同一进程内启动 Master / Slave 节点，完整验证库的核心功能：
 *  1. slave → master 基础请求
 *  2. master → slave 主动发送
 *  3. Buffer payload
 *  4. 并发 100 条请求
 *  5. 认证失败：错误 authKey 被 master 丢弃并触发 auth_failed 事件
 *  6. 请求超时：master 无处理器时 slave 正确超时
 *  7. stop() 取消所有 in-flight pending 请求
 *  8. PUB/SUB：topic 过滤、多 slave 广播、上下线事件、unsubscribe
 *  9. 心跳：slave 崩溃后 master 自动检测并移除
 * 10. encrypted 安全模式：透明加解密（RPC/PUB）与错误密钥拦截
 */

import * as zmq from "zeromq";
import { ZNL } from "../index.js";
import { CONTROL_PREFIX, CONTROL_REGISTER } from "../src/constants.js";

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

const toText = (p) => (Buffer.isBuffer(p) ? p.toString() : String(p));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const VERBOSE = /^(1|true|yes)$/i.test(process.env.ZNL_TEST_VERBOSE ?? "");
const log = (...args) => {
  if (VERBOSE) console.log(...args);
};

let passed = 0;
let failed = 0;
let testIndex = 0;

/**
 * 将 payload 格式化为短字符串显示（超过 60 字符时截断）
 * @param {Buffer|Array|string} p
 * @returns {string}
 */
const fmt = (p) => {
  const s = Array.isArray(p) ? p.map(toText).join(" | ") : toText(p);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/** 单项断言，自动计入统计 */
function assert(condition, label) {
  if (condition) {
    console.log(`    ✓ ${label}`);
    passed++;
  } else {
    console.error(`    ✗ ${label}`);
    failed++;
  }
}

/**
 * 包裹一个测试用例，捕获意外异常并统一格式化输出
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
async function test(label, fn) {
  testIndex++;
  const index = String(testIndex).padStart(2, "0");
  console.log(`\n  ▶ [${index}] ${label}`);
  try {
    await fn();
  } catch (e) {
    console.error(`    ✗ 未预期的异常：${e.message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n【${title}】`);
}

// ─── 收发日志 ─────────────────────────────────────────────────────────────────

/**
 * 并发测试期间设为 true，屏蔽单条 REQ/RES 日志避免刷屏
 * 并发结束后恢复为 false
 */
let logSilent = false;

/**
 * 为节点挂载收发日志监听器
 *
 * 监听两个事件（均在「接收方」触发）：
 *  - request  ：本节点收到对端发来的请求（认证通过后）
 *  - response ：本节点收到对端返回的响应
 *
 * 输出格式：
 *  [LABEL] ◀ REQ  from=<identity>  "<payload>"
 *  [LABEL] ◀ RES  from=<identity>  "<payload>"
 *
 * @param {ZNL} node
 * @param {string} label - 控制台显示名称（建议固定宽度方便对齐）
 */
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

// ─── 测试开始 ─────────────────────────────────────────────────────────────────

console.log("=".repeat(56));
console.log("  ZNL 集成测试");
console.log("=".repeat(56));
console.log(`  verbose=${VERBOSE ? "on" : "off"}`);

section("构造参数校验");

await test("role 非法应抛错", async () => {
  let threw = false;
  try {
    new ZNL({ role: "bad-role", id: "x" });
  } catch (e) {
    threw = true;
    assert(
      String(e?.message ?? e).includes("role"),
      `错误信息包含 role → "${e?.message ?? e}"`,
    );
  }
  if (!threw) assert(false, "未抛错（role 非法）");
});

await test("id 缺失应抛错", async () => {
  let threw = false;
  try {
    new ZNL({ role: "master" });
  } catch (e) {
    threw = true;
    assert(
      String(e?.message ?? e).includes("id"),
      `错误信息包含 id → "${e?.message ?? e}"`,
    );
  }
  if (!threw) assert(false, "未抛错（id 缺失）");
});

await test("encrypted=true 但未提供 authKey 应抛错", async () => {
  let threw = false;
  try {
    new ZNL({ role: "master", id: "m-enc", encrypted: true });
  } catch (e) {
    threw = true;
    assert(
      String(e?.message ?? e).includes("authKey"),
      `错误信息包含 authKey → "${e?.message ?? e}"`,
    );
  }
  if (!threw) assert(false, "未抛错（encrypted=true 缺少 authKey）");
});

// ══════════════════════════════════════════════════════════
//  测试组 1：基础双向通信 & 并发
// ══════════════════════════════════════════════════════════

section("基础双向通信 & 并发");

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

// 双向自动回复处理器：用前缀区分响应来源
master.ROUTER(async ({ payload }) => `M:${toText(payload)}`);
slave.DEALER(async ({ payload }) => `S:${toText(payload)}`);

// 挂载收发日志（在 start 之前注册，确保不遗漏任何消息）
attachLogger(master, "MASTER");
attachLogger(slave, "SLAVE ");

await master.start();
await slave.start();
await delay(200); // 等待 ZMQ 连接握手完成

await test("slave → master：基础请求", async () => {
  const r = await slave.DEALER("hello", { timeoutMs: 3000 });
  assert(toText(r) === "M:hello", `响应内容匹配 → "${toText(r)}"`);
});

await test("master → slave：主动发送", async () => {
  const r = await master.ROUTER("test-slave", "ping", { timeoutMs: 3000 });
  assert(toText(r) === "S:ping", `响应内容匹配 → "${toText(r)}"`);
});

await test("Buffer payload", async () => {
  const r = await slave.DEALER(Buffer.from("bin-data"), { timeoutMs: 3000 });
  assert(toText(r) === "M:bin-data", `Buffer payload 正常 → "${toText(r)}"`);
});

await test("并发 100 条请求（全部内容一致性校验）", async () => {
  // 并发量大时静默单条 REQ/RES 日志，改为只显示汇总行
  logSilent = true;
  log("    [并发] 正在发送 100 条请求...");

  const tasks = Array.from({ length: 100 }, (_, i) =>
    slave.DEALER(`item-${i}`, { timeoutMs: 5000 }),
  );
  const results = await Promise.all(tasks);

  logSilent = false;
  log(`    [并发] 全部完成：发出 100 条 / 收到 ${results.length} 条`);

  const allOk = results.every((r, i) => toText(r) === `M:item-${i}`);
  assert(allOk, "100 条并发响应内容全部匹配，无乱序");
});

section("载荷与 API 边界");

await test("Uint8Array payload", async () => {
  const r = await slave.DEALER(new Uint8Array([65, 66, 67]), {
    timeoutMs: 3000,
  });
  assert(toText(r) === "M:ABC", `Uint8Array 正常 → "${toText(r)}"`);
});

await test("多帧 payload 保持顺序与内容", async () => {
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

  assert(Array.isArray(rep), "多帧响应类型为数组");
  const texts = rep.map(toText);
  assert(texts.join("|") === "a|b|c", `多帧内容匹配 → "${texts.join("|")}"`);

  await sP.stop();
  await mP.stop();
});

await test("非法 payload 类型应抛错", async () => {
  let threw = false;
  try {
    await slave.DEALER({ bad: true }, { timeoutMs: 1000 });
  } catch (e) {
    threw = true;
    assert(
      String(e?.message ?? e).includes("payload"),
      `错误信息包含 payload → "${e?.message ?? e}"`,
    );
  }
  if (!threw) assert(false, "未抛错（非法 payload）");
});

await test("start()/stop() 可重复调用且无异常", async () => {
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

  assert(true, "start/stop 重复调用正常");
});

await test("未 start 时调用 DEALER/ROUTER 应抛错", async () => {
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

  assert(
    String(dealerErr?.message ?? dealerErr).includes("socket"),
    `DEALER 未 start 抛错 → "${dealerErr?.message ?? dealerErr}"`,
  );
  assert(
    String(routerErr?.message ?? routerErr).includes("socket"),
    `ROUTER 未 start 抛错 → "${routerErr?.message ?? routerErr}"`,
  );
});

await test("maxPending 达到上限时拒绝新请求", async () => {
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

  assert(
    String(err?.message ?? err).includes("并发请求数已达上限"),
    `maxPending 拒绝新请求 → "${err?.message ?? err}"`,
  );

  await p1;
  await sMp.stop();
  await mMp.stop();
});

// ══════════════════════════════════════════════════════════
//  测试组 2：认证失败
// ══════════════════════════════════════════════════════════

section("认证失败检测");

await test("错误 authKey（encrypted=true）→ master 丢弃请求并触发 auth_failed 事件", async () => {
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
    authKey: "wrong-key", // 故意填错，触发认证失败
    encrypted: true,
  });

  let authFailedFired = false;

  // 认证失败时手动打印详情（request 事件不会触发，因为在认证前已丢弃）
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
    // master 会丢弃请求，badSlave 永远等不到回复，最终超时
    await badSlave.DEALER("forbidden", { timeoutMs: 800 });
    assert(false, "不应收到响应");
  } catch (e) {
    assert(e.message.includes("请求超时"), `请求正确超时 → "${e.message}"`);
    assert(authFailedFired, "auth_failed 事件已触发");
  } finally {
    await badSlave.stop();
    await mAuth.stop();
  }
});

await test("错误 master key（encrypted=true）→ slave 触发 auth_failed", async () => {
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
    assert(false, "错误 master key 不应收到响应");
  } catch (e) {
    assert(e.message.includes("请求超时"), `请求正确超时 → "${e.message}"`);
    assert(slaveAuthFailed, "slave 侧 auth_failed 事件已触发");
  } finally {
    await sRight.stop();
    await mWrong.stop();
  }
});

// ══════════════════════════════════════════════════════════
//  测试组 3：超时控制
// ══════════════════════════════════════════════════════════

section("超时控制");

await test("master 无处理器 → slave 在指定时间内正确超时", async () => {
  const EP2 = "tcp://127.0.0.1:16004";
  // 这个 master 故意不注册 ROUTER 处理器，收到请求后不回复
  const m2 = new ZNL({
    role: "master",
    id: "m2",
    endpoints: { router: EP2 },
  });
  const s2 = new ZNL({
    role: "slave",
    id: "s2",
    endpoints: { router: EP2 },
  });

  // m2 日志可见「收到请求但没有回复」的过程，s2 无响应所以不会打印 RES
  attachLogger(m2, "M2    ");
  attachLogger(s2, "S2    ");

  await m2.start();
  await s2.start();
  await delay(100);

  const t0 = Date.now();
  try {
    await s2.DEALER("no-reply", { timeoutMs: 400 });
    assert(false, "不应收到响应");
  } catch (e) {
    const elapsed = Date.now() - t0;
    assert(e.message.includes("请求超时"), `正确超时 → "${e.message}"`);
    assert(elapsed >= 380 && elapsed < 1500, `超时时机合理 → ${elapsed}ms`);
  } finally {
    await s2.stop();
    await m2.stop();
  }
});

// ══════════════════════════════════════════════════════════
//  测试组 4：stop() 取消所有 pending
// ══════════════════════════════════════════════════════════

section("stop() 取消 pending");

await test("stop() 期间所有 in-flight 请求立即 reject", async () => {
  const EP3 = "tcp://127.0.0.1:16005";
  const m3 = new ZNL({
    role: "master",
    id: "m3",
    endpoints: { router: EP3 },
  });
  const s3 = new ZNL({
    role: "slave",
    id: "s3",
    endpoints: { router: EP3 },
  });

  // m3 日志可见「收到请求、处理中」；s3 在 stop 前不会收到 RES，所以只有 REQ 行
  attachLogger(m3, "M3    ");
  attachLogger(s3, "S3    ");

  // master 处理器有 3 秒延迟，保证在 stop 之前不会回复
  m3.ROUTER(async () => {
    await delay(3000);
    return "late";
  });

  await m3.start();
  await s3.start();
  await delay(100);

  // 发出一个长时间请求（10 秒超时），让它挂在 pending 中
  const reqPromise = s3.DEALER("long-req", { timeoutMs: 10000 });

  await delay(150); // 确保请求已成功发出并登记到 pending
  await s3.stop(); // 主动停止 → 立即 reject 所有 pending

  try {
    await reqPromise;
    assert(false, "stop 后不应收到响应");
  } catch (e) {
    assert(
      e.message.includes("已停止") || e.message.includes("cancelled"),
      `stop 后正确 reject → "${e.message}"`,
    );
  } finally {
    await m3.stop();
  }
});

// ══════════════════════════════════════════════════════════
//  测试组 5：PUB/SUB 广播
// ══════════════════════════════════════════════════════════

section("PUB/SUB 广播");

await test("slave 只收到已订阅的 topic，未订阅的 topic 静默丢弃", async () => {
  const EP4 = "tcp://127.0.0.1:16006";
  const m4 = new ZNL({ role: "master", id: "m4", endpoints: { router: EP4 } });
  const s4 = new ZNL({ role: "slave", id: "s4", endpoints: { router: EP4 } });

  const received = [];

  // 只订阅 "news"，不订阅 "weather"
  s4.subscribe("news", ({ topic, payload }) => {
    received.push({ topic, text: toText(payload) });
  });

  await m4.start();
  await s4.start();
  await delay(200); // 等待注册帧到达 master

  assert(m4.slaves.includes("s4"), `master.slaves 包含 s4 → ${m4.slaves}`);

  m4.publish("news", "breaking news!");
  m4.publish("weather", "sunny day"); // s4 未订阅，应静默丢弃
  await delay(100);

  assert(
    received.length === 1,
    `只收到 1 条（news）→ 实际 ${received.length} 条`,
  );
  assert(
    received[0]?.text === "breaking news!",
    `内容匹配 → "${received[0]?.text}"`,
  );
  assert(received[0]?.topic === "news", `topic 匹配 → "${received[0]?.topic}"`);

  await s4.stop();
  await m4.stop();
});

await test("多 slave 广播：每个 slave 都能收到，slave.on('publish') 兜底监听", async () => {
  const EP5 = "tcp://127.0.0.1:16007";
  const m5 = new ZNL({ role: "master", id: "m5", endpoints: { router: EP5 } });
  const s5a = new ZNL({ role: "slave", id: "s5a", endpoints: { router: EP5 } });
  const s5b = new ZNL({ role: "slave", id: "s5b", endpoints: { router: EP5 } });

  const s5aLog = [];
  const s5bLog = [];

  // s5a 用精确订阅
  s5a.subscribe("chat", ({ payload }) => s5aLog.push(toText(payload)));

  // s5b 用兜底监听（捕获所有 topic）
  s5b.on("publish", ({ topic, payload }) =>
    s5bLog.push(`${topic}:${toText(payload)}`),
  );

  await m5.start();
  await s5a.start();
  await s5b.start();
  await delay(200);

  assert(m5.slaves.length === 2, `2 个 slave 已注册 → ${m5.slaves}`);

  m5.publish("chat", "hello everyone");
  m5.publish("system", "server ok");
  await delay(100);

  // s5a 只订阅了 chat
  assert(s5aLog.length === 1, `s5a 收到 1 条 → 实际 ${s5aLog.length}`);
  assert(s5aLog[0] === "hello everyone", `s5a 内容匹配 → "${s5aLog[0]}"`);

  // s5b 兜底监听收到全部 2 条
  assert(s5bLog.length === 2, `s5b 收到 2 条 → 实际 ${s5bLog.length}`);
  assert(s5bLog.includes("chat:hello everyone"), `s5b 包含 chat 消息`);
  assert(s5bLog.includes("system:server ok"), `s5b 包含 system 消息`);

  await s5a.stop();
  await s5b.stop();
  await m5.stop();
});

await test("slave_connected / slave_disconnected 事件在 start/stop 时正确触发", async () => {
  const EP6 = "tcp://127.0.0.1:16008";
  const m6 = new ZNL({ role: "master", id: "m6", endpoints: { router: EP6 } });
  const s6 = new ZNL({ role: "slave", id: "s6", endpoints: { router: EP6 } });

  const connected = [];
  const disconnected = [];
  m6.on("slave_connected", (id) => connected.push(id));
  m6.on("slave_disconnected", (id) => disconnected.push(id));

  await m6.start();
  await s6.start();
  await delay(200);

  assert(connected.includes("s6"), `slave_connected 事件触发 → ${connected}`);
  assert(m6.slaves.includes("s6"), `master.slaves 包含 s6`);
  assert(disconnected.length === 0, `尚未触发 slave_disconnected`);

  await s6.stop();
  await delay(100);

  assert(
    disconnected.includes("s6"),
    `slave_disconnected 事件触发 → ${disconnected}`,
  );
  assert(!m6.slaves.includes("s6"), `master.slaves 已移除 s6 → ${m6.slaves}`);

  await m6.stop();
});

await test("unsubscribe() 后不再收到该 topic 的消息", async () => {
  const EP7 = "tcp://127.0.0.1:16009";
  const m7 = new ZNL({ role: "master", id: "m7", endpoints: { router: EP7 } });
  const s7 = new ZNL({ role: "slave", id: "s7", endpoints: { router: EP7 } });

  const log = [];
  s7.subscribe("ping", ({ payload }) => log.push(toText(payload)));

  await m7.start();
  await s7.start();
  await delay(200);

  m7.publish("ping", "first");
  await delay(100);
  assert(log.length === 1, `订阅期间收到第 1 条 → ${log.length} 条`);

  // 取消订阅后再发
  s7.unsubscribe("ping");
  m7.publish("ping", "second");
  await delay(100);
  assert(log.length === 1, `取消订阅后不再收到消息 → 仍是 ${log.length} 条`);

  await s7.stop();
  await m7.stop();
});

await test("slave 崩溃后（未发注销帧）master 在心跳超时内自动检测并移除", async () => {
  const EP8 = "tcp://127.0.0.1:16010";

  // heartbeatInterval = 300ms → 超时阈值 = 900ms
  const m8 = new ZNL({
    role: "master",
    id: "m8",
    endpoints: { router: EP8 },
    heartbeatInterval: 300,
  });

  await m8.start();

  // 用裸 ZMQ DEALER 模拟"只发注册、不发心跳"的崩溃节点
  // 真实崩溃场景中，进程直接退出，unregister 帧永远不会发送
  const crashDealer = new zmq.Dealer({ routingId: "crash-slave" });
  crashDealer.connect(EP8);
  await crashDealer.send([CONTROL_PREFIX, CONTROL_REGISTER]);

  await delay(200); // 等待注册帧到达 master

  assert(
    m8.slaves.includes("crash-slave"),
    `crash-slave 已注册 → ${m8.slaves}`,
  );

  const disconnectedIds = [];
  m8.on("slave_disconnected", (id) => disconnectedIds.push(id));

  // 等待超过 3 个心跳周期（300ms × 3 = 900ms），再加扫描间隔缓冲
  await delay(1400);

  assert(
    disconnectedIds.includes("crash-slave"),
    `超时后 slave_disconnected 已触发 → ${disconnectedIds}`,
  );
  assert(
    !m8.slaves.includes("crash-slave"),
    `master.slaves 已移除 crash-slave → [${m8.slaves}]`,
  );

  crashDealer.close();
  await m8.stop();
});

// ══════════════════════════════════════════════════════════
//  测试组 6：auth / encrypted 安全集成
// ══════════════════════════════════════════════════════════

section("encrypted 安全集成");

await test("encrypted 模式：RPC + PUB/SUB 正常（透明加解密）", async () => {
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
  s10.subscribe("news", ({ payload }) => pubLog.push(toText(payload)));

  m10.ROUTER(async ({ payload }) => `ENC-M:${toText(payload)}`);
  s10.DEALER(async ({ payload }) => `ENC-S:${toText(payload)}`);

  await m10.start();
  await s10.start();
  await delay(250);

  const r1 = await s10.DEALER("hello-encrypted", { timeoutMs: 3000 });
  assert(
    toText(r1) === "ENC-M:hello-encrypted",
    `encrypted slave→master 正常 → "${toText(r1)}"`,
  );

  const r2 = await m10.ROUTER("s10", "ping-encrypted", { timeoutMs: 3000 });
  assert(
    toText(r2) === "ENC-S:ping-encrypted",
    `encrypted master→slave 正常 → "${toText(r2)}"`,
  );

  m10.publish("news", "encrypted-news-1");
  await delay(120);
  assert(pubLog.length === 1, `encrypted 广播收到 1 条 → ${pubLog.length}`);
  assert(
    pubLog[0] === "encrypted-news-1",
    `encrypted 广播内容匹配 → "${pubLog[0]}"`,
  );

  await s10.stop();
  await m10.stop();
});

await test("encrypted 模式：错误 authKey 无法通信，并触发 auth_failed", async () => {
  const EP11 = "tcp://127.0.0.1:16013";

  const m11 = new ZNL({
    role: "master",
    id: "m11",
    endpoints: { router: EP11 },
    authKey: "right-key-11",
    encrypted: true,
  });
  const s11 = new ZNL({
    role: "slave",
    id: "s11",
    endpoints: { router: EP11 },
    authKey: "wrong-key-11",
    encrypted: true,
  });

  m11.ROUTER(async ({ payload }) => `M11:${toText(payload)}`);

  let authFailedFired = false;
  m11.on("auth_failed", () => {
    authFailedFired = true;
  });

  await m11.start();
  await s11.start();
  await delay(150);

  try {
    await s11.DEALER("forbidden-encrypted", { timeoutMs: 800 });
    assert(false, "错误 authKey 不应收到响应");
  } catch (e) {
    assert(e.message.includes("请求超时"), `请求正确超时 → "${e.message}"`);
    assert(authFailedFired, "master 侧 auth_failed 事件已触发");
  } finally {
    await s11.stop();
    await m11.stop();
  }
});

// ─── 清理主测试节点 ───────────────────────────────────────────────────────────

await slave.stop();
await master.stop();

// ─── 汇总输出 ─────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(56));
console.log(`  通过: ${passed}   失败: ${failed}`);
console.log("=".repeat(56));

if (failed > 0) {
  process.exit(1);
} else {
  console.log("\n  ✓ 全部测试通过\n");
  process.exit(0);
}
