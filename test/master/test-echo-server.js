/**
 * Echo 测试服务端（Master 节点）
 *
 * 用途：配合 slave/test-100-concurrent.js 做并发压测。
 * 逻辑极简：收到任何请求，原样回传 payload（echo）。
 *
 * 启动方式：
 *   npm run test:echo
 *
 * 可选环境变量：
 *   ZNL_AUTH_KEY   共享密钥（encrypted=true 时必填）
 *   ZNL_ENCRYPTED  是否启用加密（true/false）
 */

import { ZNL } from "../../index.js";

// 可选安全配置：通过环境变量控制，默认保持“开箱即用”
const AUTH_KEY = process.env.ZNL_AUTH_KEY ?? "";
const ENCRYPTED = /^(true|1|yes)$/i.test(process.env.ZNL_ENCRYPTED ?? "");

const master = new ZNL({
  role: "master",
  id: "master-test",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: AUTH_KEY,
  encrypted: ENCRYPTED,
});

/** 将 Buffer 或任意值转为可读字符串（仅用于日志） */
const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

// 注册自动回复处理器：原样返回收到的 payload（echo 模式）
master.ROUTER(async ({ identityText, payload }) => {
  const text = toText(payload);
  console.log(`[ECHO:${identityText}] ${text}`);
  // 直接返回原始 payload，slave 侧收到后进行一致性校验
  return payload;
});

master.on("error", (error) => {
  console.error("[MASTER TEST ERROR]", error);
});

await master.start();
console.log("[MASTER TEST] echo 服务端已启动，监听 tcp://127.0.0.1:6003");
console.log(
  `[MASTER TEST] encrypted=${ENCRYPTED} authKey=${AUTH_KEY ? "<set>" : "<empty>"}`,
);
console.log("[MASTER TEST] 等待并发测试客户端连接...");

// 优雅退出：收到信号时关闭节点
const shutdown = async () => {
  console.log("[MASTER TEST] 正在停止...");
  await master.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
