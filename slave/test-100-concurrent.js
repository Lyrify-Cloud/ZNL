import { randomUUID } from "node:crypto";
import { ZmqClusterNode } from "./lib/ZmqClusterNode.js";

const total = Number(process.argv[2] ?? 100000);
const timeoutMs = Number(process.argv[3] ?? 10000);
const id = process.argv[4] ?? `slave-test-${Math.floor(Date.now() / 1000)}`;

const slave = new ZmqClusterNode({
  role: "slave",
  id,
  endpoints: {
    pub: "tcp://127.0.0.1:6002",
    router: "tcp://127.0.0.1:6003",
  },
  subscribeTopics: ["hello"],
});

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

const makeRandomString = () =>
  `${randomUUID()}-${Math.random().toString(36).slice(2, 10)}`;

slave.on("error", (error) => {
  console.error("[SLAVE TEST ERROR]", error);
});

await slave.start();
console.log(`[SLAVE TEST] client started, total=${total}, timeoutMs=${timeoutMs}, id=${id}`);

// 给 socket 一点连接建立时间，避免刚启动就压测导致首包抖动
await new Promise((resolve) => setTimeout(resolve, 300));

const messages = Array.from({ length: total }, () => ({
  id: randomUUID(),
  text: makeRandomString(),
}));
const startedAt = Date.now();

const tasks = messages.map(async (msg, index) => {
  const payload = JSON.stringify(msg);
  const reply = await slave.DEALER(payload, { timeoutMs });
  const replyText = toText(reply);

  let replyObj = null;
  try {
    replyObj = JSON.parse(replyText);
  } catch {}

  const sentId = msg.id;
  const backId = replyObj?.id ?? "<parse-failed>";
  console.log(
    `[TRACE ${index}] sentId=${sentId} backId=${backId} same=${sentId === backId}`
  );

  return {
    request: msg,
    replyText,
    replyObj,
  };
});

const settled = await Promise.allSettled(tasks);
const costMs = Date.now() - startedAt;

const errors = [];
for (let i = 0; i < settled.length; i += 1) {
  const item = settled[i];
  if (item.status === "rejected") {
    errors.push(`index=${i} rejected: ${item.reason?.message ?? String(item.reason)}`);
    continue;
  }

  const req = item.value.request;
  const rep = item.value.replyObj;

  if (!rep) {
    errors.push(`index=${i} parse-failed: reply=${item.value.replyText}`);
    continue;
  }

  if (req.id !== rep.id || req.text !== rep.text) {
    errors.push(
      `index=${i} mismatch: sent.id=${req.id}, back.id=${rep.id}, sent.text=${req.text}, back.text=${rep.text}`
    );
  }
}

console.log(`[SLAVE TEST] finished in ${costMs}ms`);
console.log(`[SLAVE TEST] total=${total}, ok=${total - errors.length}, fail=${errors.length}`);

if (errors.length > 0) {
  console.error("[SLAVE TEST] mismatch details (up to 10):");
  for (const line of errors.slice(0, 10)) {
    console.error(line);
  }
  await slave.stop();
  process.exit(1);
}

console.log("[SLAVE TEST] PASS: no message mismatch");
await slave.stop();
process.exit(0);
