import { ZmqClusterNode } from "./lib/ZmqClusterNode.js";

const master = new ZmqClusterNode({
  role: "master",
  id: "master-test",
  endpoints: {
    pub: "tcp://127.0.0.1:6002",
    router: "tcp://127.0.0.1:6003",
  },
});

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

// 测试专用：收到什么就回什么，方便客户端校验是否串消息
master.ROUTER(async ({ identityText, payload }) => {
  const text = toText(payload);
  console.log(`[ECHO:${identityText}] ${text}`);
  return text;
});

master.on("error", (error) => {
  console.error("[MASTER TEST ERROR]", error);
});

await master.start();
console.log("[MASTER TEST] echo server started on tcp://127.0.0.1:6003");

const shutdown = async () => {
  await master.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
