import { test } from "node:test";
import assert from "node:assert/strict";
import { SendQueue } from "../../src/SendQueue.js";

/**
 * 说明：SendQueue 是串行队列，确保同一通道任务按入队顺序执行
 */

test("SendQueue 同一通道按顺序执行", async () => {
  const queue = new SendQueue();
  const results = [];

  // 模拟异步任务：用延迟打乱完成时间，但仍应按入队顺序执行
  const task = (label, delayMs) => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    results.push(label);
  };

  const p1 = queue.enqueue("router", task("A", 30));
  const p2 = queue.enqueue("router", task("B", 10));
  const p3 = queue.enqueue("router", task("C", 0));

  await Promise.all([p1, p2, p3]);

  assert.deepEqual(results, ["A", "B", "C"]);
});

test("SendQueue 不同通道可并行，但各自保持顺序", async () => {
  const queue = new SendQueue();
  const results = [];

  const task = (label, delayMs) => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    results.push(label);
  };

  const p1 = queue.enqueue("router", task("R1", 20));
  const p2 = queue.enqueue("router", task("R2", 0));
  const p3 = queue.enqueue("dealer", task("D1", 10));
  const p4 = queue.enqueue("dealer", task("D2", 0));

  await Promise.all([p1, p2, p3, p4]);

  // router 与 dealer 各自保持顺序
  const router = results.filter((x) => x.startsWith("R"));
  const dealer = results.filter((x) => x.startsWith("D"));

  assert.deepEqual(router, ["R1", "R2"]);
  assert.deepEqual(dealer, ["D1", "D2"]);
});
