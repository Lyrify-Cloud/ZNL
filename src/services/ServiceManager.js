import { randomUUID } from "node:crypto";

import { PendingManager } from "../PendingManager.js";
import { identityToBuffer, identityToString } from "../protocol.js";

/**
 * 通用内部服务管理器
 *
 * 职责：
 * - 注册/注销 service handler
 * - 通过独立 pending 池发送 service 请求
 * - 处理 service 响应
 * - 在收到 service 请求时调用对应 handler 并自动回复
 *
 * 说明：
 * - 该模块只处理“服务通道”的收发，不参与业务 RPC 的 request/response
 * - 具体 socket 的获取、发送串行化、加密/签名等由宿主实例负责
 */
export class ServiceManager {
  /** @type {import("../ZNL.js").ZNL} */
  #owner;

  /** @type {PendingManager} */
  #pending;

  /** @type {Map<string, Function>} */
  #handlers = new Map();

  /**
   * @param {{
   *   owner: any,
   *   maxPending?: number,
   * }} options
   */
  constructor({ owner, maxPending = 0 } = {}) {
    if (!owner) {
      throw new Error("ServiceManager 初始化失败：缺少 owner。");
    }

    this.#owner = owner;
    this.#pending = new PendingManager(maxPending);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 注册表
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 注册某个 service 的处理器
   *
   * @param {string} service
   * @param {(event: {
   *   service: string,
   *   identity?: Buffer,
   *   identityText?: string,
   *   requestId: string,
   *   payload: Buffer|Array,
   *   payloadFrames: Buffer[],
   *   meta: any,
   *   body: Array,
   *   channel: "router"|"dealer",
   *   rawEvent?: any,
   * }) => any|Promise<any>} handler
   * @returns {this}
   */
  register(service, handler) {
    const name = String(service ?? "").trim();
    if (!name) {
      throw new Error("service 名称不能为空。");
    }
    if (typeof handler !== "function") {
      throw new TypeError("service handler 必须是函数。");
    }

    this.#handlers.set(name, handler);
    return this;
  }

  /**
   * 注销 service handler
   * @param {string} service
   * @returns {this}
   */
  unregister(service) {
    const name = String(service ?? "").trim();
    if (name) {
      this.#handlers.delete(name);
    }
    return this;
  }

  /**
   * 是否已注册某个 service
   * @param {string} service
   * @returns {boolean}
   */
  has(service) {
    return this.#handlers.has(String(service ?? "").trim());
  }

  /**
   * 获取已注册 service 名称列表
   * @returns {string[]}
   */
  list() {
    return [...this.#handlers.keys()];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 主动请求
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Master → Slave：发送 service 请求
   *
   * @param {string|Buffer|Uint8Array} identity
   * @param {string} service
   * @param {Array<string|Buffer>} payloadFrames
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  async requestTo(identity, service, payloadFrames, { timeoutMs } = {}) {
    const serviceName = String(service ?? "").trim();
    if (!serviceName) {
      throw new Error("service 名称不能为空。");
    }

    const owner = this.#owner;
    if (owner?.role !== "master") {
      throw new Error("requestTo() 只能在 master 侧调用。");
    }

    const socket = owner._serviceRequireSocket?.("router", "ROUTER");
    if (!socket) {
      throw new Error("ROUTER socket 尚未就绪，请先调用 start()。");
    }

    this.#pending.ensureCapacity();

    const identityText = identityToString(identity);
    const idFrame = identityToBuffer(identity);

    const requestId = randomUUID();
    const key = this.#pending.key(requestId, identityText);
    const { promise, startTimer } = this.#pending.create(
      key,
      timeoutMs,
      requestId,
      identityText,
    );

    const frames =
      owner._serviceCreateRequestFrames?.(
        requestId,
        serviceName,
        payloadFrames,
        identityText,
      ) ?? [];

    owner
      ._serviceEnqueueSend?.("router", async () => {
        startTimer();
        await socket.send([idFrame, ...frames]);
      })
      .catch((error) => this.#pending.reject(key, error));

    return promise;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 入站响应
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 处理 service 响应（master 侧）
   *
   * @param {{
   *   requestId: string,
   *   service?: string|null,
   *   identityText?: string|null,
   *   payload: any,
   *   payloadFrames?: Buffer[],
   *   rawEvent?: any,
   * }} event
   * @returns {boolean}
   */
  handleIncomingResponse(event = {}) {
    const requestId = String(event.requestId ?? "");
    if (!requestId) return false;

    const identityText = String(event.identityText ?? "");
    const key = this.#pending.key(requestId, identityText);

    return this.#pending.resolve(key, {
      service: event.service ?? null,
      payload: event.payload,
      payloadFrames: event.payloadFrames ?? [],
      identityText: identityText || null,
      rawEvent: event.rawEvent ?? null,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 入站请求
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 处理 service 请求，并自动回复（slave 侧）
   *
   * @param {{
   *   channel: "router"|"dealer",
   *   service: string,
   *   requestId: string,
   *   payload: any,
   *   payloadFrames: Buffer[],
   *   meta?: any,
   *   body?: Array,
   *   identity?: Buffer,
   *   identityText?: string,
   *   rawEvent?: any,
   * }} event
   * @returns {Promise<boolean>} true 表示已识别并处理该 service 请求
   */
  async handleIncomingRequest(event = {}) {
    const serviceName = String(event.service ?? "").trim();
    const requestId = String(event.requestId ?? "");
    if (!serviceName || !requestId) return false;

    const handler = this.#handlers.get(serviceName);
    if (!handler) {
      await this.#replyError(event, `未注册的 service：${serviceName}`);
      return true;
    }

    try {
      const result = await handler({
        service: serviceName,
        identity: event.identity,
        identityText: event.identityText,
        requestId,
        payload: event.payload,
        payloadFrames: event.payloadFrames ?? [],
        meta: event.meta ?? null,
        body: event.body ?? [],
        channel: event.channel,
        rawEvent: event.rawEvent ?? null,
      });

      await this.#replyOk(event, result);
      return true;
    } catch (error) {
      await this.#replyError(event, error);
      return true;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 生命周期
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * reject 所有待处理 service 请求
   * @param {Error} error
   */
  rejectAll(error) {
    this.#pending.rejectAll(error);
  }

  /**
   * 当前待处理 service 请求数
   * @returns {number}
   */
  get size() {
    return this.#pending.size;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 私有辅助
  // ───────────────────────────────────────────────────────────────────────────

  async #replyOk(event, result) {
    const owner = this.#owner;
    const payloadFrames = owner._serviceNormalizeReplyPayload?.(result) ?? [
      Buffer.from(JSON.stringify({ ok: true }), "utf8"),
    ];
    const frames =
      owner._serviceCreateResponseFrames?.(
        String(event.requestId),
        String(event.service),
        payloadFrames,
        event.identityText ?? null,
      ) ?? [];

    if (event.channel === "router") {
      const socket = owner._serviceRequireSocket?.("router", "ROUTER");
      if (!socket) {
        throw new Error("ROUTER socket 尚未就绪，无法回复 service 请求。");
      }
      const idFrame = identityToBuffer(event.identity);
      await owner._serviceEnqueueSend?.("router", () =>
        socket.send([idFrame, ...frames]),
      );
      return;
    }

    const socket = owner._serviceRequireSocket?.("dealer", "DEALER");
    if (!socket) {
      throw new Error("DEALER socket 尚未就绪，无法回复 service 请求。");
    }
    await owner._serviceEnqueueSend?.("dealer", () => socket.send(frames));
  }

  async #replyError(event, error) {
    const owner = this.#owner;
    const payloadFrames = owner._serviceBuildErrorPayload?.(
      event.service,
      error,
    );
    const frames =
      owner._serviceCreateResponseFrames?.(
        String(event.requestId),
        String(event.service),
        payloadFrames,
        event.identityText ?? null,
      ) ?? [];

    if (event.channel === "router") {
      const socket = owner._serviceRequireSocket?.("router", "ROUTER");
      if (!socket) {
        throw new Error("ROUTER socket 尚未就绪，无法回复 service 错误。");
      }
      const idFrame = identityToBuffer(event.identity);
      await owner._serviceEnqueueSend?.("router", () =>
        socket.send([idFrame, ...frames]),
      );
      return;
    }

    const socket = owner._serviceRequireSocket?.("dealer", "DEALER");
    if (!socket) {
      throw new Error("DEALER socket 尚未就绪，无法回复 service 错误。");
    }
    await owner._serviceEnqueueSend?.("dealer", () => socket.send(frames));
  }
}
