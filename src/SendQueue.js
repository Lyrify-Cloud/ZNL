/**
 * 串行发送队列管理器
 *
 * 问题背景：
 * ZMQ socket 不支持并发写入——同时调用 socket.send() 会导致帧交叉。
 * 虽然 zeromq.js v6 在 JS 层做了一定保护，但显式串行化更安全可靠。
 *
 * 实现原理：
 * 为每个 socket 通道维护一条 Promise 链（队列尾指针）。
 * 每次入队时，新任务追加在当前链尾，前一个任务完成后自动触发。
 * 无论前一个任务成功或失败，队列都会继续执行下一个任务。
 */

export class SendQueue {
  /**
   * 各通道的队列尾指针
   * @type {Map<string, Promise<void>>}
   */
  #tails = new Map();

  /**
   * 将发送任务追加到指定通道的队列尾部
   *
   * @param {string} channel - 通道标识（如 "dealer" | "router"）
   * @param {() => Promise<void>} task - 实际发送操作
   * @returns {Promise<void>} 本次任务的 Promise（可用于错误捕获）
   */
  enqueue(channel, task) {
    const tail = this.#tails.get(channel) ?? Promise.resolve();

    // 无论前一个任务成功或失败，都继续执行当前任务
    const run = tail.then(task, task);

    // 更新队尾（吞掉错误，防止产生 UnhandledRejection）
    this.#tails.set(channel, run.catch(() => {}));

    return run;
  }

  /**
   * 清空所有通道的队列引用（节点停止时调用）
   * 注意：已入队但未执行的任务不会被取消，仅释放尾指针引用
   */
  clear() {
    this.#tails.clear();
  }
}
