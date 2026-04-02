import * as zmq from "zeromq";
import { ZNL } from "../../../index.js";
import { CONTROL_PREFIX, CONTROL_REGISTER } from "../../../src/constants.js";
import {
  delay,
  installTimeoutScaling,
  safeStop,
  scaleMs,
  toText,
  waitForOnline,
  waitForOffline,
  waitForRegistered,
} from "../helpers/common.js";

installTimeoutScaling();

export async function runPubsubAndHeartbeatTests(runner) {
  runner.section("PUB/SUB/PUSH 与心跳");

  await runner.test(
    "slave 只收到已订阅的 topic，未订阅的 topic 静默丢弃",
    async () => {
      const EP4 = "tcp://127.0.0.1:16006";
      const master = new ZNL({
        role: "master",
        id: "m4",
        endpoints: { router: EP4 },
      });
      const slave = new ZNL({
        role: "slave",
        id: "s4",
        endpoints: { router: EP4 },
      });

      const received = [];
      slave.SUBSCRIBE("news", ({ topic, payload }) => {
        received.push({ topic, text: toText(payload) });
      });

      await master.start();
      await slave.start();
      await delay(200);

      try {
        runner.assert(
          master.slaves.includes("s4"),
          `master.slaves 包含 s4 → ${master.slaves}`,
        );

        master.PUBLISH("news", "breaking news!");
        master.PUBLISH("weather", "sunny day");
        await delay(100);

        runner.assert(
          received.length === 1,
          `只收到 1 条（news）→ 实际 ${received.length} 条`,
        );
        runner.assert(
          received[0]?.text === "breaking news!",
          `内容匹配 → "${received[0]?.text}"`,
        );
        runner.assert(
          received[0]?.topic === "news",
          `topic 匹配 → "${received[0]?.topic}"`,
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test(
    "多 slave 广播：每个 slave 都能收到，slave.on('publish') 兜底监听（PUBLISH）",
    async () => {
      const EP5 = "tcp://127.0.0.1:16007";
      const master = new ZNL({
        role: "master",
        id: "m5",
        endpoints: { router: EP5 },
      });
      const slaveA = new ZNL({
        role: "slave",
        id: "s5a",
        endpoints: { router: EP5 },
      });
      const slaveB = new ZNL({
        role: "slave",
        id: "s5b",
        endpoints: { router: EP5 },
      });

      const slaveALog = [];
      const slaveBLog = [];

      slaveA.SUBSCRIBE("chat", ({ payload }) =>
        slaveALog.push(toText(payload)),
      );
      slaveB.on("publish", ({ topic, payload }) => {
        slaveBLog.push(`${topic}:${toText(payload)}`);
      });

      await master.start();
      await slaveA.start();
      await slaveB.start();
      await delay(200);

      try {
        runner.assert(
          master.slaves.length === 2,
          `2 个 slave 已注册 → ${master.slaves}`,
        );

        master.PUBLISH("chat", "hello everyone");
        master.PUBLISH("system", "server ok");
        await delay(100);

        runner.assert(
          slaveALog.length === 1,
          `s5a 收到 1 条 → 实际 ${slaveALog.length}`,
        );
        runner.assert(
          slaveALog[0] === "hello everyone",
          `s5a 内容匹配 → "${slaveALog[0]}"`,
        );

        runner.assert(
          slaveBLog.length === 2,
          `s5b 收到 2 条 → 实际 ${slaveBLog.length}`,
        );
        runner.assert(
          slaveBLog.includes("chat:hello everyone"),
          "s5b 包含 chat 消息",
        );
        runner.assert(
          slaveBLog.includes("system:server ok"),
          "s5b 包含 system 消息",
        );
      } finally {
        await safeStop(slaveA, slaveB, master);
      }
    },
  );

  await runner.test(
    "slave_connected / slave_disconnected 事件在 start/stop 时正确触发",
    async () => {
      const EP6 = "tcp://127.0.0.1:16008";
      const master = new ZNL({
        role: "master",
        id: "m6",
        endpoints: { router: EP6 },
      });
      const slave = new ZNL({
        role: "slave",
        id: "s6",
        endpoints: { router: EP6 },
      });

      const connected = [];
      const disconnected = [];
      master.on("slave_connected", (id) => connected.push(id));
      master.on("slave_disconnected", (id) => disconnected.push(id));

      await master.start();
      await slave.start();
      await delay(200);

      try {
        runner.assert(
          connected.includes("s6"),
          `slave_connected 事件触发 → ${connected}`,
        );
        runner.assert(master.slaves.includes("s6"), "master.slaves 包含 s6");
        runner.assert(disconnected.length === 0, "尚未触发 slave_disconnected");

        await slave.stop();
        await delay(100);

        runner.assert(
          disconnected.includes("s6"),
          `slave_disconnected 事件触发 → ${disconnected}`,
        );
        runner.assert(
          !master.slaves.includes("s6"),
          `master.slaves 已移除 s6 → ${master.slaves}`,
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test("UNSUBSCRIBE() 后不再收到该 topic 的消息", async () => {
    const EP7 = "tcp://127.0.0.1:16009";
    const master = new ZNL({
      role: "master",
      id: "m7",
      endpoints: { router: EP7 },
    });
    const slave = new ZNL({
      role: "slave",
      id: "s7",
      endpoints: { router: EP7 },
    });

    const logList = [];
    slave.SUBSCRIBE("ping", ({ payload }) => logList.push(toText(payload)));

    await master.start();
    await slave.start();
    await delay(200);

    try {
      master.PUBLISH("ping", "first");
      await delay(100);
      runner.assert(
        logList.length === 1,
        `订阅期间收到第 1 条 → ${logList.length} 条`,
      );

      slave.UNSUBSCRIBE("ping");
      master.PUBLISH("ping", "second");
      await delay(100);
      runner.assert(
        logList.length === 1,
        `取消订阅后不再收到消息 → 仍是 ${logList.length} 条`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test("PUSH：slave 单向推送 master 收到 push 事件", async () => {
    const EP_PUSH = "tcp://127.0.0.1:16010";
    const master = new ZNL({
      role: "master",
      id: "m-push",
      endpoints: { router: EP_PUSH },
    });
    const slave = new ZNL({
      role: "slave",
      id: "s-push",
      endpoints: { router: EP_PUSH },
    });

    const received = [];
    master.on("push", ({ identityText, topic, payload }) => {
      received.push({ identityText, topic, text: toText(payload) });
    });

    await master.start();
    await slave.start();
    await delay(200);

    try {
      slave.PUSH("metrics", "cpu=0.42");
      await delay(120);

      runner.assert(
        received.length === 1,
        `收到 1 条 push → ${received.length}`,
      );
      runner.assert(
        received[0]?.identityText === "s-push",
        `identity 匹配 → "${received[0]?.identityText}"`,
      );
      runner.assert(
        received[0]?.topic === "metrics",
        `topic 匹配 → "${received[0]?.topic}"`,
      );
      runner.assert(
        received[0]?.text === "cpu=0.42",
        `payload 匹配 → "${received[0]?.text}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test(
    "publish 事件不会被误当作业务 request/response 事件",
    async () => {
      const EP_PUB_EVT = "tcp://127.0.0.1:16043";
      const master = new ZNL({
        role: "master",
        id: "m-pub-evt",
        endpoints: { router: EP_PUB_EVT },
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-pub-evt",
        endpoints: { router: EP_PUB_EVT },
      });

      let publishCount = 0;
      let requestCount = 0;
      let responseCount = 0;

      slave.SUBSCRIBE("audit", () => {
        publishCount++;
      });
      slave.on("request", () => {
        requestCount++;
      });
      slave.on("response", () => {
        responseCount++;
      });

      await master.start();
      await slave.start();
      await delay(200);

      try {
        master.PUBLISH("audit", "evt-1");
        await delay(120);

        runner.assert(publishCount === 1, `publish 正常触发 → ${publishCount}`);
        runner.assert(requestCount === 0, `不应触发 request → ${requestCount}`);
        runner.assert(
          responseCount === 0,
          `不应触发 response → ${responseCount}`,
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test("master 重启后 slave 自动补注册并恢复广播", async () => {
    const EP_RESTART = "tcp://127.0.0.1:16011";

    const master1 = new ZNL({
      role: "master",
      id: "m9",
      endpoints: { router: EP_RESTART },
      heartbeatInterval: scaleMs(200),
    });
    const slave = new ZNL({
      role: "slave",
      id: "s9",
      endpoints: { router: EP_RESTART },
      heartbeatInterval: scaleMs(200),
    });

    const received = [];
    slave.SUBSCRIBE("news", ({ payload }) => received.push(toText(payload)));

    await master1.start();
    await slave.start();
    await delay(200);

    runner.assert(
      master1.slaves.includes("s9"),
      `首次注册成功 → ${master1.slaves}`,
    );

    await master1.stop();
    await delay(300);

    const master2 = new ZNL({
      role: "master",
      id: "m9b",
      endpoints: { router: EP_RESTART },
      heartbeatInterval: scaleMs(200),
    });

    await master2.start();

    try {
      const registered = await waitForRegistered(master2, "s9", {
        timeoutMs: 2000,
        intervalMs: 100,
      });
      runner.assert(registered, `重启后自动补注册成功 → ${master2.slaves}`);

      master2.PUBLISH("news", "after-restart");
      await delay(150);

      runner.assert(
        received.includes("after-restart"),
        `重启后广播可达 → ${received.join(",")}`,
      );
    } finally {
      await safeStop(slave, master2);
    }
  });

  await runner.test(
    "slave 侧外部 API：masterOnline / isMasterOnline 状态正确",
    async () => {
      const EP_ONLINE = "tcp://127.0.0.1:16030";

      const master = new ZNL({
        role: "master",
        id: "m-online",
        endpoints: { router: EP_ONLINE },
        heartbeatInterval: scaleMs(120),
        heartbeatTimeoutMs: scaleMs(240),
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-online",
        endpoints: { router: EP_ONLINE },
        heartbeatInterval: scaleMs(120),
        heartbeatTimeoutMs: scaleMs(240),
      });

      runner.assert(
        slave.masterOnline === false,
        "启动前 masterOnline 默认为 false",
      );
      runner.assert(
        slave.isMasterOnline() === false,
        "启动前 isMasterOnline() 默认为 false",
      );

      await master.start();
      await slave.start();

      try {
        const becameOnline = await waitForOnline(slave, {
          timeoutMs: 2000,
          intervalMs: 100,
        });

        runner.assert(becameOnline, "收到 heartbeat_ack 后主节点状态变为在线");
        runner.assert(slave.masterOnline === true, "masterOnline 属性为 true");
        runner.assert(
          slave.isMasterOnline() === true,
          "isMasterOnline() 返回 true",
        );

        await master.stop();

        const becameOffline = await waitForOffline(slave, {
          timeoutMs: 2500,
          intervalMs: 100,
        });

        runner.assert(becameOffline, "心跳应答超时后主节点状态变为离线");
        runner.assert(
          slave.masterOnline === false,
          "masterOnline 属性恢复为 false",
        );
        runner.assert(
          slave.isMasterOnline() === false,
          "isMasterOnline() 返回 false",
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test(
    "heartbeat_ack：master 重启后 slave 自动恢复在线并恢复 RPC",
    async () => {
      const EP_HB_ACK = "tcp://127.0.0.1:16031";

      const master1 = new ZNL({
        role: "master",
        id: "m-ack-1",
        endpoints: { router: EP_HB_ACK },
        heartbeatInterval: scaleMs(120),
        heartbeatTimeoutMs: scaleMs(240),
      });
      const slave = new ZNL({
        role: "slave",
        id: "s-ack",
        endpoints: { router: EP_HB_ACK },
        heartbeatInterval: scaleMs(120),
        heartbeatTimeoutMs: scaleMs(240),
      });

      await master1.ROUTER(async ({ payload }) => `ack-1:${toText(payload)}`);
      await master1.start();
      await slave.start();

      const online1 = await waitForOnline(slave, {
        timeoutMs: 2000,
        intervalMs: 100,
      });
      runner.assert(online1, "首次 heartbeat_ack 建立在线状态");

      const reply1 = await slave.DEALER("ping-before-restart", {
        timeoutMs: 1200,
      });
      runner.assert(
        toText(reply1) === "ack-1:ping-before-restart",
        `重启前 RPC 正常 → "${toText(reply1)}"`,
      );

      await master1.stop();

      const offline = await waitForOffline(slave, {
        timeoutMs: 2500,
        intervalMs: 100,
      });
      runner.assert(offline, "master 下线后 slave 能感知离线");

      const master2 = new ZNL({
        role: "master",
        id: "m-ack-2",
        endpoints: { router: EP_HB_ACK },
        heartbeatInterval: scaleMs(120),
        heartbeatTimeoutMs: scaleMs(240),
      });

      await master2.ROUTER(async ({ payload }) => `ack-2:${toText(payload)}`);
      await master2.start();

      try {
        const reOnline =
          (await waitForOnline(slave, {
            timeoutMs: 3000,
            intervalMs: 100,
          })) &&
          (await waitForRegistered(master2, "s-ack", {
            timeoutMs: 3000,
            intervalMs: 100,
          }));

        runner.assert(reOnline, `重启后重新在线成功 → ${master2.slaves}`);
        runner.assert(
          slave.isMasterOnline() === true,
          "重启后 isMasterOnline() 返回 true",
        );

        const reply2 = await slave.DEALER("ping-after-restart", {
          timeoutMs: 1500,
        });
        runner.assert(
          toText(reply2) === "ack-2:ping-after-restart",
          `重启后 RPC 恢复正常 → "${toText(reply2)}"`,
        );
      } finally {
        await safeStop(slave, master2);
      }
    },
  );

  await runner.test("心跳禁用（heartbeatInterval=0）不移除节点", async () => {
    const EP_HB0 = "tcp://127.0.0.1:16028";
    const master = new ZNL({
      role: "master",
      id: "m-hb0",
      endpoints: { router: EP_HB0 },
      heartbeatInterval: 0,
    });

    await master.start();

    const dealer = new zmq.Dealer({ routingId: "hb0-slave" });
    dealer.connect(EP_HB0);

    try {
      await dealer.send([CONTROL_PREFIX, CONTROL_REGISTER]);

      await delay(200);
      runner.assert(
        master.slaves.includes("hb0-slave"),
        `hb0-slave 已注册 → ${master.slaves}`,
      );

      await delay(1200);
      runner.assert(master.slaves.includes("hb0-slave"), "心跳禁用后未被移除");
    } finally {
      dealer.close();
      await safeStop(master);
    }
  });

  await runner.test("自定义 heartbeatTimeoutMs 生效", async () => {
    const EP_HB = "tcp://127.0.0.1:16029";
    const master = new ZNL({
      role: "master",
      id: "m-hb",
      endpoints: { router: EP_HB },
      heartbeatInterval: scaleMs(100),
      heartbeatTimeoutMs: scaleMs(250),
    });

    await master.start();

    const dealer = new zmq.Dealer({ routingId: "hb-slave" });
    dealer.connect(EP_HB);

    try {
      await dealer.send([CONTROL_PREFIX, CONTROL_REGISTER]);

      await delay(150);
      runner.assert(
        master.slaves.includes("hb-slave"),
        `hb-slave 已注册 → ${master.slaves}`,
      );

      await delay(400);
      runner.assert(
        !master.slaves.includes("hb-slave"),
        `超过 timeoutMs 后被移除 → ${master.slaves}`,
      );
    } finally {
      dealer.close();
      await safeStop(master);
    }
  });
}
