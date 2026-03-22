import { ZmqClusterNode } from "./lib/ZmqClusterNode.js";

const AUTH_KEY = "lmm-demo-fixed-key";

const master = new ZmqClusterNode({
  role: "master",
  id: "master-demo",
  endpoints: {
    pub: "tcp://127.0.0.1:6002",
    router: "tcp://127.0.0.1:6003",
  },
  maxPending: 5000,
  authKey: AUTH_KEY,
});

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

// ROUTER(handler)：处理 slave -> master 请求
master.ROUTER(async ({ identityText, payload }) => {
  const text = toText(payload);
  console.log(`[MASTER][ROUTER<-DEALER] from=${identityText} payload=${text}`);
  return `master reply: ${text}`;
});

master.on("error", (error) => {
  console.error("[MASTER ERROR]", error?.message ?? error);
});

master.on("auth_failed", ({ identityText, authKey }) => {
  console.error(
    `[MASTER][AUTH FAILED] from=${identityText} provided=${authKey ?? "<none>"}`
  );
});

await master.start();
console.log("[MASTER] started");

// PUB(topic, payload)：向所有 SUB 客户端广播消息
const pubTimer = setInterval(async () => {
  try {
    const msg = `hello from master @ ${new Date().toLocaleTimeString()}`;
    await master.PUB("hello", msg);
    console.log("[MASTER][PUB]", msg);
  } catch (error) {
    console.error("[MASTER][PUB ERROR]", error?.message ?? error);
  }
}, 3000);

// ROUTER(identity, payload, options)：master 主动请求指定 slave
const pingTimer = setInterval(async () => {
  try {
    const reply = await master.ROUTER("slave-001", "ping from master", {
      timeoutMs: 4000,
    });
    console.log("[MASTER][ROUTER RESULT]", toText(reply));
  } catch (error) {
    console.error("[MASTER][ROUTER ERROR]", error?.message ?? error);
  }
}, 7000);

const shutdown = async () => {
  clearInterval(pubTimer);
  clearInterval(pingTimer);
  await master.stop();
  console.log("[MASTER] stopped");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
