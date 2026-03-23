/**
 * 待处理请求管理器
 *
 * 负责管理所有 in-flight（已发送、等待响应）的请求：
 * - 创建 Promise 并存储 resolve/reject 引用
 * - 超时后自动 reject（定时器在实际发送后才启动，避免队列等待被计入超时）
 * - 最大并发数限制
 * - 批量 reject（节点停止时调用）
 */

import { DEFAULT_TIMEOUT_MS } from "./constants.js";

export class PendingManager {
  /**
   * key → { resolve, reject, timer }
   * @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>|null }>}
   */
  #map = new Map();

  /** 最大并发数（0 = 不限制） */
  #maxPending;

  /**
   * @param {number} maxPending - 0 表示不限制
   */
  constructor(maxPending = 0) {
    this.#maxPending = this.#normalizeMax(maxPending);
  }

  // ─── 公开 API ─────────────────────────────────────────────────────────────

  /**
   * 生成 pending Map 的 key
   *
   * 设计说明：
   * - slave → master 方向：仅用 requestId（唯一）
   * - master → slave 方向：用 "identityText::requestId"
   *   防止多个 slave 使用相同 requestId 时发生 key 碰撞
   *
   * @param {string} requestId
   * @param {string} [identityText]
   * @returns {string}
   */
  key(requestId, identityText = "") {
    return identityText ? `${identityText}::${requestId}` : requestId;
  }

  /**
   * 检查并发容量，超限时抛出错误
   * @throws {Error}
   */
  ensureCapacity() {
    if (this.#maxPending === 0) return; // 0 = 不限制
    if (this.#map.size < this.#maxPending) return;
    throw new Error(
      `并发请求数已达上限：pending=${this.#map.size}, maxPending=${this.#maxPending}`
    );
  }

  /**
   * 创建一个 pending 记录
   *
   * 返回 startTimer 而不是立即启动计时器，原因：
   * 发送任务在队列中等待时不应该占用超时时间，
   * 应在消息真正写入 socket 后才开始计时。
   *
   * @param {string} key
   * @param {number|undefined} timeoutMs
   * @param {string} requestId - 用于错误信息
   * @param {string} [identityText] - 用于错误信息
   * @returns {{ promise: Promise, startTimer: () => void }}
   */
  create(key, timeoutMs, requestId, identityText = "") {
    const ms    = this.#normalizeTimeout(timeoutMs);
    const entry = { resolve: null, reject: null, timer: null };

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject  = reject;
    });

    const startTimer = () => {
      if (entry.timer !== null) return; // 防止重复启动
      entry.timer = setTimeout(() => {
        this.#map.delete(key);
        entry.reject(
          new Error(
            identityText
              ? `请求超时：requestId=${requestId}, identity=${identityText}`
              : `请求超时：requestId=${requestId}`
          )
        );
      }, ms);
    };

    this.#map.set(key, entry);
    return { promise, startTimer };
  }

  /**
   * 以成功结果 resolve 一个 pending 请求
   * @param {string} key
   * @param {*} value
   * @returns {boolean} 是否命中（key 不存在时返回 false）
   */
  resolve(key, value) {
    const entry = this.#map.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#map.delete(key);
    entry.resolve(value);
    return true;
  }

  /**
   * 以错误 reject 一个 pending 请求
   * @param {string} key
   * @param {Error} error
   * @returns {boolean} 是否命中
   */
  reject(key, error) {
    const entry = this.#map.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#map.delete(key);
    entry.reject(error);
    return true;
  }

  /**
   * 批量 reject 所有 pending 请求（节点停止时调用）
   * @param {Error} error
   */
  rejectAll(error) {
    for (const [key, entry] of this.#map) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.#map.delete(key);
    }
  }

  /** 当前待处理请求数 */
  get size() {
    return this.#map.size;
  }

  // ─── 私有辅助 ─────────────────────────────────────────────────────────────

  #normalizeMax(n) {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  #normalizeTimeout(ms) {
    const v = Number(ms);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
  }
}
