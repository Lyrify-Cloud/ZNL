/**
 * Master 侧 authKeyMap 集成测试（可直接 node 执行）
 *
 * 目标：
 *  1) 多个 slave 各自 key 正常通信
 *  2) 未配置 key 的 slave 被拒绝
 *  3) 动态 add/remove 立即生效
 *
 * 运行：
 *   node test/master/test-authkeymap.js
 */

import { ZNL } from "../../index.js";

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const toText = (p) => (Buffer.isBuffer(p) ? p.toString() : String(p));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function test(label, fn) {
  console.log(`\n▶ ${label}`);
  try {
    await fn();
  } catch (e) {
    console.error(`  ✗ 未预期异常：${e?.message ?? e}`);
    failed++;
  }
}

// ─── 测试入口 ────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("  ZNL Master authKeyMap 测试");
console.log("=".repeat(60));

await test("多 key + 动态 add/remove", async () => {
  const EP = "tcp://127.0.0.1:16031";

  const master = new ZNL({
    role: "master",
    id: "m-authmap",
    endpoints: { router: EP },
    authKeyMap: {
      sA: "key-a",
      sB: "key-b",
    },
    encrypted: true,
  });

  const sA = new ZNL({
    role: "slave",
    id: "sA",
    endpoints: { router: EP },
    authKey: "key-a",
    encrypted: true,
  });

  const sB = new ZNL({
    role: "slave",
    id: "sB",
    endpoints: { router: EP },
    authKey: "key-b",
    encrypted: true,
  });

  const sX = new ZNL({
    role: "slave",
    id: "sX",
    endpoints: { router: EP },
    authKey: "key-x",
    encrypted: true,
  });

  master.ROUTER(async ({ payload }) => `M:${toText(payload)}`);
  sA.DEALER(async ({ payload }) => `A:${toText(payload)}`);
  sB.DEALER(async ({ payload }) => `B:${toText(payload)}`);

  let authFailed = false;
  master.on("auth_failed", () => {
    authFailed = true;
  });

  await master.start();
  await sA.start();
  await sB.start();
  await sX.start();
  await delay(250);

  const r1 = await sA.DEALER("hi-a", { timeoutMs: 2000 });
  const r2 = await sB.DEALER("hi-b", { timeoutMs: 2000 });
  assert(toText(r1) === "M:hi-a", `sA 正常通信 → "${toText(r1)}"`);
  assert(toText(r2) === "M:hi-b", `sB 正常通信 → "${toText(r2)}"`);

  const r3 = await master.ROUTER("sA", "ping-a", { timeoutMs: 2000 });
  const r4 = await master.ROUTER("sB", "ping-b", { timeoutMs: 2000 });
  assert(toText(r3) === "A:ping-a", `master→sA 正常 → "${toText(r3)}"`);
  assert(toText(r4) === "B:ping-b", `master→sB 正常 → "${toText(r4)}"`);

  // sX 未配置 key，尝试通信应超时并触发 auth_failed
  let sXFailed = false;
  try {
    await sX.DEALER("forbidden", { timeoutMs: 800 });
  } catch (e) {
    sXFailed = String(e?.message ?? e).includes("请求超时");
  }
  assert(sXFailed, "未配置 key 的 slave 请求超时");
  assert(authFailed, "master 触发 auth_failed");

  // 动态 add：允许 sX
  master.addAuthKey("sX", "key-x");
  await delay(100);
  const r5 = await sX.DEALER("after-add", { timeoutMs: 2000 });
  assert(toText(r5) === "M:after-add", `addAuthKey 生效 → "${toText(r5)}"`);

  // 动态 remove：踢下线
  master.removeAuthKey("sB");
  await delay(100);
  let removeFailed = false;
  try {
    await sB.DEALER("after-remove", { timeoutMs: 800 });
  } catch (e) {
    removeFailed = String(e?.message ?? e).includes("请求超时");
  }
  assert(removeFailed, "removeAuthKey 后 sB 请求超时");

  await sA.stop();
  await sB.stop();
  await sX.stop();
  await master.stop();
});

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log(`  通过: ${passed}   失败: ${failed}`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
} else {
  console.log("\n  ✓ 测试通过\n");
  process.exit(0);
}
