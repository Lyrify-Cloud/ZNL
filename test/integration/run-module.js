import { TestRunner } from "./runner.js";
import { VERBOSE } from "./helpers/common.js";

import { runConstructorAndApiTests } from "./modules/constructor-and-api.test.js";
import { runRpcAndPayloadTests } from "./modules/rpc-and-payload.test.js";
import { runLifecycleAndPendingTests } from "./modules/lifecycle-and-pending.test.js";
import { runPubsubAndHeartbeatTests } from "./modules/pubsub-and-heartbeat.test.js";
import { runSecurityTests } from "./modules/security.test.js";
import { runFsServiceTests } from "./modules/fs-service.test.js";

const modules = new Map([
  ["constructor", runConstructorAndApiTests],
  ["api", runConstructorAndApiTests],
  ["rpc", runRpcAndPayloadTests],
  ["payload", runRpcAndPayloadTests],
  ["lifecycle", runLifecycleAndPendingTests],
  ["pending", runLifecycleAndPendingTests],
  ["pubsub", runPubsubAndHeartbeatTests],
  ["heartbeat", runPubsubAndHeartbeatTests],
  ["security", runSecurityTests],
  ["fs", runFsServiceTests],
]);

const canonicalModuleNames = [
  "constructor",
  "rpc",
  "lifecycle",
  "pubsub",
  "security",
  "fs",
];

const isIgnorableStopCancelError = (error) => {
  const message = String(error?.message ?? error ?? "");
  return (
    message.includes("节点已停止，所有待处理请求已取消") ||
    message.includes("已停止，所有待处理请求已取消")
  );
};

process.on("unhandledRejection", (reason) => {
  if (isIgnorableStopCancelError(reason)) {
    return;
  }
  throw reason;
});

process.on("uncaughtException", (error) => {
  if (isIgnorableStopCancelError(error)) {
    return;
  }
  throw error;
});

function printUsage() {
  console.log("用法:");
  console.log("  node test/integration/run-module.js <module>");
  console.log("");
  console.log("可选模块:");
  for (const name of canonicalModuleNames) {
    console.log(`  - ${name}`);
  }
  console.log("");
  console.log("别名:");
  console.log("  api -> constructor");
  console.log("  payload -> rpc");
  console.log("  pending -> lifecycle");
  console.log("  heartbeat -> pubsub");
}

async function main() {
  const input = String(process.argv[2] ?? "").trim().toLowerCase();

  if (!input || input === "--help" || input === "-h" || input === "help") {
    printUsage();
    process.exit(input ? 0 : 1);
  }

  const runModule = modules.get(input);

  if (!runModule) {
    console.error(`未知集成测试模块: ${input}`);
    console.error("");
    printUsage();
    process.exit(1);
  }

  const runner = new TestRunner({ verbose: VERBOSE });
  runner.banner(`ZNL 集成测试（模块: ${input}）`);

  await runModule(runner);
  runner.summary();
}

await main();
