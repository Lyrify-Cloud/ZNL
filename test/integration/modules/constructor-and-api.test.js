import { ZNL } from "../../../index.js";
import { PendingManager } from "../../../src/PendingManager.js";
import { installTimeoutScaling } from "../helpers/common.js";
import { expectRejected } from "../helpers/assertions.js";
import { createPortAllocator } from "../helpers/ports.js";

installTimeoutScaling();

const ports = createPortAllocator({ offset: 101 });
const takeEndpoint = () => ports.nextEndpoint();

function assertRejectedWith(runner, result, expectedText, title) {
  runner.assert(result.rejected, `${title}：应抛错`);
  runner.assert(
    result.matched,
    `${title}：错误信息包含 "${expectedText}" → "${result.message}"`,
  );
}

export async function runConstructorAndApiTests(runner) {
  runner.section("构造参数校验 & API 角色限制");

  await runner.test("role 非法应抛错", async () => {
    const result = await expectRejected(
      () => new ZNL({ role: "bad-role", id: "x" }),
      ["role"],
    );
    assertRejectedWith(runner, result, "role", "role 非法");
  });

  await runner.test("id 缺失应抛错", async () => {
    const result = await expectRejected(
      () => new ZNL({ role: "master" }),
      ["id"],
    );
    assertRejectedWith(runner, result, "id", "id 缺失");
  });

  await runner.test(
    "encrypted=true 但未提供 authKey/authKeyMap 应抛错",
    async () => {
      const result = await expectRejected(
        () => new ZNL({ role: "master", id: "m-enc", encrypted: true }),
        ["authKey", "authKeyMap"],
      );

      runner.assert(result.rejected, "缺少 authKey/authKeyMap 应抛错");
      runner.assert(
        result.matched,
        `错误信息包含 authKey/authKeyMap → "${result.message}"`,
      );
    },
  );

  await runner.test("master 侧传入非法 authKeyMap 类型应抛错", async () => {
    const result = await expectRejected(
      () =>
        new ZNL({
          role: "master",
          id: "m-bad-auth-map",
          encrypted: true,
          authKeyMap: "bad-auth-map",
        }),
      ["authKeyMap"],
    );

    assertRejectedWith(runner, result, "authKeyMap", "非法 authKeyMap 类型");
  });

  await runner.test(
    "slave 侧 masterOnline / isMasterOnline 默认值正确",
    async () => {
      const slave = new ZNL({
        role: "slave",
        id: "s-api-default",
        endpoints: { router: takeEndpoint() },
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
        endpoints: { router: takeEndpoint() },
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
      endpoints: { router: takeEndpoint() },
    });

    const result = await expectRejected(
      () => slave.PUBLISH("news", "hello"),
      ["master"],
    );

    assertRejectedWith(runner, result, "master", "PUBLISH 角色限制");
  });

  await runner.test("SUBSCRIBE() 只能在 slave 侧调用", async () => {
    const master = new ZNL({
      role: "master",
      id: "m-role-subscribe",
      endpoints: { router: takeEndpoint() },
    });

    const result = await expectRejected(
      () => master.SUBSCRIBE("news", () => {}),
      ["slave"],
    );

    assertRejectedWith(runner, result, "slave", "SUBSCRIBE 角色限制");
  });

  await runner.test("UNSUBSCRIBE() 只能在 slave 侧调用", async () => {
    const master = new ZNL({
      role: "master",
      id: "m-role-unsubscribe",
      endpoints: { router: takeEndpoint() },
    });

    const result = await expectRejected(
      () => master.UNSUBSCRIBE("news"),
      ["slave"],
    );

    assertRejectedWith(runner, result, "slave", "UNSUBSCRIBE 角色限制");
  });

  await runner.test("PUSH() 只能在 slave 侧调用", async () => {
    const master = new ZNL({
      role: "master",
      id: "m-role-push",
      endpoints: { router: takeEndpoint() },
    });

    const result = await expectRejected(
      () => master.PUSH("metrics", "cpu=1"),
      ["slave"],
    );

    assertRejectedWith(runner, result, "slave", "PUSH 角色限制");
  });

  await runner.test("addAuthKey() 只能在 master 侧调用", async () => {
    const slave = new ZNL({
      role: "slave",
      id: "s-role-add-auth",
      endpoints: { router: takeEndpoint() },
    });

    const result = await expectRejected(
      () => slave.addAuthKey("s1", "key-1"),
      ["master"],
    );

    assertRejectedWith(runner, result, "master", "addAuthKey 角色限制");
  });

  await runner.test("removeAuthKey() 只能在 master 侧调用", async () => {
    const slave = new ZNL({
      role: "slave",
      id: "s-role-remove-auth",
      endpoints: { router: takeEndpoint() },
    });

    const result = await expectRejected(
      () => slave.removeAuthKey("s1"),
      ["master"],
    );

    assertRejectedWith(runner, result, "master", "removeAuthKey 角色限制");
  });

  await runner.test("PendingManager key 含 identity 避免碰撞", async () => {
    const pending = new PendingManager(10);
    const key1 = pending.key("req-1", "s1");
    const key2 = pending.key("req-1", "s2");

    runner.assert(key1 !== key2, `不同 identity key 不同 → ${key1} vs ${key2}`);
  });
}
