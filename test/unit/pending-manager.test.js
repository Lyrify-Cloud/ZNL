import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingManager } from "../../src/PendingManager.js";

/**
 * PendingManager 单元测试
 * 说明：使用 node:test，不依赖 ZMQ 环境
 */

test("ensureCapacity 在未超限时不抛错", () => {
  const pm = new PendingManager(2);
  pm.ensureCapacity(); // 初始为空
  pm.create("k1", 10, "r1"); // 不启动计时器，避免测试结束后超时
  pm.ensureCapacity(); // 1 个 pending
});

test("ensureCapacity 在超限时抛错", () => {
  const pm = new PendingManager(1);
  pm.create("k1", 10, "r1");
  assert.throws(() => pm.ensureCapacity(), /并发请求数已达上限/);
});

test("create + resolve 能正确完成并清理", async () => {
  const pm = new PendingManager(10);
  const { promise, startTimer } = pm.create("k1", 50, "r1");
  startTimer();
  const ok = pm.resolve("k1", "done");
  assert.equal(ok, true);
  const result = await promise;
  assert.equal(result, "done");
  assert.equal(pm.size, 0);
});

test("create + reject 能正确完成并清理", async () => {
  const pm = new PendingManager(10);
  const { promise, startTimer } = pm.create("k1", 50, "r1");
  startTimer();
  const ok = pm.reject("k1", new Error("fail"));
  assert.equal(ok, true);

  await assert.rejects(promise, /fail/);
  assert.equal(pm.size, 0);
});

test("超时会自动 reject 并清理", async () => {
  const pm = new PendingManager(10);
  const { promise, startTimer } = pm.create("k1", 30, "r1");
  startTimer();

  await assert.rejects(promise, /请求超时/);
  assert.equal(pm.size, 0);
});

test("rejectAll 会批量取消所有 pending", async () => {
  const pm = new PendingManager(10);

  const p1 = pm.create("k1", 1000, "r1");
  const p2 = pm.create("k2", 1000, "r2");
  p1.startTimer();
  p2.startTimer();

  pm.rejectAll(new Error("stop"));

  await assert.rejects(p1.promise, /stop/);
  await assert.rejects(p2.promise, /stop/);
  assert.equal(pm.size, 0);
});

test("key 生成规则：identityText 会参与拼接", () => {
  const pm = new PendingManager(10);
  const key1 = pm.key("rid");
  const key2 = pm.key("rid", "slave-1");
  assert.equal(key1, "rid");
  assert.equal(key2, "slave-1::rid");
});
