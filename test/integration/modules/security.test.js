import { createHash } from "node:crypto";
import * as zmq from "zeromq";
import { ZNL } from "../../../index.js";
import {
  decodeFrames,
  decryptFrames,
  deriveKeys,
  digestFrames,
  encodeFrames,
  encryptFrames,
  generateNonce,
  isTimestampFresh,
  ReplayGuard,
  signText,
  verifyTextSignature,
} from "../../../src/security.js";
import {
  buildEncryptedRequestFrames,
  delay,
  installTimeoutScaling,
  safeStop,
  toText,
  waitForRegistered,
} from "../helpers/common.js";
import { createPortAllocator } from "../helpers/ports.js";

installTimeoutScaling();

const ports = createPortAllocator({ offset: 601 });
const takeEndpoint = () => ports.nextEndpoint();

export async function runSecurityTests(runner) {
  runner.section("安全 / 认证 / 加密");

  await runner.test("encodeFrames/decodeFrames 应保持帧内容一致", async () => {
    const frames = [
      Buffer.from("a"),
      Buffer.from(""),
      Buffer.from("xyz"),
      Buffer.from([0, 1, 2, 3]),
    ];

    const packed = encodeFrames(frames);
    const restored = decodeFrames(packed);

    runner.assert(
      restored.length === frames.length,
      `帧数量一致 → ${restored.length}`,
    );

    restored.forEach((buf, i) => {
      runner.assert(
        Buffer.compare(buf, frames[i]) === 0,
        `第 ${i} 帧一致 → "${buf.toString("hex")}"`,
      );
    });
  });

  await runner.test("digestFrames 应与 encodeFrames 哈希结果一致", async () => {
    const frames = [
      Buffer.from("hello"),
      Buffer.from("world"),
      Buffer.from([1, 2, 3, 4, 5]),
    ];

    const expected = createHash("sha256")
      .update(encodeFrames(frames))
      .digest("hex");
    const actual = digestFrames(frames);

    runner.assert(actual === expected, `摘要结果一致 → ${actual}`);
  });

  await runner.test(
    "deriveKeys：自定义 kdfSalt 相同输入应派生相同密钥",
    async () => {
      const a = deriveKeys("unit-test-key-kdf", { salt: "project-salt-v1" });
      const b = deriveKeys("unit-test-key-kdf", { salt: "project-salt-v1" });

      runner.assert(
        a.signKey.equals(b.signKey),
        "相同 authKey + 相同 salt：signKey 应一致",
      );
      runner.assert(
        a.encryptKey.equals(b.encryptKey),
        "相同 authKey + 相同 salt：encryptKey 应一致",
      );
    },
  );

  await runner.test("deriveKeys：不同 kdfSalt 应派生不同密钥", async () => {
    const a = deriveKeys("unit-test-key-kdf", { salt: "project-salt-v1" });
    const b = deriveKeys("unit-test-key-kdf", { salt: "project-salt-v2" });

    runner.assert(
      !a.signKey.equals(b.signKey),
      "相同 authKey + 不同 salt：signKey 应不同",
    );
    runner.assert(
      !a.encryptKey.equals(b.encryptKey),
      "相同 authKey + 不同 salt：encryptKey 应不同",
    );
  });

  await runner.test("verifyTextSignature：合法签名应校验通过", async () => {
    const { signKey } = deriveKeys("unit-test-sign-key");
    const text = "znl-signature-payload";
    const signature = signText(signKey, text);

    runner.assert(
      verifyTextSignature(signKey, text, signature) === true,
      "合法签名应返回 true",
    );
  });

  await runner.test(
    "verifyTextSignature：畸形/非法签名应校验失败",
    async () => {
      const { signKey } = deriveKeys("unit-test-sign-key");
      const text = "znl-signature-payload";
      const validSignature = signText(signKey, text);

      const malformedSignatures = [
        "",
        "zzzz",
        "123",
        `${validSignature}00`,
        validSignature.slice(0, -2),
      ];

      for (const malformed of malformedSignatures) {
        runner.assert(
          verifyTextSignature(signKey, text, malformed) === false,
          `非法签名应返回 false → "${malformed}"`,
        );
      }
    },
  );

  await runner.test("encryptFrames/decryptFrames 应可还原帧数组", async () => {
    const { encryptKey } = deriveKeys("unit-test-key-2");
    const frames = [Buffer.from("f1"), Buffer.from("f2")];
    const aad = Buffer.from("aad-frames");

    const { iv, ciphertext, tag } = encryptFrames(encryptKey, frames, aad);
    const restored = decryptFrames(encryptKey, iv, ciphertext, tag, aad);

    runner.assert(
      restored.length === frames.length,
      `帧数量一致 → ${restored.length}`,
    );
    restored.forEach((buf, i) => {
      runner.assert(
        buf.toString() === frames[i].toString(),
        `第 ${i} 帧一致 → "${buf.toString()}"`,
      );
    });
  });

  await runner.test("ReplayGuard 与时间戳校验行为正确", async () => {
    const guard = new ReplayGuard({ windowMs: 10_000 });
    const nonce = generateNonce();
    const now = Date.now();

    runner.assert(guard.seenOrAdd(nonce) === false, "首次 nonce 不应视为重放");
    runner.assert(guard.seenOrAdd(nonce) === true, "重复 nonce 应视为重放");
    runner.assert(isTimestampFresh(now, 1000, now) === true, "当前时间戳有效");
    runner.assert(
      isTimestampFresh(now - 5000, 1000, now) === false,
      "过旧时间戳无效",
    );
    runner.assert(
      isTimestampFresh(now + 5000, 1000, now) === false,
      "过新时间戳无效",
    );
  });

  await runner.test(
    "错误 authKey（encrypted=true）→ master 丢弃请求并触发 auth_failed 事件",
    async () => {
      const EP_AUTH = takeEndpoint();

      const master = new ZNL({
        role: "master",
        id: "m-auth",
        endpoints: { router: EP_AUTH },
        authKey: "right-key",
        encrypted: true,
      });

      const badSlave = new ZNL({
        role: "slave",
        id: "bad-slave",
        endpoints: { router: EP_AUTH },
        authKey: "wrong-key",
        encrypted: true,
      });

      let authFailedFired = false;
      master.once("auth_failed", () => {
        authFailedFired = true;
      });

      await master.start();
      await badSlave.start();
      await delay(100);

      try {
        await badSlave.DEALER("forbidden", { timeoutMs: 800 });
        runner.fail("不应收到响应");
      } catch (error) {
        runner.assert(
          String(error?.message ?? error).includes("请求超时"),
          `请求正确超时 → "${error?.message ?? error}"`,
        );
        runner.assert(authFailedFired, "auth_failed 事件已触发");
      } finally {
        await safeStop(badSlave, master);
      }
    },
  );

  await runner.test(
    "错误 master key（encrypted=true）→ slave 触发 auth_failed",
    async () => {
      const EP_AUTH2 = takeEndpoint();

      const wrongMaster = new ZNL({
        role: "master",
        id: "m-wrong",
        endpoints: { router: EP_AUTH2 },
        authKey: "wrong-master-key",
        encrypted: true,
      });

      const rightSlave = new ZNL({
        role: "slave",
        id: "s-right",
        endpoints: { router: EP_AUTH2 },
        authKey: "right-slave-key",
        encrypted: true,
      });

      let slaveAuthFailed = false;
      rightSlave.on("auth_failed", () => {
        slaveAuthFailed = true;
      });

      await wrongMaster.start();
      await rightSlave.start();
      await delay(150);

      try {
        await wrongMaster.ROUTER("s-right", "ping", { timeoutMs: 800 });
        runner.fail("错误 master key 不应收到响应");
      } catch (error) {
        runner.assert(
          String(error?.message ?? error).includes("请求超时"),
          `请求正确超时 → "${error?.message ?? error}"`,
        );
        runner.assert(slaveAuthFailed, "slave 侧 auth_failed 事件已触发");
      } finally {
        await safeStop(rightSlave, wrongMaster);
      }
    },
  );

  await runner.test(
    "encrypted 模式：kdfSalt 不一致时认证失败并触发 auth_failed",
    async () => {
      const EP_KDF_FAIL = takeEndpoint();

      const master = new ZNL({
        role: "master",
        id: "m-kdf-fail",
        endpoints: { router: EP_KDF_FAIL },
        authKey: "same-auth-key",
        kdfSalt: "salt-a",
        encrypted: true,
      });

      const slave = new ZNL({
        role: "slave",
        id: "s-kdf-fail",
        endpoints: { router: EP_KDF_FAIL },
        authKey: "same-auth-key",
        kdfSalt: "salt-b",
        encrypted: true,
      });

      let masterAuthFailed = false;
      master.on("auth_failed", () => {
        masterAuthFailed = true;
      });

      await master.start();
      await slave.start();
      await delay(180);

      try {
        await slave.DEALER("hello-kdf-fail", { timeoutMs: 800 });
        runner.fail("kdfSalt 不一致不应收到响应");
      } catch (error) {
        runner.assert(
          String(error?.message ?? error).includes("请求超时"),
          `请求正确超时 → "${error?.message ?? error}"`,
        );
        runner.assert(masterAuthFailed, "master 侧 auth_failed 事件已触发");
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test("encrypted 模式：kdfSalt 一致时通信正常", async () => {
    const EP_KDF_OK = takeEndpoint();

    const master = new ZNL({
      role: "master",
      id: "m-kdf-ok",
      endpoints: { router: EP_KDF_OK },
      authKey: "same-auth-key",
      kdfSalt: "project-salt-v1",
      encrypted: true,
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-kdf-ok",
      endpoints: { router: EP_KDF_OK },
      authKey: "same-auth-key",
      kdfSalt: "project-salt-v1",
      encrypted: true,
    });

    master.ROUTER(async ({ payload }) => `KDF-OK:${toText(payload)}`);

    await master.start();
    await slave.start();
    await waitForRegistered(master, "s-kdf-ok", 3000);

    try {
      const reply = await slave.DEALER("hello-kdf-ok", { timeoutMs: 3000 });
      runner.assert(
        toText(reply) === "KDF-OK:hello-kdf-ok",
        `kdfSalt 一致通信成功 → "${toText(reply)}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test(
    "encrypted 模式：RPC + PUB/SUB 正常（透明加解密）",
    async () => {
      const EP = takeEndpoint();
      const KEY = "sec-encrypted-key-001";

      const master = new ZNL({
        role: "master",
        id: "m10",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
      });

      const slave = new ZNL({
        role: "slave",
        id: "s10",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
      });

      const pubLog = [];
      slave.SUBSCRIBE("news", ({ payload }) => pubLog.push(toText(payload)));

      master.ROUTER(async ({ payload }) => `ENC-M:${toText(payload)}`);
      slave.DEALER(async ({ payload }) => `ENC-S:${toText(payload)}`);

      await master.start();
      await slave.start();
      await delay(250);

      try {
        const r1 = await slave.DEALER("hello-encrypted", { timeoutMs: 3000 });
        runner.assert(
          toText(r1) === "ENC-M:hello-encrypted",
          `encrypted slave→master 正常 → "${toText(r1)}"`,
        );

        const r2 = await master.ROUTER("s10", "ping-encrypted", {
          timeoutMs: 3000,
        });
        runner.assert(
          toText(r2) === "ENC-S:ping-encrypted",
          `encrypted master→slave 正常 → "${toText(r2)}"`,
        );

        master.PUBLISH("news", "encrypted-news-1");
        await delay(120);

        runner.assert(
          pubLog.length === 1,
          `encrypted 广播收到 1 条 → ${pubLog.length}`,
        );
        runner.assert(
          pubLog[0] === "encrypted-news-1",
          `encrypted 广播内容匹配 → "${pubLog[0]}"`,
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test("encrypted 模式：PUSH 正常（透明加解密）", async () => {
    const EP = takeEndpoint();
    const KEY = "sec-encrypted-push";

    const master = new ZNL({
      role: "master",
      id: "m-push-enc",
      endpoints: { router: EP },
      authKey: KEY,
      encrypted: true,
    });

    const slave = new ZNL({
      role: "slave",
      id: "s-push-enc",
      endpoints: { router: EP },
      authKey: KEY,
      encrypted: true,
    });

    const received = [];
    master.on("push", ({ identityText, topic, payload }) => {
      received.push({ identityText, topic, text: toText(payload) });
    });

    await master.start();
    await slave.start();
    await delay(200);

    try {
      slave.PUSH("metrics", "enc-cpu=0.42");
      await delay(200);

      runner.assert(
        received.length === 1,
        `encrypted push 收到 1 条 → ${received.length}`,
      );
      runner.assert(
        received[0]?.identityText === "s-push-enc",
        `identity 匹配 → "${received[0]?.identityText}"`,
      );
      runner.assert(
        received[0]?.topic === "metrics",
        `topic 匹配 → "${received[0]?.topic}"`,
      );
      runner.assert(
        received[0]?.text === "enc-cpu=0.42",
        `payload 匹配 → "${received[0]?.text}"`,
      );
    } finally {
      await safeStop(slave, master);
    }
  });

  await runner.test(
    "encrypted 模式：payloadDigest 配置不一致（PUBLISH）触发 auth_failed",
    async () => {
      const EP = takeEndpoint();
      const KEY = "sec-encrypted-pub-digest";

      const master = new ZNL({
        role: "master",
        id: "m-pd",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
        enablePayloadDigest: false,
      });

      const slave = new ZNL({
        role: "slave",
        id: "s-pd",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
        enablePayloadDigest: true,
      });

      let authFailed = false;
      let received = false;

      slave.on("auth_failed", () => {
        authFailed = true;
      });

      slave.SUBSCRIBE("news", () => {
        received = true;
      });

      await master.start();
      await slave.start();
      await delay(200);

      try {
        master.PUBLISH("news", "digest-mismatch");
        await delay(200);

        runner.assert(authFailed, "slave 侧 auth_failed 已触发");
        runner.assert(!received, "认证失败不应收到 PUBLISH");
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test(
    "encrypted 模式：关闭 payloadDigest 后仍可通信",
    async () => {
      const EP = takeEndpoint();
      const KEY = "sec-encrypted-digest-off";

      const master = new ZNL({
        role: "master",
        id: "m-pd0",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
        enablePayloadDigest: false,
      });

      const slave = new ZNL({
        role: "slave",
        id: "s-pd0",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
        enablePayloadDigest: false,
      });

      master.ROUTER(async ({ payload }) => `MPD0:${toText(payload)}`);

      await master.start();
      await slave.start();
      await delay(150);

      try {
        const response = await slave.DEALER("no-digest", { timeoutMs: 2000 });
        runner.assert(
          toText(response) === "MPD0:no-digest",
          `关闭摘要仍可通信 → "${toText(response)}"`,
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test(
    "encrypted 模式：payloadDigest 配置不一致（RPC）可能导致认证失败",
    async () => {
      const EP = takeEndpoint();
      const KEY = "sec-encrypted-digest-rpc";

      const master = new ZNL({
        role: "master",
        id: "m-pr",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
        enablePayloadDigest: true,
      });

      const slave = new ZNL({
        role: "slave",
        id: "s-pr",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
        enablePayloadDigest: false,
      });

      let authFailedFired = false;
      master.on("auth_failed", () => {
        authFailedFired = true;
      });

      master.ROUTER(async ({ payload }) => `MPR:${toText(payload)}`);

      await master.start();
      await slave.start();
      await delay(150);

      try {
        await slave.DEALER("digest-mismatch", { timeoutMs: 800 });
        runner.fail("配置不一致不应收到响应");
      } catch (error) {
        runner.assert(
          String(error?.message ?? error).includes("请求超时"),
          `请求正确超时 → "${error?.message ?? error}"`,
        );
        runner.assert(authFailedFired, "master 侧 auth_failed 事件已触发");
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test(
    "encrypted 模式：防重放（同 nonce+requestId）触发拒绝",
    async () => {
      const EP = takeEndpoint();
      const KEY = "sec-replay-key";
      const NODE = "replay-slave";

      const master = new ZNL({
        role: "master",
        id: "m-replay",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
      });

      let requestCount = 0;
      let authFailed = 0;

      master.on("request", () => {
        requestCount++;
      });

      master.on("auth_failed", () => {
        authFailed++;
      });

      master.ROUTER(async () => "ok");

      await master.start();

      const dealer = new zmq.Dealer({ routingId: NODE });
      dealer.connect(EP);
      await delay(100);

      try {
        const requestId = "replay-req-001";
        const nonce = "fixed-nonce-001";
        const timestamp = Date.now();

        const { frames } = buildEncryptedRequestFrames({
          authKey: KEY,
          nodeId: NODE,
          requestId,
          payload: "hello",
          nonce,
          timestamp,
        });

        await dealer.send(frames);
        await delay(150);

        await dealer.send(frames);
        await delay(200);

        runner.assert(requestCount === 1, `仅接受一次请求 → ${requestCount}`);
        runner.assert(authFailed >= 1, `重放触发 auth_failed → ${authFailed}`);
      } finally {
        dealer.close();
        await safeStop(master);
      }
    },
  );

  await runner.test(
    "encrypted 模式：同 nonce 不同 requestId 不应触发重放",
    async () => {
      const EP = takeEndpoint();
      const KEY = "sec-replay-key-2";
      const NODE = "replay-slave-2";

      const master = new ZNL({
        role: "master",
        id: "m-replay-2",
        endpoints: { router: EP },
        authKey: KEY,
        encrypted: true,
      });

      let requestCount = 0;
      let authFailed = 0;

      master.on("request", () => {
        requestCount++;
      });

      master.on("auth_failed", () => {
        authFailed++;
      });

      master.ROUTER(async () => "ok");

      await master.start();

      const dealer = new zmq.Dealer({ routingId: NODE });
      dealer.connect(EP);
      await delay(100);

      try {
        const nonce = "fixed-nonce-002";
        const timestamp = Date.now();

        const { frames: frames1 } = buildEncryptedRequestFrames({
          authKey: KEY,
          nodeId: NODE,
          requestId: "replay-req-a",
          payload: "hello-a",
          nonce,
          timestamp,
        });

        const { frames: frames2 } = buildEncryptedRequestFrames({
          authKey: KEY,
          nodeId: NODE,
          requestId: "replay-req-b",
          payload: "hello-b",
          nonce,
          timestamp,
        });

        await dealer.send(frames1);
        await delay(120);
        await dealer.send(frames2);
        await delay(200);

        runner.assert(requestCount === 2, `两次请求均应接受 → ${requestCount}`);
        runner.assert(authFailed === 0, `不应触发 auth_failed → ${authFailed}`);
      } finally {
        dealer.close();
        await safeStop(master);
      }
    },
  );

  await runner.test("encrypted 模式：时间漂移超限被拒绝", async () => {
    const EP = takeEndpoint();
    const KEY = "sec-time-skew";
    const NODE = "time-skew-slave";

    const master = new ZNL({
      role: "master",
      id: "m-time",
      endpoints: { router: EP },
      authKey: KEY,
      encrypted: true,
      maxTimeSkewMs: 50,
    });

    let authFailed = false;

    master.on("auth_failed", () => {
      authFailed = true;
    });

    master.ROUTER(async () => "ok");

    await master.start();

    const dealer = new zmq.Dealer({ routingId: NODE });
    dealer.connect(EP);
    await delay(80);

    try {
      const { frames } = buildEncryptedRequestFrames({
        authKey: KEY,
        nodeId: NODE,
        requestId: "time-req-001",
        payload: "hello",
        nonce: "time-nonce-001",
        timestamp: Date.now() - 10_000,
      });

      await dealer.send(frames);
      await delay(200);

      runner.assert(authFailed, "过期时间戳触发 auth_failed");
    } finally {
      dealer.close();
      await safeStop(master);
    }
  });

  await runner.test("authKeyMap 优先级：命中 map 时不回退", async () => {
    const EP = takeEndpoint();

    const master = new ZNL({
      role: "master",
      id: "m-pri",
      endpoints: { router: EP },
      authKey: "fallback-key",
      authKeyMap: { sPri: "map-key" },
      encrypted: true,
    });

    let authFailed = false;
    master.on("auth_failed", () => {
      authFailed = true;
    });

    const wrongSlave = new ZNL({
      role: "slave",
      id: "sPri",
      endpoints: { router: EP },
      authKey: "fallback-key",
      encrypted: true,
    });

    master.ROUTER(async ({ payload }) => `MP:${toText(payload)}`);

    await master.start();
    await wrongSlave.start();
    await delay(150);

    try {
      await wrongSlave.DEALER("should-fail", { timeoutMs: 600 });
      runner.fail("map 命中时不应回退到 authKey");
    } catch (error) {
      runner.assert(
        String(error?.message ?? error).includes("请求超时"),
        `请求正确超时 → "${error?.message ?? error}"`,
      );
      runner.assert(authFailed, "auth_failed 已触发");
    }

    await safeStop(wrongSlave);
    await delay(200);

    const rightSlave = new ZNL({
      role: "slave",
      id: "sPri",
      endpoints: { router: EP },
      authKey: "map-key",
      encrypted: true,
    });

    await rightSlave.start();
    await delay(150);

    try {
      let ok = false;
      let lastError = null;

      for (let i = 0; i < 5; i++) {
        try {
          const response = await rightSlave.DEALER("ok", { timeoutMs: 1500 });
          runner.assert(
            toText(response) === "MP:ok",
            `map key 正常 → "${toText(response)}"`,
          );
          ok = true;
          break;
        } catch (error) {
          lastError = error;
          await delay(200);
        }
      }

      if (!ok) {
        runner.fail(
          `重连后仍未通信成功 → "${lastError?.message ?? lastError}"`,
        );
      }
    } finally {
      await safeStop(rightSlave, master);
    }
  });

  await runner.test("authKeyMap 更新后在线 key 立即切换", async () => {
    const EP = takeEndpoint();

    const master = new ZNL({
      role: "master",
      id: "m-sw",
      endpoints: { router: EP },
      authKeyMap: { sSw: "k1" },
      encrypted: true,
    });

    const slave1 = new ZNL({
      role: "slave",
      id: "sSw",
      endpoints: { router: EP },
      authKey: "k1",
      encrypted: true,
    });

    master.ROUTER(async ({ payload }) => `MS:${toText(payload)}`);

    await master.start();
    await slave1.start();
    await delay(150);

    try {
      const registeredBefore = await waitForRegistered(master, "sSw", {
        timeoutMs: 3000,
        intervalMs: 100,
      });
      runner.assert(registeredBefore, `切换前已注册 → ${master.slaves}`);

      const r1 = await slave1.DEALER("before-switch", { timeoutMs: 1500 });
      runner.assert(toText(r1) === "MS:before-switch", "切换前通信正常");

      master.addAuthKey("sSw", "k2");
      await delay(200);

      let failed = false;
      try {
        await slave1.DEALER("after-switch", { timeoutMs: 600 });
      } catch (error) {
        failed = String(error?.message ?? error).includes("请求超时");
      }
      runner.assert(failed, "切换后旧 key 失效");

      await safeStop(slave1);
      await delay(500);

      const slave2 = new ZNL({
        role: "slave",
        id: "sSw",
        endpoints: { router: EP },
        authKey: "k2",
        encrypted: true,
      });

      await slave2.start();
      await delay(250);

      try {
        let registered = false;
        let reply = null;
        let replyError = null;

        for (let i = 0; i < 8; i++) {
          registered =
            registered ||
            (await waitForRegistered(master, "sSw", {
              timeoutMs: 800,
              intervalMs: 100,
            }));
          try {
            reply = await slave2.DEALER("after-reconnect", {
              timeoutMs: 1200,
            });
            replyError = null;
            break;
          } catch (error) {
            replyError = error;
            await delay(250);
          }
        }

        runner.assert(registered, `重连后注册成功 → ${master.slaves}`);
        runner.assert(
          reply && toText(reply) === "MS:after-reconnect",
          reply
            ? "切换后新 key 生效"
            : `切换后新 key 生效 → ${replyError?.message ?? replyError}`,
        );
      } finally {
        await safeStop(slave2);
      }
    } finally {
      await safeStop(master);
    }
  });

  await runner.test(
    "encrypted 模式：authKeyMap 未命中时回退到 authKey",
    async () => {
      const EP = takeEndpoint();

      const master = new ZNL({
        role: "master",
        id: "m16",
        endpoints: { router: EP },
        authKey: "fallback-key",
        authKeyMap: { s16a: "k16a" },
        encrypted: true,
      });

      const slave = new ZNL({
        role: "slave",
        id: "s16b",
        endpoints: { router: EP },
        authKey: "fallback-key",
        encrypted: true,
      });

      master.ROUTER(async ({ payload }) => `M16:${toText(payload)}`);

      await master.start();
      await slave.start();
      await delay(150);

      try {
        const response = await slave.DEALER("should-pass", {
          timeoutMs: 1500,
        });
        runner.assert(
          toText(response) === "M16:should-pass",
          `回退到 authKey 生效 → "${toText(response)}"`,
        );
      } finally {
        await safeStop(slave, master);
      }
    },
  );

  await runner.test(
    "encrypted 模式：authKeyMap 动态 add/remove 立即生效",
    async () => {
      const EP = takeEndpoint();

      const master = new ZNL({
        role: "master",
        id: "m17",
        endpoints: { router: EP },
        authKeyMap: {},
        encrypted: true,
      });

      const slave = new ZNL({
        role: "slave",
        id: "s17",
        endpoints: { router: EP },
        authKey: "k17",
        encrypted: true,
      });

      let authFailedFired = false;
      let disconnected = false;

      master.on("auth_failed", () => {
        authFailedFired = true;
      });

      master.on("slave_disconnected", (id) => {
        if (id === "s17") disconnected = true;
      });

      master.ROUTER(async ({ payload }) => `M17:${toText(payload)}`);

      await master.start();
      await slave.start();
      await delay(150);

      try {
        try {
          await slave.DEALER("before-add", { timeoutMs: 500 });
          runner.fail("未 addAuthKey 前不应收到响应");
        } catch (error) {
          runner.assert(
            String(error?.message ?? error).includes("请求超时"),
            `请求正确超时 → "${error?.message ?? error}"`,
          );
          runner.assert(authFailedFired, "master 侧 auth_failed 事件已触发");
        }

        master.addAuthKey("s17", "k17");
        await delay(100);

        const r1 = await slave.DEALER("after-add", { timeoutMs: 1500 });
        runner.assert(
          toText(r1) === "M17:after-add",
          `addAuthKey 生效 → "${toText(r1)}"`,
        );

        master.removeAuthKey("s17");
        await delay(100);
        runner.assert(disconnected, "removeAuthKey 触发 slave_disconnected");

        try {
          await slave.DEALER("after-remove", { timeoutMs: 500 });
          runner.fail("removeAuthKey 后不应收到响应");
        } catch (error) {
          runner.assert(
            String(error?.message ?? error).includes("请求超时"),
            `请求正确超时 → "${error?.message ?? error}"`,
          );
        }
      } finally {
        await safeStop(slave, master);
      }
    },
  );
}
