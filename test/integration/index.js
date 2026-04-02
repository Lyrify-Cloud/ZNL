import { TestRunner } from "./runner.js";
import { VERBOSE } from "./helpers/common.js";
import { runConstructorAndApiTests } from "./modules/constructor-and-api.test.js";
import { runRpcAndPayloadTests } from "./modules/rpc-and-payload.test.js";
import { runLifecycleAndPendingTests } from "./modules/lifecycle-and-pending.test.js";
import { runPubsubAndHeartbeatTests } from "./modules/pubsub-and-heartbeat.test.js";
import { runSecurityTests } from "./modules/security.test.js";
import { runFsServiceTests } from "./modules/fs-service.test.js";

const moduleRunners = [
  ["constructor", runConstructorAndApiTests],
  ["rpc", runRpcAndPayloadTests],
  ["lifecycle", runLifecycleAndPendingTests],
  ["pubsub", runPubsubAndHeartbeatTests],
  ["security", runSecurityTests],
  ["fs", runFsServiceTests],
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

function resolveReporter(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] ?? "").trim();

    if (token === "--json") return "json";

    if (token === "--reporter" || token === "-r") {
      return normalizeReporter(argv[i + 1]);
    }

    if (token.startsWith("--reporter=")) {
      return normalizeReporter(token.slice("--reporter=".length));
    }
  }

  return normalizeReporter(process.env.ZNL_TEST_REPORTER);
}

let globalErrorHandlingInstalled = false;

function installGlobalErrorHandling() {
  if (globalErrorHandlingInstalled) return;
  globalErrorHandlingInstalled = true;

  const handleFatal = (source, error) => {
    if (isIgnorableStopCancelError(error)) return;

    const detail = error?.stack ?? error?.message ?? String(error);
    console.error(`\n[integration] ${source}:\n${detail}`);
    process.exitCode = 1;
  };

  process.on("unhandledRejection", (reason) => {
    handleFatal("unhandledRejection", reason);
  });

  process.on("uncaughtException", (error) => {
    handleFatal("uncaughtException", error);
  });
}

export async function runIntegrationTests({
  reporter = resolveReporter(),
} = {}) {
  const selectedReporter = normalizeReporter(reporter);
  const runner = new TestRunner({
    verbose: VERBOSE,
    reporter: selectedReporter,
    exitOnComplete: false,
  });

  runner.banner("ZNL 集成测试（模块化版）");

  for (const [, runModule] of moduleRunners) {
    await runModule(runner);
  }

  return runner.summary({ format: selectedReporter, exitProcess: false });
}

async function main() {
  installGlobalErrorHandling();

  try {
    const report = await runIntegrationTests();
    const hasFailure =
      report?.totals?.testsFailed > 0 || report?.totals?.assertionsFailed > 0;
    process.exitCode = hasFailure ? 1 : 0;
  } catch (error) {
    if (isIgnorableStopCancelError(error)) {
      process.exitCode = 0;
      return;
    }

    const detail = error?.stack ?? error?.message ?? String(error);
    console.error(`\n[integration] fatal:\n${detail}`);
    process.exitCode = 1;
  }
}

await main();
