import { ZNL } from "../../../index.js";
import {
  attachLogger,
  delay,
  installTimeoutScaling,
  safeStop,
  toText,
} from "../helpers/common.js";

installTimeoutScaling();

export async function runRpcAndPayloadTests(runner) {
  runner.section("RPC 双向通信与载荷");

  const EP1 = "tcp://127.0.0.1:16003";

  const master = new ZNL({
    role: "master",
    id: "test-master",
    endpoints: { router: EP1 },
    maxPending: 200,
  });

  const slave = new ZNL({
    role: "slave",
    id: "test-slave",
    endpoints: { router: EP1 },
    maxPending: 200,
  });

  master.ROUTER(async ({ payload }) => `M:${toText(payload)}`);
  slave.DEALER(async ({ payload }) => `S:${toText(payload)}`);

  const logState = { silent: false };
  attachLogger(master, "MASTER", logState);
  attachLogger(slave, "SLAVE ", logState);

  await master.start();
  await slave.start();
  await delay(200);

  try {
    await runner.test("slave → master：基础请求", async () => {
      const response = await slave.DEALER("hello", { timeoutMs: 3000 });
      runner.assert(
        toText(response) === "M:hello",
        `响应内容匹配 → "${toText(response)}"`,
      );
    });

    await runner.test("master → slave：主动发送", async () => {
      const response = await master.ROUTER("test-slave", "ping", {
        timeoutMs: 3000,
      });
      runner.assert(
        toText(response) === "S:ping",
        `响应内容匹配 → "${toText(response)}"`,
      );
    });

    await runner.test("Buffer payload", async () => {
      const response = await slave.DEALER(Buffer.from("bin-data"), {
        timeoutMs: 3000,
      });
      runner.assert(
        toText(response) === "M:bin-data",
        `Buffer payload 正常 → "${toText(response)}"`,
      );
    });

    await runner.test("request / response 事件在双向 RPC 中正确触发", async () => {
      const masterRequests = [];
      const masterResponses = [];
      const slaveRequests = [];
      const slaveResponses = [];

      master.on("request", ({ identityText, payload }) => {
        masterRequests.push(`${identityText}:${toText(payload)}`);
      });
      master.on("response", ({ identityText, payload }) => {
        masterResponses.push(`${identityText}:${toText(payload)}`);
      });

      slave.on("request", ({ payload }) => {
        slaveRequests.push(toText(payload));
      });
      slave.on("response", ({ payload }) => {
        slaveResponses.push(toText(payload));
      });

      const res1 = await slave.DEALER("evt-a", { timeoutMs: 3000 });
      const res2 = await master.ROUTER("test-slave", "evt-b", {
        timeoutMs: 3000,
      });

      runner.assert(
        toText(res1) === "M:evt-a",
        `slave→master 响应正确 → "${toText(res1)}"`,
      );
      runner.assert(
        toText(res2) === "S:evt-b",
        `master→slave 响应正确 → "${toText(res2)}"`,
      );

      runner.assert(
        masterRequests.includes("test-slave:evt-a"),
        `master request 事件正确 → ${masterRequests.join(", ")}`,
      );
      runner.assert(
        masterResponses.some((v) => v === "test-slave:S:evt-b"),
        `master response 事件正确 → ${masterResponses.join(", ")}`,
      );
      runner.assert(
        slaveRequests.includes("evt-b"),
        `slave request 事件正确 → ${slaveRequests.join(", ")}`,
      );
      runner.assert(
        slaveResponses.includes("M:evt-a"),
        `slave response 事件正确 → ${slaveResponses.join(", ")}`,
      );
    });

    await runner.test("并发 100 条请求（全部内容一致性校验）", async () => {
      logState.silent = true;
      runner.log('    [并发] 正在发送 100 条请求...');

      const tasks = Array.from({ length: 100 }, (_, i) =>
        slave.DEALER(`item-${i}`, { timeoutMs: 5000 }),
      );
      const results = await Promise.all(tasks);

      logState.silent = false;
      runner.log(`    [并发] 全部完成：发出 100 条 / 收到 ${results.length} 条`);

      const allOk = results.every((value, i) => toText(value) === `M:item-${i}`);
      runner.assert(allOk, "100 条并发响应内容全部匹配，无乱序");
    });

    await runner.test("Uint8Array payload", async () => {
      const response = await slave.DEALER(new Uint8Array([65, 66, 67]), {
        timeoutMs: 3000,
      });
      runner.assert(
        toText(response) === "M:ABC",
        `Uint8Array 正常 → "${toText(response)}"`,
      );
    });

    await runner.test("null / undefined payload 被标准化为空帧", async () => {
      const r1 = await slave.DEALER(null, { timeoutMs: 3000 });
      const r2 = await slave.DEALER(undefined, { timeoutMs: 3000 });

      runner.assert(
        toText(r1) === "M:",
        `null 被标准化为空帧 → "${toText(r1)}"`,
      );
      runner.assert(
        toText(r2) === "M:",
        `undefined 被标准化为空帧 → "${toText(r2)}"`,
      );
    });

    await runner.test("多帧 payload 保持顺序与内容", async () => {
      const EP_PAYLOAD = "tcp://127.0.0.1:16015";

      const payloadMaster = new ZNL({
        role: "master",
        id: "m-payload",
        endpoints: { router: EP_PAYLOAD },
      });

      const payloadSlave = new ZNL({
        role: "slave",
        id: "s-payload",
        endpoints: { router: EP_PAYLOAD },
      });

      payloadMaster.ROUTER(async ({ payload }) => payload);

      await payloadMaster.start();
      await payloadSlave.start();
      await delay(150);

      try {
        const frames = ["a", Buffer.from("b"), new Uint8Array([99])];
        const reply = await payloadSlave.DEALER(frames, { timeoutMs: 3000 });

        runner.assert(Array.isArray(reply), "多帧响应类型为数组");

        const texts = reply.map(toText);
        runner.assert(
          texts.join("|") === "a|b|c",
          `多帧内容匹配 → "${texts.join("|")}"`,
        );
      } finally {
        await safeStop(payloadSlave, payloadMaster);
      }
    });

    await runner.test("非法 payload 类型应抛错", async () => {
      let threw = false;

      try {
        await slave.DEALER({ bad: true }, { timeoutMs: 1000 });
      } catch (error) {
        threw = true;
        runner.assert(
          String(error?.message ?? error).includes("payload"),
          `错误信息包含 payload → "${error?.message ?? error}"`,
        );
      }

      if (!threw) {
        runner.fail("未抛错（非法 payload）");
      }
    });
  } finally {
    await safeStop(slave, master);
  }
}
