/**
 * Master 节点示例
 *
 * 功能演示：
 *  1. 注册自动回复处理器（slave 发来 RPC 请求时自动回复）
 *  2. 感知 slave 上下线（slave_connected / slave_disconnected 事件）
 *  3. 每 5  秒广播 "news"   topic（模拟新闻推送）
 *  4. 每 15 秒广播 "system" topic（模拟系统通知）
 *  5. 每 7  秒主动向 slave-001 发送 RPC ping
 *  6. 示例日志说明：slave 侧现通过 heartbeat_ack 确认 master 在线
 */

import { ZNL } from "../../index.js";

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const AUTH_KEY = "znl-demo-fixed-key";

// ─── 节点初始化 ───────────────────────────────────────────────────────────────

const master = new ZNL({
  role: "master",
  id: "master-demo",
  endpoints: { router: "tcp://127.0.0.1:6003" },
  maxPending: 5000,
  authKey: AUTH_KEY,
  // 启用加密安全模式：自动对 payload 做签名、防重放与透明加密
  encrypted: true,
});

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

// ─── RPC 处理器 ───────────────────────────────────────────────────────────────

/**
 * 注册 master 侧 RPC 自动回复处理器
 * 每当 slave 发来请求时自动调用，返回值作为响应发回
 */
master.ROUTER(async ({ identityText, payload }) => {
  const text = toText(payload);
  console.log(`[MASTER][RPC ←] from=${identityText}  msg="${text}"`);
  return `master reply: ${text}`;
});

// ─── PUB/SUB 事件 ─────────────────────────────────────────────────────────────

/** slave 上线时打印当前在线列表 */
master.on("slave_connected", (id) => {
  console.log(
    `[MASTER][↑ 上线] ${id}  在线列表: [${master.slaves.join(", ")}]`,
  );
});

/** slave 下线时打印剩余在线列表 */
master.on("slave_disconnected", (id) => {
  console.log(
    `[MASTER][↓ 下线] ${id}  在线列表: [${master.slaves.join(", ")}]`,
  );
});

// ─── 其他事件 ─────────────────────────────────────────────────────────────────

master.on("error", (error) => {
  console.error("[MASTER][ERROR]", error?.message ?? error);
});

master.on("auth_failed", ({ identityText, reason }) => {
  console.error(
    `[MASTER][AUTH FAILED] from=${identityText}  reason=${reason ?? "<unknown>"}`,
  );
});

// ─── 启动 ─────────────────────────────────────────────────────────────────────

await master.start();
console.log("[MASTER] 已启动，监听 tcp://127.0.0.1:6003");
console.log("[MASTER] 等待 slave 连接...");
console.log(
  "[MASTER] 提示：slave 侧会先等待 heartbeat_ack 确认主节点在线，再发送启动问候与后续业务请求\n",
);

// ─── 定时广播：news topic（每 5 秒）──────────────────────────────────────────

const newsTimer = setInterval(() => {
  if (master.slaves.length === 0) return;

  const payload = JSON.stringify({
    title: "ZNL 每日简报",
    time: now(),
    content: `当前在线节点 ${master.slaves.length} 个`,
  });

  console.log(`[MASTER][PUB → news] ${payload}`);
  master.publish("news", payload);
}, 5000);

// ─── 定时广播：system topic（每 15 秒）───────────────────────────────────────

const systemTimer = setInterval(() => {
  if (master.slaves.length === 0) return;

  const payload = `系统运行正常 | 时间: ${now()} | 在线: ${master.slaves.length} 个节点`;
  console.log(`[MASTER][PUB → system] ${payload}`);
  master.publish("system", payload);
}, 15000);

// ─── 定时 RPC：每 7 秒主动向 slave-001 发 ping ────────────────────────────────

const pingTimer = setInterval(async () => {
  if (!master.slaves.includes("slave-001")) return;

  try {
    const reply = await master.ROUTER("slave-001", `ping @ ${now()}`, {
      timeoutMs: 4000,
    });
    console.log(`[MASTER][RPC →] slave-001 回复: "${toText(reply)}"`);
  } catch (error) {
    console.error(
      "[MASTER][RPC → 失败] 可能原因：slave 尚未确认主节点在线、正在重连，或当前请求超时",
      error?.message ?? error,
    );
  }
}, 7000);

// ─── 优雅关闭 ─────────────────────────────────────────────────────────────────

const shutdown = async () => {
  console.log("\n[MASTER] 正在关闭...");
  clearInterval(newsTimer);
  clearInterval(systemTimer);
  clearInterval(pingTimer);
  await master.stop();
  console.log("[MASTER] 已停止");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
