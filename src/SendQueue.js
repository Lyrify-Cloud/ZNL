/**
 * 串行发送队列管理器
 *
 * 问题背景：
 * ZMQ socket 不支持并发写入——同时调用 socket.send() 会导致帧交叉。
 * 虽然 zeromq.js v6 在 JS 层做了一定保护，但显式串行化更安全可靠。
 *
 * 实现原理：
 * 为每个 socket 通道维护一个任务队列与独立消费循环。
 * 通过单线程 async loop 串行执行，避免长 Promise 链增长。
 */
export class SendQueue {
  /**
   * 通道级队列与运行状态
   * @type {Map<string, { queue: Array<{ task: Function, resolve: Function, reject: Function }>, running: boolean }>}
   */
  #channels = new Map();

  /**
   * 将发送任务追加到指定通道的队列尾部
   *
   * @param {string} channel - 通道标识（如 "dealer" | "router"）
   * @param {() => Promise<void>} task - 实际发送操作
   * @returns {Promise<void>} 本次任务的 Promise（可用于错误捕获）
   */
  enqueue(channel, task) {
    const name = String(channel);
    const entry = this.#ensureChannel(name);

    return new Promise((resolve, reject) => {
      entry.queue.push({ task, resolve, reject });
      if (!entry.running) this.#drain(name, entry);
    });
  }

  /**
   * 清空所有通道的队列引用（节点停止时调用）
   * 注意：已入队但未执行的任务不会被取消，仅释放引用
   */
  clear() {
    this.#channels.clear();
  }

  /**
   * 确保通道数据结构存在
   * @param {string} name
   * @returns {{ queue: Array, running: boolean }}
   */
  #ensureChannel(name) {
    let entry = this.#channels.get(name);
    if (!entry) {
      entry = { queue: [], running: false };
      this.#channels.set(name, entry);
    }
    return entry;
  }

  /**
   * 串行消费队列
   * @param {string} name
   * @param {{ queue: Array, running: boolean }} entry
   */
  async #drain(name, entry) {
    entry.running = true;

    while (entry.queue.length > 0) {
      const { task, resolve, reject } = entry.queue.shift();
      try {
        await task();
        resolve();
      } catch (error) {
        reject(error);
      }
    }

    entry.running = false;

    // 清理空通道，避免 Map 无限增长
    if (entry.queue.length === 0) this.#channels.delete(name);
  }
}
