/**
 * Slave 示例节点
 *
 * 演示：
 *  1. 注册 dealer 自动回复处理器（响应 Master 主动发来的请求）
 *  2. 订阅 "news" 和 "system" 两个 topic（PUB/SUB）
 *  3. 启动后向 Master 发送一条问候消息
 *  4. 每隔 9 秒向 Master 发送一次心跳 ping
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

// ─── 订阅 PUB/SUB topic（start 前注册，连接后自动生效）─────────────────────────

slave
  .subscribe("news", ({ payload }) => {
    console.log(`[${id}][NEWS] ${toText(payload)}`);
  })
  .subscribe("system", ({ payload }) => {
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

// ─── 启动问候：向 Master 发送第一条 RPC 消息 ─────────────────────────────────
try {
  const bootReply = await slave.DEALER(`你好，我是 ${id}`, { timeoutMs: 4000 });
  console.log(`[${id}][启动问候回复] ${toText(bootReply)}`);
} catch (error) {
  console.error(`[${id}][启动问候失败]`, error?.message ?? error);
}

// ─── 定时心跳：每 9 秒向 Master 发送一次 RPC ping ───────────────────────────
const requestTimer = setInterval(async () => {
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
