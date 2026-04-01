/**
 * 统一压测脚本：同一进程内自动执行
 *  1. 非加密模式
 *  2. 加密模式
 *
 * 用法：
 *   node test/load-report.js
 *   node test/load-report.js 10000 10000
 *   node test/load-report.js 100000 30000 my-secret-key
 *   node test/load-report.js 100000 30000 my-secret-key 6003 6004 500 --full
 *   node test/load-report.js 100000 30000 my-secret-key 6003 6004 500 --errors --events --json
 *
 * 参数：
 *   [0] total        总请求数，默认 10000
 *   [1] timeoutMs    单请求超时，默认 10000
 *   [2] authKey      加密模式密钥，默认 "my-secret-key"
 *   [3] plainPort    非加密端口，默认 6003
 *   [4] securePort   加密端口，默认 6004
 *   [5] warmupMs     启动后预热等待时间，默认 500
 *
 * 可选标志：
 * - --full    输出完整详细报告（等价于 --errors --events --json）
 * - --errors  输出错误分类与样本
 * - --events  输出 master/slave 事件样本
 * - --json    输出 JSON 摘要
 *
 * 说明：
 * - 为避免日志本身污染压测结果，此脚本默认不打印逐条请求/响应日志
 * - 压测风格延续旧脚本：一次性并发发出所有请求
 * - 默认输出“人类可读简报”；详细信息按命令行标志显示
 */

import { randomUUID } from "node:crypto";
import { ZNL } from "../index.js";

const args = process.argv.slice(2);
const total = toPositiveInt(args[0], 10000);
const timeoutMs = toPositiveInt(args[1], 10000);
const authKey = args[2] ?? "my-secret-key";
const plainPort = toPositiveInt(args[3], 6003);
const securePort = toPositiveInt(args[4], 6004);
const warmupMs = toPositiveInt(args[5], 500);

const FLAG_FULL = args.includes("--full");
const FLAG_ERRORS = FLAG_FULL || args.includes("--errors");
const FLAG_EVENTS = FLAG_FULL || args.includes("--events");
const FLAG_JSON = FLAG_FULL || args.includes("--json");
const FLAG_HELP = args.includes("--help") || args.includes("-h");

const MAX_ERROR_SAMPLES = 10;
const MAX_EVENT_SAMPLES = 20;

const results = [];
let shuttingDown = false;
let activeNodes = [];

main().catch((error) => {
  console.error("[LOAD-REPORT] 运行失败：", error);
  process.exitCode = 1;
});

async function main() {
  installSignalHandlers();

  if (FLAG_HELP) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  printIntro();

  const plainResult = await runScenario({
    name: "plain",
    encrypted: false,
    authKey: "",
    port: plainPort,
    total,
    timeoutMs,
    warmupMs,
  });
  results.push(plainResult);

  const encryptedResult = await runScenario({
    name: "encrypted",
    encrypted: true,
    authKey,
    port: securePort,
    total,
    timeoutMs,
    warmupMs,
  });
  results.push(encryptedResult);

  printFullReport(results);
  process.exitCode = results.every((item) => item.fail === 0) ? 0 : 1;
}

function installSignalHandlers() {
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[LOAD-REPORT] 收到 ${signal}，正在停止节点...`);
    await stopActiveNodes();
    process.exit(130);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function stopActiveNodes() {
  const nodes = activeNodes;
  activeNodes = [];
  await Promise.allSettled(
    nodes.map(async (node) => {
      try {
        await node.stop();
      } catch {}
    }),
  );
}

async function runScenario({
  name,
  encrypted,
  authKey,
  port,
  total,
  timeoutMs,
  warmupMs,
}) {
  const endpoint = `tcp://127.0.0.1:${port}`;
  const slaveId = `slave-${name}-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;

  const masterEvents = [];
  const slaveEvents = [];

  const master = new ZNL({
    role: "master",
    id: `master-${name}`,
    endpoints: { router: endpoint },
    authKey,
    encrypted,
    maxPending: 0,
  });

  const slave = new ZNL({
    role: "slave",
    id: slaveId,
    endpoints: { router: endpoint },
    authKey,
    encrypted,
    maxPending: 0,
  });

  activeNodes = [master, slave];

  master.on("error", (error) =>
    pushSample(masterEvents, formatError(error), MAX_EVENT_SAMPLES),
  );
  slave.on("error", (error) =>
    pushSample(slaveEvents, formatError(error), MAX_EVENT_SAMPLES),
  );

  master.ROUTER(async ({ payload }) => payload);

  const startedAt = Date.now();

  try {
    console.log(
      `[SCENARIO:${name}] starting endpoint=${endpoint} encrypted=${encrypted} total=${total} timeoutMs=${timeoutMs}`,
    );

    await master.start();
    await slave.start();

    await waitUntilReady(slave, warmupMs, timeoutMs);

    const requestStartedAt = Date.now();
    const messages = Array.from({ length: total }, () => ({
      id: randomUUID(),
      text: `${randomUUID()}-${Math.random().toString(36).slice(2, 10)}`,
    }));

    const latencies = [];
    const tasks = messages.map(async (msg, index) => {
      const singleStartedAt = Date.now();
      const reply = await slave.DEALER(JSON.stringify(msg), { timeoutMs });
      const replyText = toText(reply);

      let replyObj = null;
      try {
        replyObj = JSON.parse(replyText);
      } catch {}

      latencies.push(Date.now() - singleStartedAt);

      return {
        index,
        request: msg,
        replyText,
        replyObj,
      };
    });

    const settled = await Promise.allSettled(tasks);
    const requestCostMs = Date.now() - requestStartedAt;
    const totalCostMs = Date.now() - startedAt;

    const parsed = analyzeSettled({
      settled,
      requestTotal: total,
      requestCostMs,
      totalCostMs,
      latencies,
      masterEvents,
      slaveEvents,
      endpoint,
      encrypted,
      authKeyProvided: Boolean(authKey),
      timeoutMs,
      warmupMs,
      name,
      slaveId,
    });

    console.log(
      `[SCENARIO:${name}] done total=${parsed.total} ok=${parsed.ok} fail=${parsed.fail} requestCost=${parsed.requestCostMs}ms`,
    );

    return parsed;
  } finally {
    await Promise.allSettled([slave.stop(), master.stop()]);
    activeNodes = [];
    await sleep(200);
  }
}

async function waitUntilReady(slave, warmupMs, timeoutMs) {
  const startedAt = Date.now();

  if (typeof slave.isMasterOnline === "function") {
    while (!slave.isMasterOnline()) {
      if (Date.now() - startedAt > Math.max(timeoutMs, warmupMs + 1000)) break;
      await sleep(50);
    }
  }

  await sleep(warmupMs);
}

function analyzeSettled({
  settled,
  requestTotal,
  requestCostMs,
  totalCostMs,
  latencies,
  masterEvents,
  slaveEvents,
  endpoint,
  encrypted,
  authKeyProvided,
  timeoutMs,
  warmupMs,
  name,
  slaveId,
}) {
  const errors = [];
  const errorStats = new Map();
  let ok = 0;
  let parseFail = 0;
  let mismatch = 0;
  let rejected = 0;

  for (let i = 0; i < settled.length; i++) {
    const item = settled[i];

    if (item.status === "rejected") {
      rejected++;
      const msg = `index=${i} rejected: ${formatError(item.reason)}`;
      pushSample(errors, msg, MAX_ERROR_SAMPLES);
      countType(
        errorStats,
        classifyError(String(item.reason?.message ?? item.reason)),
      );
      continue;
    }

    const { request, replyText, replyObj } = item.value;

    if (!replyObj) {
      parseFail++;
      const msg = `index=${i} parse-failed: reply=${replyText}`;
      pushSample(errors, msg, MAX_ERROR_SAMPLES);
      countType(errorStats, "parse-failed");
      continue;
    }

    if (request.id !== replyObj.id || request.text !== replyObj.text) {
      mismatch++;
      const msg =
        `index=${i} mismatch:` +
        ` sent.id=${request.id} back.id=${replyObj.id}` +
        ` sent.text=${request.text} back.text=${replyObj.text}`;
      pushSample(errors, msg, MAX_ERROR_SAMPLES);
      countType(errorStats, "mismatch");
      continue;
    }

    ok++;
  }

  const fail = requestTotal - ok;
  const summary = Object.fromEntries(
    [...errorStats.entries()].sort((a, b) => b[1] - a[1]),
  );

  return {
    name,
    endpoint,
    encrypted,
    authKeyProvided,
    slaveId,
    total: requestTotal,
    ok,
    fail,
    parseFail,
    mismatch,
    rejected,
    timeoutMs,
    warmupMs,
    requestCostMs,
    totalCostMs,
    throughputPerSec: safeRate(ok, requestCostMs),
    settleThroughputPerSec: safeRate(requestTotal, requestCostMs),
    latency: summarizeLatencies(latencies),
    masterEvents,
    slaveEvents,
    errorSamples: errors,
    errorSummary: summary,
    passed: fail === 0,
    finishedAt: new Date().toISOString(),
  };
}

function summarizeLatencies(values) {
  if (!values.length) {
    return {
      count: 0,
      minMs: null,
      maxMs: null,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);

  return {
    count: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: round(sum / sorted.length, 2),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return sorted[idx];
}

function safeRate(count, ms) {
  if (!ms || ms <= 0) return 0;
  return round((count * 1000) / ms, 2);
}

function classifyError(message) {
  if (message.includes("请求超时")) return "timeout";
  if (message.includes("Operation was not possible or timed out"))
    return "zmq-send-failed";
  if (message.includes("auth")) return "auth";
  if (message.includes("解密")) return "decrypt";
  return "other";
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pushSample(list, value, limit) {
  if (list.length < limit) list.push(value);
}

function countType(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toText(payload) {
  return Buffer.isBuffer(payload) ? payload.toString() : String(payload);
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printIntro() {
  const detailFlags =
    [
      FLAG_FULL ? "--full" : null,
      FLAG_ERRORS && !FLAG_FULL ? "--errors" : null,
      FLAG_EVENTS && !FLAG_FULL ? "--events" : null,
      FLAG_JSON && !FLAG_FULL ? "--json" : null,
    ]
      .filter(Boolean)
      .join(" ") || "默认简报";

  console.log("");
  console.log(
    "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  );
  console.log(
    "┃                               ZNL 统一压测仪表盘                               ┃",
  );
  console.log(
    "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
  );
  console.log(`  总请求数        : ${total}`);
  console.log(`  单请求超时      : ${timeoutMs} ms`);
  console.log(`  加密密钥        : ${authKey ? "<provided>" : "<empty>"}`);
  console.log(`  非加密端口      : ${plainPort}`);
  console.log(`  加密端口        : ${securePort}`);
  console.log(`  预热等待        : ${warmupMs} ms`);
  console.log(`  输出模式        : ${detailFlags}`);
  console.log("  帮助命令        : node test/load-report.js --help");
  console.log("");
}

function printFullReport(items) {
  console.log("");
  console.log("=".repeat(88));
  console.log("[LOAD-REPORT] 压测简报");
  console.log("=".repeat(88));

  for (const item of items) {
    printCompactScenarioReport(item);
  }

  printComparison(items);
  // printDetailHint();

  if (FLAG_ERRORS || FLAG_EVENTS) {
    console.log("");
    console.log("=".repeat(88));
    console.log("[LOAD-REPORT] 详细信息");
    console.log("=".repeat(88));

    for (const item of items) {
      printScenarioDetails(item);
    }
  }

  if (FLAG_JSON) {
    console.log("");
    console.log("[LOAD-REPORT] JSON 摘要：");
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          total,
          timeoutMs,
          authKeyProvided: Boolean(authKey),
          scenarios: items,
        },
        null,
        2,
      ),
    );
  }
}

function printCompactScenarioReport(item) {
  const successRate =
    item.total > 0 ? round((item.ok / item.total) * 100, 2) : 0;
  const failRate =
    item.total > 0 ? round((item.fail / item.total) * 100, 2) : 0;
  const topError = Object.entries(item.errorSummary)[0];
  const title = item.name === "plain" ? "非加密模式" : "加密模式";
  const status = item.passed ? "PASS" : "FAIL";

  console.log("");
  console.log(
    "┌──────────────────────────────────────────────────────────────────────────────────────┐",
  );
  console.log(
    `│ 场景：${padRight(title, 12)} 状态：${padRight(status, 6)} 加密：${padRight(String(item.encrypted), 5)} 端口：${padRight(item.endpoint, 26)}│`,
  );
  console.log(
    "├──────────────────────────────────────────────────────────────────────────────────────┤",
  );
  console.log(
    `│ 成功率        ${padRight(`${successRate}%`, 12)} 失败率        ${padRight(`${failRate}%`, 12)} 总请求        ${padRight(String(item.total), 12)}│`,
  );
  console.log(
    `│ 成功数        ${padRight(String(item.ok), 12)} 失败数        ${padRight(String(item.fail), 12)} 拒绝数        ${padRight(String(item.rejected), 12)}│`,
  );
  console.log(
    `│ 请求耗时      ${padRight(`${item.requestCostMs} ms`, 12)} 吞吐(ok/s)   ${padRight(String(item.throughputPerSec), 12)} 全部结算/s    ${padRight(String(item.settleThroughputPerSec), 12)}│`,
  );
  console.log(
    `│ 延迟 avg      ${padRight(`${item.latency.avgMs} ms`, 12)} p50          ${padRight(`${item.latency.p50Ms} ms`, 12)} p95          ${padRight(`${item.latency.p95Ms} ms`, 12)}│`,
  );
  console.log(
    `│ 延迟 p99      ${padRight(`${item.latency.p99Ms} ms`, 12)} min          ${padRight(`${item.latency.minMs} ms`, 12)} max          ${padRight(`${item.latency.maxMs} ms`, 12)}│`,
  );

  if (!item.passed) {
    console.log(
      "├──────────────────────────────────────────────────────────────────────────────────────┤",
    );
    console.log(
      `│ 失败拆分      parseFail=${padRight(String(item.parseFail), 8)} mismatch=${padRight(String(item.mismatch), 8)} topError=${padRight(topError ? `${topError[0]}:${topError[1]}` : "<none>", 32)}│`,
    );
  }

  console.log(
    "└──────────────────────────────────────────────────────────────────────────────────────┘",
  );
}

function printScenarioDetails(item) {
  console.log("");
  console.log("-".repeat(88));
  console.log(`[DETAIL] ${item.name}`);
  console.log("-".repeat(88));
  console.log(`endpoint              : ${item.endpoint}`);
  console.log(`encrypted             : ${item.encrypted}`);
  console.log(`authKeyProvided       : ${item.authKeyProvided}`);
  console.log(`slaveId               : ${item.slaveId}`);
  console.log(`finishedAt            : ${item.finishedAt}`);
  console.log(`timeoutMs             : ${item.timeoutMs}`);
  console.log(`warmupMs              : ${item.warmupMs}`);
  console.log(`total                 : ${item.total}`);
  console.log(`ok                    : ${item.ok}`);
  console.log(`fail                  : ${item.fail}`);
  console.log(`rejected              : ${item.rejected}`);
  console.log(`parseFail             : ${item.parseFail}`);
  console.log(`mismatch              : ${item.mismatch}`);
  console.log(`requestCostMs         : ${item.requestCostMs}`);
  console.log(`totalCostMs           : ${item.totalCostMs}`);
  console.log(`okThroughput/s        : ${item.throughputPerSec}`);
  console.log(`settleThroughput/s    : ${item.settleThroughputPerSec}`);
  console.log(`latency.count         : ${item.latency.count}`);
  console.log(`latency.minMs         : ${item.latency.minMs}`);
  console.log(`latency.avgMs         : ${item.latency.avgMs}`);
  console.log(`latency.p50Ms         : ${item.latency.p50Ms}`);
  console.log(`latency.p95Ms         : ${item.latency.p95Ms}`);
  console.log(`latency.p99Ms         : ${item.latency.p99Ms}`);
  console.log(`latency.maxMs         : ${item.latency.maxMs}`);
  console.log(`passed                : ${item.passed}`);

  if (FLAG_ERRORS) {
    console.log("");
    console.log("errorSummary:");
    if (Object.keys(item.errorSummary).length === 0) {
      console.log("  <none>");
    } else {
      for (const [k, v] of Object.entries(item.errorSummary)) {
        console.log(`  - ${k}: ${v}`);
      }
    }

    console.log("");
    console.log(`errorSamples (max ${MAX_ERROR_SAMPLES}):`);
    if (!item.errorSamples.length) {
      console.log("  <none>");
    } else {
      for (const line of item.errorSamples) console.log(`  - ${line}`);
    }
  }

  if (FLAG_EVENTS) {
    console.log("");
    console.log(`masterEvents (max ${MAX_EVENT_SAMPLES}):`);
    if (!item.masterEvents.length) {
      console.log("  <none>");
    } else {
      for (const line of item.masterEvents) console.log(`  - ${line}`);
    }

    console.log("");
    console.log(`slaveEvents (max ${MAX_EVENT_SAMPLES}):`);
    if (!item.slaveEvents.length) {
      console.log("  <none>");
    } else {
      for (const line of item.slaveEvents) console.log(`  - ${line}`);
    }
  }
}

function printDetailHint() {
  console.log("");
  console.log(
    "┌──────────────────────────── 使用说明 / 参数解释 ────────────────────────────┐",
  );
  console.log(
    "│ 位置参数：                                                                 │",
  );
  console.log(
    "│   [0] total       总请求数，默认 10000                                     │",
  );
  console.log(
    "│   [1] timeoutMs   单请求超时（毫秒），默认 10000                           │",
  );
  console.log(
    '│   [2] authKey     加密模式密钥，默认 "my-secret-key"                       │',
  );
  console.log(
    "│   [3] plainPort   非加密测试端口，默认 6003                                │",
  );
  console.log(
    "│   [4] securePort  加密测试端口，默认 6004                                  │",
  );
  console.log(
    "│   [5] warmupMs    启动后预热等待时间（毫秒），默认 500                     │",
  );
  console.log(
    "│                                                                              │",
  );
  console.log(
    "│ 输出标志：                                                                  │",
  );
  console.log(
    "│   --errors   显示错误分类与错误样本                                         │",
  );
  console.log(
    "│   --events   显示 master/slave 事件样本                                     │",
  );
  console.log(
    "│   --json     输出 JSON 摘要                                                 │",
  );
  console.log(
    "│   --full     显示全部详细信息（等价于 --errors --events --json）            │",
  );
  console.log(
    "│   --help     显示帮助                                                       │",
  );
  console.log(
    "│                                                                              │",
  );
  console.log(
    "│ 示例：                                                                      │",
  );
  console.log(
    "│   pnpm test:load                                                            │",
  );
  console.log(
    "│   node test/load-report.js 100000 30000 my-secret-key                       │",
  );
  console.log(
    "│   node test/load-report.js 100000 30000 my-secret-key 6003 6004 500 --full  │",
  );
  console.log(
    "└──────────────────────────────────────────────────────────────────────────────┘",
  );
}

function printComparison(items) {
  const plain = items.find((x) => x.name === "plain");
  const encrypted = items.find((x) => x.name === "encrypted");

  console.log("");
  console.log(
    "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 对比仪表盘 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  );

  if (!plain || !encrypted) {
    console.log(
      "┃ 缺少 plain / encrypted 结果，无法对比。                                             ┃",
    );
    console.log(
      "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
    );
    return;
  }

  const result =
    plain.fail === 0 && encrypted.fail === 0
      ? "ALL PASS"
      : plain.fail === 0 && encrypted.fail > 0
        ? "PLAIN PASS / ENCRYPTED DEGRADED"
        : plain.fail > 0 && encrypted.fail > 0
          ? "BOTH DEGRADED"
          : "MIXED";

  console.log(
    `┃ 成功数对比     plain=${padRight(String(plain.ok), 10)} encrypted=${padRight(String(encrypted.ok), 10)} delta=${padRight(String(encrypted.ok - plain.ok), 10)}┃`,
  );
  console.log(
    `┃ 失败数对比     plain=${padRight(String(plain.fail), 10)} encrypted=${padRight(String(encrypted.fail), 10)} delta=${padRight(String(encrypted.fail - plain.fail), 10)}┃`,
  );
  console.log(
    `┃ 请求耗时对比   plain=${padRight(`${plain.requestCostMs} ms`, 12)} encrypted=${padRight(`${encrypted.requestCostMs} ms`, 12)} delta=${padRight(`${encrypted.requestCostMs - plain.requestCostMs} ms`, 12)}┃`,
  );
  console.log(
    `┃ 吞吐对比       plain=${padRight(String(plain.throughputPerSec), 10)} encrypted=${padRight(String(encrypted.throughputPerSec), 10)} ratio=${padRight(plain.throughputPerSec > 0 ? String(round(encrypted.throughputPerSec / plain.throughputPerSec, 4)) : "n/a", 10)}┃`,
  );
  console.log(
    `┃ p95 对比       plain=${padRight(`${plain.latency.p95Ms} ms`, 12)} encrypted=${padRight(`${encrypted.latency.p95Ms} ms`, 12)} delta=${padRight(`${toDelta(encrypted.latency.p95Ms, plain.latency.p95Ms)} ms`, 12)}┃`,
  );
  console.log(
    `┃ p99 对比       plain=${padRight(`${plain.latency.p99Ms} ms`, 12)} encrypted=${padRight(`${encrypted.latency.p99Ms} ms`, 12)} delta=${padRight(`${toDelta(encrypted.latency.p99Ms, plain.latency.p99Ms)} ms`, 12)}┃`,
  );
  console.log(`┃ 结论           ${padRight(result, 76)}┃`);
  console.log(
    "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
  );
}

function toDelta(a, b) {
  if (a == null || b == null) return "n/a";
  return a - b;
}

function padRight(value, width) {
  const text = String(value ?? "");
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function printHelp() {
  console.log("");
  console.log("ZNL 统一压测脚本 - 帮助");
  console.log("");
  console.log("用法：");
  console.log(
    "  node test/load-report.js [total] [timeoutMs] [authKey] [plainPort] [securePort] [warmupMs] [flags]",
  );
  console.log("");
  console.log("位置参数说明：");
  console.log("  total       总请求数，默认 10000");
  console.log("  timeoutMs   单请求超时（毫秒），默认 10000");
  console.log('  authKey     加密模式密钥，默认 "my-secret-key"');
  console.log("  plainPort   非加密测试端口，默认 6003");
  console.log("  securePort  加密测试端口，默认 6004");
  console.log("  warmupMs    启动后预热等待时间（毫秒），默认 500");
  console.log("");
  console.log("输出标志说明：");
  console.log("  --errors    显示错误分类与错误样本");
  console.log("  --events    显示 master/slave 事件样本");
  console.log("  --json      输出 JSON 摘要");
  console.log("  --full      显示全部详细信息");
  console.log("  --help, -h  显示帮助");
  console.log("");
  console.log("示例：");
  console.log("  pnpm test:load");
  console.log("  node test/load-report.js 100000 30000 my-secret-key");
  console.log(
    "  node test/load-report.js 100000 30000 my-secret-key 6003 6004 500 --errors",
  );
  console.log(
    "  node test/load-report.js 100000 30000 my-secret-key 6003 6004 500 --full",
  );
}
