import { ZNL } from "../../../index.js";
import { PendingManager } from "../../../src/PendingManager.js";
import { SendQueue } from "../../../src/SendQueue.js";
import {
  delay,
  installTimeoutScaling,
  safeStop,
  toText,
  scaleMs,
} from "../helpers/common.js";
import { expectRejected } from "../helpers/assertions.js";

installTimeoutScaling();

export async function runLifecycleAndPendingTests(runner) {
  runner.section("生命周期 / 超时 / Pending");

  await runner.test("start()/stop() 可重复调用且无异常", async () => {
    const EP_IDEMP = "tcp://127.0.0.1:16016";

    const master = new ZNL({
      role: "master",
      id: "m-idemp",
      endpoints: { router: EP_IDEMP },
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-idemp",
      endpoints: { router: EP_IDEMP },
    });

    try {
      await master.start();
      await master.start();
      await slave.start();
      await slave.start();

      await slave.stop();
      await slave.stop();
      await master.stop();
      await master.stop();

      runner.assert(true, "start/stop 重复调用正常");
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test("stop 后重新 start 可恢复通信", async () => {
    const EP_RS = "tcp://127.0.0.1:16023";

    const master = new ZNL({
      role: "master",
      id: "m-r",
      endpoints: { router: EP_RS },
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-r",
      endpoints: { router: EP_RS },
    });

    master.ROUTER(async ({ payload }) => `MR:${toText(payload)}`);

    try {
      await master.start();
      await slave.start();
      await delay(100);

      const first = await slave.DEALER("first", { timeoutMs: 2000 });
      runner.assert(
        toText(first) === "MR:first",
        `首次通信正常 → "${toText(first)}"`,
      );

      await slave.stop();
      await master.stop();

      await master.start();
      await slave.start();
      await delay(150);

      const second = await slave.DEALER("second", { timeoutMs: 2000 });
      runner.assert(
        toText(second) === "MR:second",
        `重启后通信正常 → "${toText(second)}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test("未 start 时调用 DEALER/ROUTER 应抛错", async () => {
    const EP_PRE = "tcp://127.0.0.1:16017";

    const master = new ZNL({
      role: "master",
      id: "m-pre",
      endpoints: { router: EP_PRE },
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-pre",
      endpoints: { router: EP_PRE },
    });

    const dealerResult = await expectRejected(
      () => slave.DEALER("ping", { timeoutMs: 200 }),
      ["socket"],
    );

    const routerResult = await expectRejected(
      () => master.ROUTER("s-pre", "ping", { timeoutMs: 200 }),
      ["socket"],
    );

    runner.assert(dealerResult.rejected, "DEALER 未 start 应抛错");
    runner.assert(
      dealerResult.matched,
      `DEALER 未 start 抛错 → "${dealerResult.message}"`,
    );

    runner.assert(routerResult.rejected, "ROUTER 未 start 应抛错");
    runner.assert(
      routerResult.matched,
      `ROUTER 未 start 抛错 → "${routerResult.message}"`,
    );
  });

  await runner.test(
    "master 无处理器 → slave 在指定时间内正确超时",
    async () => {
      const EP_TIMEOUT = "tcp://127.0.0.1:16004";

      const master = new ZNL({
        role: "master",
        id: "m-timeout",
        endpoints: { router: EP_TIMEOUT },
      });

      const slave = new ZNL({
        role: "slave",
        id: "s-timeout",
        endpoints: { router: EP_TIMEOUT },
      });

      try {
        await master.start();
        await slave.start();
        await delay(100);

        const startAt = Date.now();
        const timeoutResult = await expectRejected(
          () => slave.DEALER("no-reply", { timeoutMs: 400 }),
          ["请求超时"],
        );
        const elapsed = Date.now() - startAt;

        runner.assert(timeoutResult.rejected, "无处理器时应超时 reject");
        runner.assert(
          timeoutResult.matched,
          `正确超时 → "${timeoutResult.message}"`,
        );

        runner.assert(
          elapsed >= scaleMs(380) && elapsed < scaleMs(1500),
          `超时时机合理 → ${elapsed}ms`,
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test("maxPending 达到上限时拒绝新请求", async () => {
    const EP_MAX_PENDING = "tcp://127.0.0.1:16018";

    const master = new ZNL({
      role: "master",
      id: "m-mp",
      endpoints: { router: EP_MAX_PENDING },
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-mp",
      endpoints: { router: EP_MAX_PENDING },
      maxPending: 1,
    });

    master.ROUTER(async () => {
      await delay(300);
      return "ok";
    });

    try {
      await master.start();
      await slave.start();
      await delay(150);

      const first = slave.DEALER("one", { timeoutMs: 1000 });
      const secondResult = await expectRejected(
        () => slave.DEALER("two", { timeoutMs: 300 }),
        ["并发请求数已达上限"],
      );

      runner.assert(secondResult.rejected, "第二个请求应被拒绝");
      runner.assert(
        secondResult.matched,
        `maxPending 拒绝新请求 → "${secondResult.message}"`,
      );

      const firstReply = await first;
      runner.assert(
        toText(firstReply) === "ok",
        `首个请求仍可完成 → "${toText(firstReply)}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test("stop() 期间所有 in-flight 请求立即 reject", async () => {
    const EP_STOP_PENDING = "tcp://127.0.0.1:16005";

    const master = new ZNL({
      role: "master",
      id: "m-stop",
      endpoints: { router: EP_STOP_PENDING },
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-stop",
      endpoints: { router: EP_STOP_PENDING },
    });

    master.ROUTER(async () => {
      await delay(3000);
      return "late";
    });

    try {
      await master.start();
      await slave.start();
      await delay(100);

      const requestPromise = slave.DEALER("long-req", { timeoutMs: 10000 });

      await delay(150);
      await slave.stop();

      const stopResult = await expectRejected(
        () => requestPromise,
        ["已停止", "cancelled"],
      );

      runner.assert(stopResult.rejected, "stop 后请求应 reject");
      runner.assert(
        stopResult.matched,
        `stop 后正确 reject → "${stopResult.message}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test("master→slave 顺序保持（20 条）", async () => {
    const EP_SEND_ORDER = "tcp://127.0.0.1:16036";

    const master = new ZNL({
      role: "master",
      id: "m-sq",
      endpoints: { router: EP_SEND_ORDER },
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-sq",
      endpoints: { router: EP_SEND_ORDER },
    });

    const seq = [];
    await slave.DEALER(async ({ payload }) => {
      const n = Number(toText(payload).split("-")[1] ?? -1);
      seq.push(n);
      return `ACK-${n}`;
    });

    try {
      await master.start();
      await slave.start();
      await delay(200);

      const tasks = Array.from({ length: 20 }, (_, i) =>
        master.ROUTER("s-sq", `seq-${i}`, { timeoutMs: 3000 }),
      );

      await Promise.all(tasks);

      const ok = seq.every((n, i) => n === i);
      runner.assert(ok, `顺序一致 → [${seq.join(", ")}]`);
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test(
    "PendingManager：ensureCapacity 在未超限时不抛错",
    async () => {
      const pending = new PendingManager(2);

      pending.ensureCapacity();
      pending.create("k1", 10, "r1");
      pending.ensureCapacity();

      runner.assert(true, "未超限时 ensureCapacity 正常");
    },
  );

  await runner.test("PendingManager：ensureCapacity 在超限时抛错", async () => {
    const pending = new PendingManager(1);
    pending.create("k1", 10, "r1");

    const overLimitResult = await expectRejected(
      () => pending.ensureCapacity(),
      ["并发请求数已达上限"],
    );

    runner.assert(overLimitResult.rejected, "ensureCapacity 超限应抛错");
    runner.assert(
      overLimitResult.matched,
      `超限时正确抛错 → "${overLimitResult.message}"`,
    );
  });

  await runner.test(
    "PendingManager：create + resolve 能正确完成并清理",
    async () => {
      const pending = new PendingManager(10);
      const { promise, startTimer } = pending.create("k1", 50, "r1");

      startTimer();
      const resolved = pending.resolve("k1", "done");
      const result = await promise;

      runner.assert(resolved === true, "resolve 返回 true");
      runner.assert(result === "done", `结果正确 → "${result}"`);
      runner.assert(
        pending.size === 0,
        `resolve 后 size 清零 → ${pending.size}`,
      );
    },
  );

  await runner.test(
    "PendingManager：create + reject 能正确完成并清理",
    async () => {
      const pending = new PendingManager(10);
      const { promise, startTimer } = pending.create("k1", 50, "r1");

      startTimer();
      const rejected = pending.reject("k1", new Error("fail"));

      const rejectResult = await expectRejected(() => promise, ["fail"]);

      runner.assert(rejected === true, "reject 返回 true");
      runner.assert(rejectResult.rejected, "reject 后 promise 应拒绝");
      runner.assert(
        rejectResult.matched,
        `reject 结果正确 → "${rejectResult.message}"`,
      );
      runner.assert(
        pending.size === 0,
        `reject 后 size 清零 → ${pending.size}`,
      );
    },
  );

  await runner.test("PendingManager：超时会自动 reject 并清理", async () => {
    const pending = new PendingManager(10);
    const { promise, startTimer } = pending.create("k1", 30, "r1");

    startTimer();

    const timeoutResult = await expectRejected(() => promise, ["请求超时"]);

    runner.assert(timeoutResult.rejected, "超时后 promise 应拒绝");
    runner.assert(
      timeoutResult.matched,
      `超时自动 reject → "${timeoutResult.message}"`,
    );
    runner.assert(pending.size === 0, `超时后 size 清零 → ${pending.size}`);
  });

  await runner.test(
    "PendingManager：rejectAll 会批量取消所有 pending",
    async () => {
      const pending = new PendingManager(10);

      const p1 = pending.create("k1", 1000, "r1");
      const p2 = pending.create("k2", 1000, "r2");
      p1.startTimer();
      p2.startTimer();

      pending.rejectAll(new Error("stop"));

      const p1Result = await expectRejected(() => p1.promise, ["stop"]);
      const p2Result = await expectRejected(() => p2.promise, ["stop"]);

      runner.assert(
        p1Result.rejected && p1Result.matched,
        `第一个 pending 被取消 → "${p1Result.message}"`,
      );
      runner.assert(
        p2Result.rejected && p2Result.matched,
        `第二个 pending 被取消 → "${p2Result.message}"`,
      );
      runner.assert(
        pending.size === 0,
        `rejectAll 后 size 清零 → ${pending.size}`,
      );
    },
  );

  await runner.test("PendingManager：key 生成规则正确", async () => {
    const pending = new PendingManager(10);
    const key1 = pending.key("rid");
    const key2 = pending.key("rid", "slave-1");

    runner.assert(key1 === "rid", `无 identity key 正确 → "${key1}"`);
    runner.assert(key2 === "slave-1::rid", `有 identity key 正确 → "${key2}"`);
  });

  await runner.test("SendQueue：同一通道按顺序执行", async () => {
    const queue = new SendQueue();
    const results = [];

    const task = (label, delayMs) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      results.push(label);
    };

    const p1 = queue.enqueue("router", task("A", 30));
    const p2 = queue.enqueue("router", task("B", 10));
    const p3 = queue.enqueue("router", task("C", 0));

    await Promise.all([p1, p2, p3]);

    runner.assert(
      results.join(",") === "A,B,C",
      `同一通道顺序正确 → [${results.join(", ")}]`,
    );
  });

  await runner.test("SendQueue：不同通道可并行，但各自保持顺序", async () => {
    const queue = new SendQueue();
    const results = [];

    const task = (label, delayMs) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      results.push(label);
    };

    const p1 = queue.enqueue("router", task("R1", 20));
    const p2 = queue.enqueue("router", task("R2", 0));
    const p3 = queue.enqueue("dealer", task("D1", 10));
    const p4 = queue.enqueue("dealer", task("D2", 0));

    await Promise.all([p1, p2, p3, p4]);

    const router = results.filter((value) => value.startsWith("R"));
    const dealer = results.filter((value) => value.startsWith("D"));

    runner.assert(
      router.join(",") === "R1,R2",
      `router 通道顺序正确 → [${router.join(", ")}]`,
    );
    runner.assert(
      dealer.join(",") === "D1,D2",
      `dealer 通道顺序正确 → [${dealer.join(", ")}]`,
    );
  });
}
