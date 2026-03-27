/**
 * 并发压测客户端
 *
 * 用法：
 *   node slave/test-100-concurrent.js [总请求数] [超时毫秒] [slave-id] [authKey] [encrypted]
 *
 * 示例：
 *   node slave/test-100-concurrent.js 100 10000 slave-001
 *   node slave/test-100-concurrent.js 100 10000 slave-001 my-secret-key true
 *   node slave/test-100-concurrent.js 100 10000 slave-001 "" false
 *
 * 测试逻辑：
 *   1. 启动一个 Slave 节点并连接到 Master（需先运行 test-echo-server）
 *   2. 一次性并发发出 N 条请求，每条携带唯一 id 和随机文本
 *   3. 收到所有响应后，逐一校验 id 和 text 是否与发送时一致
 *   4. 全部匹配则 exit(0)，否则打印不匹配详情并 exit(1)
 */

import { randomUUID } from "node:crypto";
import { ZNL } from "../../index.js";

// ─── 命令行参数 ───────────────────────────────────────────────────────────────

/** 总并发请求数，默认 100000 */
const total = Number(process.argv[2] ?? 100000);

/** 单次请求超时时间（毫秒），默认 10000 */
const timeoutMs = Number(process.argv[3] ?? 10000);

/** Slave 节点 ID，默认使用时间戳防止与其他实例冲突 */
const id = process.argv[4] ?? `slave-test-${Math.floor(Date.now() / 1000)}`;

/**
 * 可选共享认证 Key：
 * - encrypted=false 时可不传
 * - encrypted=true 时必须提供（用于签名与加密）
 */
const authKey = process.argv[5] ?? "";

/**
 * 是否启用加密：
 * - false : 明文模式（默认，不签名/不加密）
 * - true  : 签名 + 防重放 + payload 加密
 */
const encrypted = /^(true|1|yes)$/i.test(process.argv[6] ?? "");

// ─── 节点初始化 ───────────────────────────────────────────────────────────────

const slave = new ZNL({
  role: "slave",
  id,
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey,
  encrypted,
  maxPending: "0",
});

/** 将 Buffer 或任意值转为字符串 */
const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

/** 生成随机负载字符串（UUID + 随机后缀） */
const makeRandomString = () =>
  `${randomUUID()}-${Math.random().toString(36).slice(2, 10)}`;

slave.on("error", (error) => {
  console.error("[压测客户端][ERROR]", error);
});

// ─── 启动并等待连接就绪 ───────────────────────────────────────────────────────

await slave.start();
console.log(
  `[压测客户端] 已启动  total=${total}  timeoutMs=${timeoutMs}  id=${id}  encrypted=${encrypted}  authKey=${authKey ? "<provided>" : "<empty>"}`,
);

// 等待 DEALER 与 ROUTER 完成握手，避免前几条消息丢失
await new Promise((resolve) => setTimeout(resolve, 300));

// ─── 构造请求数据集 ───────────────────────────────────────────────────────────

/** 每条消息包含唯一 id（用于校验）和随机 text（用于内容校验） */
const messages = Array.from({ length: total }, () => ({
  id: randomUUID(),
  text: makeRandomString(),
}));

// ─── 并发发送所有请求 ─────────────────────────────────────────────────────────

const startedAt = Date.now();

const tasks = messages.map(async (msg, index) => {
  const payload = JSON.stringify(msg);
  const reply = await slave.DEALER(payload, { timeoutMs });
  const replyText = toText(reply);

  // 尝试解析响应 JSON
  let replyObj = null;
  try {
    replyObj = JSON.parse(replyText);
  } catch {}

  const sentId = msg.id;
  const backId = replyObj?.id ?? "<parse-failed>";
  console.log(
    `[TRACE ${index}] sentId=${sentId}  backId=${backId}  same=${sentId === backId}`,
  );

  return { request: msg, replyText, replyObj };
});

// 等待所有请求完成（无论成功或失败）
const settled = await Promise.allSettled(tasks);
const costMs = Date.now() - startedAt;

// ─── 结果校验 ─────────────────────────────────────────────────────────────────

const errors = [];

for (let i = 0; i < settled.length; i++) {
  const item = settled[i];

  // 请求本身 rejected（超时、网络错误等）
  if (item.status === "rejected") {
    errors.push(
      `index=${i} rejected: ${item.reason?.message ?? String(item.reason)}`,
    );
    continue;
  }

  const { request: req, replyText, replyObj: rep } = item.value;

  // 响应无法解析为 JSON
  if (!rep) {
    errors.push(`index=${i} parse-failed: reply=${replyText}`);
    continue;
  }

  // id 或 text 不匹配（说明响应与请求对不上，存在乱序或内容损坏）
  if (req.id !== rep.id || req.text !== rep.text) {
    errors.push(
      `index=${i} mismatch:` +
        ` sent.id=${req.id} back.id=${rep.id}` +
        ` sent.text=${req.text} back.text=${rep.text}`,
    );
  }
}

// ─── 输出汇总 ─────────────────────────────────────────────────────────────────

console.log(`[压测客户端] 完成，耗时 ${costMs}ms`);
console.log(
  `[压测客户端] total=${total}  ok=${total - errors.length}  fail=${errors.length}`,
);

if (errors.length > 0) {
  console.error("[压测客户端] 不匹配详情（最多显示 10 条）：");
  for (const line of errors.slice(0, 10)) {
    console.error(" ", line);
  }
  await slave.stop();
  process.exit(1);
}

console.log("[压测客户端] PASS：所有消息校验通过，无乱序或内容损坏");
await slave.stop();
process.exit(0);
