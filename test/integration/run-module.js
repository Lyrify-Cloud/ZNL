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

const aliasHints = [
  ["api", "constructor"],
  ["payload", "rpc"],
  ["pending", "lifecycle"],
  ["heartbeat", "pubsub"],
];

const isIgnorableStopCancelError = (error) => {
  const message = String(error?.message ?? error ?? "");
  return (
    message.includes("节点已停止，所有待处理请求已取消") ||
    message.includes("已停止，所有待处理请求已取消")
  );
};

const normalizeReporter = (value) => {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "json" ? "json" : "human";
};

function parseCli(argv = process.argv.slice(2)) {
  let moduleInput = "";
  let reporter = normalizeReporter(process.env.ZNL_TEST_REPORTER);
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] ?? "").trim();

    if (!token) continue;

    if (token === "--help" || token === "-h" || token === "help") {
      help = true;
      continue;
    }

    if (token === "--json") {
      reporter = "json";
      continue;
    }

    if (token === "--reporter" || token === "-r") {
      reporter = normalizeReporter(argv[i + 1]);
      i++;
      continue;
    }

    if (token.startsWith("--reporter=")) {
      reporter = normalizeReporter(token.slice("--reporter=".length));
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!moduleInput) {
      moduleInput = token.toLowerCase();
    }
  }

  return { moduleInput, reporter, help };
}

function printUsage() {
  console.log("用法:");
  console.log("  node test/integration/run-module.js <module> [--json]");
  console.log(
    "  node test/integration/run-module.js <module> --reporter <human|json>",
  );
  console.log("");

  console.log("可选模块:");
  for (const name of canonicalModuleNames) {
    console.log(`  - ${name}`);
  }

  console.log("");
  console.log("别名:");
  for (const [alias, target] of aliasHints) {
    console.log(`  ${alias} -> ${target}`);
  }

  console.log("");
  console.log("报告参数:");
  console.log("  --json                      等价于 --reporter json");
  console.log("  --reporter <human|json>");
  console.log("  -r <human|json>");
  console.log("");
  console.log("环境变量:");
  console.log("  ZNL_TEST_REPORTER=human|json");
}

let globalErrorHandlingInstalled = false;

function installGlobalErrorHandling() {
  if (globalErrorHandlingInstalled) return;
  globalErrorHandlingInstalled = true;

  const handleFatal = (source, error) => {
    if (isIgnorableStopCancelError(error)) return;
    const detail = error?.stack ?? error?.message ?? String(error);
    console.error(`\n[run-module] ${source}:\n${detail}`);
    process.exitCode = 1;
  };

  process.on("unhandledRejection", (reason) => {
    handleFatal("unhandledRejection", reason);
  });

  process.on("uncaughtException", (error) => {
    handleFatal("uncaughtException", error);
  });
}

async function runSingleModule({ moduleInput, reporter }) {
  const runModule = modules.get(moduleInput);

  if (!runModule) {
    console.error(`未知集成测试模块: ${moduleInput || "(empty)"}`);
    console.error("");
    printUsage();
    process.exitCode = 1;
    return;
  }

  const runner = new TestRunner({
    verbose: VERBOSE,
    reporter,
    exitOnComplete: false,
  });

  runner.banner(`ZNL 集成测试（模块: ${moduleInput}）`);
  await runModule(runner);

  const report = runner.summary({ format: reporter, exitProcess: false });
  const hasFailure =
    report?.totals?.testsFailed > 0 || report?.totals?.assertionsFailed > 0;
  process.exitCode = hasFailure ? 1 : 0;
}

async function main() {
  installGlobalErrorHandling();

  const { moduleInput, reporter, help } = parseCli();

  if (help || !moduleInput) {
    printUsage();
    process.exitCode = help ? 0 : 1;
    return;
  }

  try {
    await runSingleModule({ moduleInput, reporter });
  } catch (error) {
    if (isIgnorableStopCancelError(error)) {
      process.exitCode = 0;
      return;
    }

    const detail = error?.stack ?? error?.message ?? String(error);
    console.error(`\n[run-module] fatal:\n${detail}`);
    process.exitCode = 1;
  }
}

await main();
