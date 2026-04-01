import { TestRunner } from "./runner.js";
import { VERBOSE } from "./helpers/common.js";
import { runConstructorAndApiTests } from "./modules/constructor-and-api.test.js";
import { runRpcAndPayloadTests } from "./modules/rpc-and-payload.test.js";
import { runLifecycleAndPendingTests } from "./modules/lifecycle-and-pending.test.js";
import { runPubsubAndHeartbeatTests } from "./modules/pubsub-and-heartbeat.test.js";
import { runSecurityTests } from "./modules/security.test.js";
import { runFsServiceTests } from "./modules/fs-service.test.js";

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

export async function runIntegrationTests() {
  const runner = new TestRunner({ verbose: VERBOSE });

  runner.banner("ZNL 集成测试（模块化版）");

  await runConstructorAndApiTests(runner);
  await runRpcAndPayloadTests(runner);
  await runLifecycleAndPendingTests(runner);
  await runPubsubAndHeartbeatTests(runner);
  await runSecurityTests(runner);
  await runFsServiceTests(runner);

  runner.summary();
}

await runIntegrationTests();
