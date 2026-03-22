import { ZmqClusterNode } from "./lib/ZmqClusterNode.js";

const id = process.argv[2] ?? "slave-001";
const AUTH_KEY = "lmm-demo-fixed-key-";

const slave = new ZmqClusterNode({
  role: "slave",
  id,
  endpoints: {
    pub: "tcp://127.0.0.1:6002",
    router: "tcp://127.0.0.1:6003",
  },
  subscribeTopics: ["hello"],
  maxPending: 2000,
  authKey: AUTH_KEY,
});

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

// DEALER(handler)：处理 master -> slave 请求
await slave.DEALER(async ({ payload }) => {
  const text = toText(payload);
  console.log(`[${id}][DEALER REQ]`, text);
  return `reply from ${id}: ${text}`;
});

// SUB 事件：接收 master 的 PUB 广播
slave.on("sub", ({ topic, payload }) => {
  console.log(`[${id}][SUB:${topic}]`, toText(payload));
});

slave.on("error", (error) => {
  console.error(`[${id}][ERROR]`, error?.message ?? error);
});

await slave.start();
console.log(`[${id}] started`);

// SUB(topic)：运行时新增一个订阅主题
slave.SUB("system");
console.log(`[${id}] subscribed extra topic: system`);

// DEALER(payload, options)：主动向 master 发起请求
const bootReply = await slave.DEALER(`hello from ${id}`, { timeoutMs: 4000 });
console.log(`[${id}][DEALER RESULT]`, toText(bootReply));

const requestTimer = setInterval(async () => {
  try {
    const reply = await slave.DEALER(`periodic ping from ${id}`, {
      timeoutMs: 4000,
    });
    console.log(`[${id}][DEALER LOOP RESULT]`, toText(reply));
  } catch (error) {
    console.error(`[${id}][DEALER LOOP ERROR]`, error?.message ?? error);
  }
}, 9000);

const shutdown = async () => {
  clearInterval(requestTimer);
  await slave.stop();
  console.log(`[${id}] stopped`);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
