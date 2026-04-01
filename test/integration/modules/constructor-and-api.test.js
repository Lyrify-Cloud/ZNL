import { ZNL } from "../../../index.js";
import { PendingManager } from "../../../src/PendingManager.js";
import { installTimeoutScaling } from "../helpers/common.js";

installTimeoutScaling();

export async function runConstructorAndApiTests(runner) {
  runner.section("构造参数校验 & API 角色限制");

  await runner.test("role 非法应抛错", async () => {
    let threw = false;

    try {
      new ZNL({ role: "bad-role", id: "x" });
    } catch (error) {
      threw = true;
      runner.assert(
        String(error?.message ?? error).includes("role"),
        `错误信息包含 role → "${error?.message ?? error}"`,
      );
    }

    if (!threw) {
      runner.fail("未抛错（role 非法）");
    }
  });

  await runner.test("id 缺失应抛错", async () => {
    let threw = false;

    try {
      new ZNL({ role: "master" });
    } catch (error) {
      threw = true;
      runner.assert(
        String(error?.message ?? error).includes("id"),
        `错误信息包含 id → "${error?.message ?? error}"`,
      );
    }

    if (!threw) {
      runner.fail("未抛错（id 缺失）");
    }
  });

  await runner.test(
    "encrypted=true 但未提供 authKey/authKeyMap 应抛错",
    async () => {
      let threw = false;

      try {
        new ZNL({ role: "master", id: "m-enc", encrypted: true });
      } catch (error) {
        threw = true;
        const message = String(error?.message ?? error);
        runner.assert(
          message.includes("authKey") || message.includes("authKeyMap"),
          `错误信息包含 authKey/authKeyMap → "${message}"`,
        );
      }

      if (!threw) {
        runner.fail("未抛错（encrypted=true 缺少 authKey/authKeyMap）");
      }
    },
  );

  await runner.test("master 侧传入非法 authKeyMap 类型应抛错", async () => {
    let threw = false;

    try {
      new ZNL({
        role: "master",
        id: "m-bad-auth-map",
        encrypted: true,
        authKeyMap: "bad-auth-map",
      });
    } catch (error) {
      threw = true;
      runner.assert(
        String(error?.message ?? error).includes("authKeyMap"),
        `错误信息包含 authKeyMap → "${error?.message ?? error}"`,
      );
    }

    if (!threw) {
      runner.fail("未抛错（非法 authKeyMap 类型）");
    }
  });

  await runner.test(
    "slave 侧 masterOnline / isMasterOnline 默认值正确",
    async () => {
      const slave = new ZNL({
        role: "slave",
        id: "s-api-default",
        endpoints: { router: "tcp://127.0.0.1:16101" },
      });

      runner.assert(
        slave.masterOnline === false,
        "slave.masterOnline 默认为 false",
      );
      runner.assert(
        slave.isMasterOnline() === false,
        "slave.isMasterOnline() 默认为 false",
      );
    },
  );

  await runner.test(
    "master 侧读取 masterOnline / isMasterOnline 返回 false",
    async () => {
      const master = new ZNL({
        role: "master",
        id: "m-api-default",
        endpoints: { router: "tcp://127.0.0.1:16102" },
      });

      runner.assert(
        master.masterOnline === false,
        "master.masterOnline 固定为 false",
      );
      runner.assert(
        master.isMasterOnline() === false,
        "master.isMasterOnline() 固定为 false",
      );
    },
  );

  await runner.test("PUBLISH() 只能在 master 侧调用", async () => {
    const slave = new ZNL({
      role: "slave",
      id: "s-role-publish",
      endpoints: { router: "tcp://127.0.0.1:16103" },
    });

    let error = null;

    try {
      slave.PUBLISH("news", "hello");
    } catch (thrown) {
      error = thrown;
    }

    runner.assert(
      String(error?.message ?? error).includes("master"),
      `错误信息包含 master → "${error?.message ?? error}"`,
    );
  });

  await runner.test("SUBSCRIBE() 只能在 slave 侧调用", async () => {
    const master = new ZNL({
      role: "master",
      id: "m-role-subscribe",
      endpoints: { router: "tcp://127.0.0.1:16104" },
    });

    let error = null;

    try {
      master.SUBSCRIBE("news", () => {});
    } catch (thrown) {
      error = thrown;
    }

    runner.assert(
      String(error?.message ?? error).includes("slave"),
      `错误信息包含 slave → "${error?.message ?? error}"`,
    );
  });

  await runner.test("UNSUBSCRIBE() 只能在 slave 侧调用", async () => {
    const master = new ZNL({
      role: "master",
      id: "m-role-unsubscribe",
      endpoints: { router: "tcp://127.0.0.1:16105" },
    });

    let error = null;

    try {
      master.UNSUBSCRIBE("news");
    } catch (thrown) {
      error = thrown;
    }

    runner.assert(
      String(error?.message ?? error).includes("slave"),
      `错误信息包含 slave → "${error?.message ?? error}"`,
    );
  });

  await runner.test("PUSH() 只能在 slave 侧调用", async () => {
    const master = new ZNL({
      role: "master",
      id: "m-role-push",
      endpoints: { router: "tcp://127.0.0.1:16106" },
    });

    let error = null;

    try {
      master.PUSH("metrics", "cpu=1");
    } catch (thrown) {
      error = thrown;
    }

    runner.assert(
      String(error?.message ?? error).includes("slave"),
      `错误信息包含 slave → "${error?.message ?? error}"`,
    );
  });

  await runner.test("addAuthKey() 只能在 master 侧调用", async () => {
    const slave = new ZNL({
      role: "slave",
      id: "s-role-add-auth",
      endpoints: { router: "tcp://127.0.0.1:16107" },
    });

    let error = null;

    try {
      slave.addAuthKey("s1", "key-1");
    } catch (thrown) {
      error = thrown;
    }

    runner.assert(
      String(error?.message ?? error).includes("master"),
      `错误信息包含 master → "${error?.message ?? error}"`,
    );
  });

  await runner.test("removeAuthKey() 只能在 master 侧调用", async () => {
    const slave = new ZNL({
      role: "slave",
      id: "s-role-remove-auth",
      endpoints: { router: "tcp://127.0.0.1:16108" },
    });

    let error = null;

    try {
      slave.removeAuthKey("s1");
    } catch (thrown) {
      error = thrown;
    }

    runner.assert(
      String(error?.message ?? error).includes("master"),
      `错误信息包含 master → "${error?.message ?? error}"`,
    );
  });

  await runner.test("PendingManager key 含 identity 避免碰撞", async () => {
    const pending = new PendingManager(10);
    const key1 = pending.key("req-1", "s1");
    const key2 = pending.key("req-1", "s2");

    runner.assert(key1 !== key2, `不同 identity key 不同 → ${key1} vs ${key2}`);
  });
}
