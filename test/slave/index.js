/**
 * Slave 示例节点
 *
 * 演示：
 *  1. 注册 dealer 自动回复处理器（响应 Master 主动发来的请求）
 *  2. 订阅 "news" 和 "system" 两个 topic（PUB/SUB）
 *  3. 启动后等待 Master 在线确认，再发送一条问候消息
 *  4. 每隔 9 秒在 Master 在线时发送一次 RPC ping
 *
 * 用法：
 *   node test/slave/index.js [slaveId]
 */

import { ZNL } from "../../index.js";

// 从命令行参数读取节点 ID，默认为 "slave-001"
const id = process.argv[2] ?? "slave-001";

// 与 Master 约定的共享认证 Key（两端必须一致）
const AUTH_KEY = "znl-demo-fixed-key";

// ─── 创建 Slave 节点 ──────────────────────────────────────────────────────────

const slave = new ZNL({
  role: "slave",
  id,
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  maxPending: 2000,
  authKey: AUTH_KEY,
  encrypted: true,
});

// 辅助函数：将 payload（Buffer 或其他）转为可读字符串
const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

// 等待主节点进入“已在线确认”状态。
// 说明：
// - 仅等待最近一次链路确认结果，不主动发起额外探测
// - 超时后返回 false，由调用方决定是否继续重试或跳过本次请求
const waitForMasterOnline = async (timeoutMs = 5000, intervalMs = 100) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (slave.isMasterOnline()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
};

// ─── 订阅 PUB/SUB topic（start 前注册，连接后自动生效）─────────────────────────

slave
  .SUBSCRIBE("news", ({ payload }) => {
    console.log(`[${id}][NEWS] ${toText(payload)}`);
  })
  .SUBSCRIBE("system", ({ payload }) => {
    console.log(`[${id}][SYSTEM] ${toText(payload)}`);
  });

// ─── 注册自动回复处理器 ───────────────────────────────────────────────────────
// 当 Master 主动向本节点发送 RPC 请求时触发（ROUTER → DEALER 方向）
// 处理器的返回值会自动作为响应发回 Master
await slave.DEALER(async ({ payload }) => {
  const text = toText(payload);
  console.log(`[${id}][收到 Master 请求] ${text}`);
  return `来自 ${id} 的回复：${text}`;
});

// ─── 错误监听 ─────────────────────────────────────────────────────────────────
slave.on("error", (error) => {
  console.error(`[${id}][ERROR]`, error?.message ?? error);
});

// ─── 启动节点 ─────────────────────────────────────────────────────────────────
await slave.start();
console.log(`[${id}] 已启动，连接到 ${slave.endpoints.router}`);
console.log(`[${id}] 正在等待 Master 在线确认...`);

// ─── 启动问候：等待 Master 在线后再发送第一条 RPC 消息 ───────────────────────
if (await waitForMasterOnline(5000)) {
  try {
    const bootReply = await slave.DEALER(`你好，我是 ${id}`, {
      timeoutMs: 4000,
    });
    console.log(`[${id}][启动问候回复] ${toText(bootReply)}`);
    slave.PUSH("system", `启动完成：${id}`);
  } catch (error) {
    console.error(`[${id}][启动问候失败]`, error?.message ?? error);
  }
} else {
  console.warn(`[${id}][启动问候跳过] 等待 Master 在线超时`);
}

// ─── 定时请求：每 9 秒在 Master 在线时发送一次 RPC ping ─────────────────────
const requestTimer = setInterval(async () => {
  if (!slave.isMasterOnline()) {
    console.warn(`[${id}][定时请求跳过] Master 当前离线，等待下一轮重试`);
    return;
  }

  try {
    const reply = await slave.DEALER(`来自 ${id} 的定时 ping`, {
      timeoutMs: 4000,
    });
    console.log(`[${id}][心跳回复] ${toText(reply)}`);
  } catch (error) {
    console.error(`[${id}][心跳失败]`, error?.message ?? error);
  }
}, 9000);

// ─── 优雅退出 ─────────────────────────────────────────────────────────────────
const shutdown = async () => {
  console.log(`[${id}] 正在停止...`);
  clearInterval(requestTimer);
  await slave.stop();
  console.log(`[${id}] 已停止`);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
