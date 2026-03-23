/**
 * ZNL —— ZeroMQ 集群节点主类
 *
 * 封装 ROUTER/DEALER 双向通信，对外提供：
 *  - DEALER()       slave 侧发 RPC 请求 / 注册自动回复处理器
 *  - ROUTER()       master 侧发 RPC 请求 / 注册自动回复处理器
 *  - publish()      master 侧向所有在线 slave 广播消息（模拟 PUB）
 *  - subscribe()    slave 侧订阅指定 topic
 *  - unsubscribe()  slave 侧取消订阅
 *  - start() / stop() 生命周期管理
 *  - EventEmitter 事件总线：
 *      router / dealer / request / response / message
 *      auth_failed / slave_connected / slave_disconnected
 *      publish / error
 *
 * 心跳机制：
 *  - slave 每隔 heartbeatInterval ms 向 master 发送一帧心跳
 *  - master 每隔 heartbeatInterval ms 扫描一次在线列表
 *  - 超过 heartbeatInterval × 3 ms 未收到心跳，判定 slave 已崩溃并移除
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as zmq from "zeromq";

import {
  DEFAULT_ENDPOINTS,
  DEFAULT_HEARTBEAT_INTERVAL,
  CONTROL_PREFIX,
  CONTROL_HEARTBEAT,
} from "./constants.js";
import {
  identityToString,
  identityToBuffer,
  normalizeFrames,
  payloadFromFrames,
  buildRegisterFrames,
  buildUnregisterFrames,
  buildRequestFrames,
  buildResponseFrames,
  buildPublishFrames,
  parseControlFrames,
} from "./protocol.js";
import { PendingManager } from "./PendingManager.js";
import { SendQueue } from "./SendQueue.js";

export class ZNL extends EventEmitter {
  // ─── 节点配置（构造后只读）────────────────────────────────────────────────

  /** @type {"master"|"slave"} */
  role;
  /** @type {string} 节点唯一标识，slave 侧同时作为 ZMQ routingId */
  id;
  /** @type {{ router: string }} */
  endpoints;
  /** @type {string} 认证 Key（空字符串表示不启用认证） */
  authKey;
  /** @type {boolean} master 侧是否强制校验认证 Key */
  requireAuth;

  // ─── 运行状态 ─────────────────────────────────────────────────────────────

  /** @type {boolean} 当前节点是否处于运行状态 */
  running = false;

  // ─── 私有运行时字段 ───────────────────────────────────────────────────────

  /** @type {{ router?: import("zeromq").Router, dealer?: import("zeromq").Dealer }} */
  #sockets = {};

  /** @type {Promise[]} 所有 socket 读取循环的 Promise 引用（用于 teardown 等待） */
  #readLoops = [];

  /** @type {Promise<void>|null} 正在进行的 start 操作（去重用） */
  #startPromise = null;

  /** @type {Promise<void>|null} 正在进行的 stop 操作（去重用） */
  #stopPromise = null;

  /** @type {PendingManager} in-flight RPC 请求管理器 */
  #pending;

  /** @type {SendQueue} 串行发送队列（防止 socket 并发写入） */
  #sendQueue;

  /** @type {Function|null} master 侧收到 slave 请求时的自动回复处理器 */
  #routerAutoHandler = null;

  /** @type {Function|null} slave 侧收到 master 请求时的自动回复处理器 */
  #dealerAutoHandler = null;

  // ─── PUB/SUB 状态 ────────────────────────────────────────────────────────

  /**
   * master 侧：已注册的在线 slave 表
   * key   = slaveId（字符串）
   * value = { identity: Buffer（用于 ROUTER 发送）, lastSeen: number（最后心跳时间戳）}
   * @type {Map<string, { identity: Buffer, lastSeen: number }>}
   */
  #slaves = new Map();

  /**
   * slave 侧：topic → handler 订阅表
   * @type {Map<string, Function>}
   */
  #subscriptions = new Map();

  // ─── 心跳 ────────────────────────────────────────────────────────────────

  /** 心跳间隔（ms），0 表示禁用；slave/master 共用同一配置 */
  #heartbeatInterval;

  /** slave 侧发送心跳的定时器句柄 */
  #heartbeatTimer = null;

  /** master 侧扫描死节点的定时器句柄 */
  #heartbeatCheckTimer = null;

  // ═══════════════════════════════════════════════════════════════════════════
  //  构造函数
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @param {{
   *   role             : "master"|"slave",
   *   id               : string,
   *   endpoints?       : { router?: string },
   *   maxPending?      : number,
   *   authKey?         : string,
   *   heartbeatInterval? : number,
   * }} options
   */
  constructor({
    role,
    id,
    endpoints = {},
    maxPending = 0,
    authKey = "",
    heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL,
  } = {}) {
    super();

    if (role !== "master" && role !== "slave") {
      throw new Error('`role` 必须为 "master" 或 "slave"。');
    }
    if (!id) {
      throw new Error("`id` 为必填项。");
    }

    this.role = role;
    this.id = String(id);
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this.authKey = authKey == null ? "" : String(authKey);
    this.requireAuth = this.role === "master" && this.authKey.length > 0;

    this.#pending = new PendingManager(maxPending);
    this.#sendQueue = new SendQueue();
    this.#heartbeatInterval =
      this.#normalizeHeartbeatInterval(heartbeatInterval);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  公开 API —— 生命周期
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 启动节点
   *  - master：bind ROUTER socket，启动死节点扫描定时器
   *  - slave ：connect DEALER socket，自动发送注册帧，启动心跳定时器
   *
   * 重复调用安全：若已在启动中，返回同一个 Promise；
   * 若上次 stop 尚未完成，等待其结束后再启动。
   */
  async start() {
    if (this.running) return;
    if (this.#startPromise) return this.#startPromise;
    if (this.#stopPromise) await this.#stopPromise;

    this.#startPromise = this.#doStart().finally(() => {
      this.#startPromise = null;
    });
    await this.#startPromise;
  }

  /**
   * 停止节点
   *  - slave：停止心跳定时器，先发注销帧，再关闭 socket
   *  - master：停止扫描定时器，清空在线列表，关闭 socket
   * 重复调用安全。
   */
  async stop() {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#startPromise) await this.#startPromise.catch(() => {});

    if (!this.running && Object.keys(this.#sockets).length === 0) return;

    this.#stopPromise = this.#doStop().finally(() => {
      this.#stopPromise = null;
    });
    await this.#stopPromise;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  公开 API —— RPC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Slave 侧：向 Master 发送 RPC 请求并等待响应。
   * 传入函数时：注册 slave 侧自动回复处理器（Master 主动发来 RPC 请求时触发）。
   *
   * @param {string|Buffer|Uint8Array|Array|Function} payloadOrHandler
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<Buffer|Array>|void}
   */
  async DEALER(payloadOrHandler, options = {}) {
    if (typeof payloadOrHandler === "function") {
      this.#dealerAutoHandler = payloadOrHandler;
      return;
    }
    const response = await this.#request(payloadOrHandler, options);
    return response.payload;
  }

  /**
   * Master 侧：向指定 Slave 发送 RPC 请求并等待响应。
   * 传入函数时：注册 master 侧自动回复处理器（Slave 发来 RPC 请求时触发）。
   *
   * @param {string|Buffer|Function} identityOrHandler - Slave ID 或处理器函数
   * @param {string|Buffer|Uint8Array|Array} [payload]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<Buffer|Array>|void}
   */
  async ROUTER(identityOrHandler, payload, options = {}) {
    if (typeof identityOrHandler === "function") {
      this.#routerAutoHandler = identityOrHandler;
      return;
    }
    const response = await this.#requestTo(identityOrHandler, payload, options);
    return response.payload;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  公开 API —— PUB/SUB
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 【Master 侧】向所有已注册的在线 slave 广播消息（fire-and-forget）
   *
   * 发送异步入队后立即返回，无需 await。
   * 若某个 slave 发送失败，自动将其从在线列表移除并触发 slave_disconnected 事件。
   *
   * @param {string} topic - 消息主题，slave 侧可按 topic 精确过滤
   * @param {string|Buffer|Uint8Array|Array} payload
   */
  publish(topic, payload) {
    if (this.role !== "master") {
      throw new Error("publish() 只能在 master 侧调用。");
    }
    const socket = this.#requireSocket("router", "ROUTER");
    if (this.#slaves.size === 0) return;

    const frames = buildPublishFrames(String(topic), normalizeFrames(payload));

    // 遍历所有在线 slave，逐一入队发送
    // 使用 #sendQueue 保证 socket 写入安全，不与 RPC 帧交叉
    for (const [slaveId, entry] of this.#slaves) {
      const idFrame = identityToBuffer(entry.identity);
      this.#sendQueue
        .enqueue("router", () => socket.send([idFrame, ...frames]))
        .catch(() => {
          // 发送失败说明 slave 已断线，静默移除并通知外部
          if (this.#slaves.delete(slaveId)) {
            this.emit("slave_disconnected", slaveId);
          }
        });
    }
  }

  /**
   * 【Slave 侧】订阅指定 topic，当 master 广播该 topic 时触发 handler
   *
   * 可在 start() 前后任意时刻调用，订阅信息跨 stop/start 周期保留。
   * 同一 topic 重复订阅会覆盖旧的 handler。
   *
   * 同时也可通过 `slave.on("publish", ({ topic, payload }) => ...)` 监听所有 topic。
   *
   * @param {string} topic
   * @param {(event: { topic: string, payload: Buffer|Array }) => void|Promise<void>} handler
   * @returns {this} 支持链式调用
   */
  subscribe(topic, handler) {
    if (this.role !== "slave") {
      throw new Error("subscribe() 只能在 slave 侧调用。");
    }
    if (typeof handler !== "function") {
      throw new TypeError("handler 必须是函数。");
    }
    this.#subscriptions.set(String(topic), handler);
    return this;
  }

  /**
   * 【Slave 侧】取消订阅指定 topic
   *
   * @param {string} topic
   * @returns {this} 支持链式调用
   */
  unsubscribe(topic) {
    if (this.role !== "slave") {
      throw new Error("unsubscribe() 只能在 slave 侧调用。");
    }
    this.#subscriptions.delete(String(topic));
    return this;
  }

  /**
   * 【Master 侧】获取当前所有在线 slave 的 ID 列表（只读快照）
   * @returns {string[]}
   */
  get slaves() {
    return [...this.#slaves.keys()];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  生命周期内部实现
  // ═══════════════════════════════════════════════════════════════════════════

  /** 启动流程：设置 running 标志，初始化对应角色的 socket */
  async #doStart() {
    this.running = true;
    try {
      await (this.role === "master"
        ? this.#startMasterSockets()
        : this.#startSlaveSockets());
    } catch (error) {
      // 启动失败则回滚所有状态
      this.running = false;
      await this.#teardown();
      throw error;
    }
  }

  /**
   * 停止流程
   *  1. slave：停止心跳定时器 → 发注销帧（在 socket 关闭前）
   *  2. 拒绝所有 in-flight pending 请求
   *  3. 关闭 socket，等待读循环退出
   */
  async #doStop() {
    if (this.role === "slave" && this.#sockets.dealer) {
      // 先停心跳，避免关闭期间继续发送
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;

      // 优雅下线：在关闭 socket 前先发送注销帧
      await this.#sendQueue
        .enqueue("dealer", () =>
          this.#sockets.dealer.send(buildUnregisterFrames()),
        )
        .catch(() => {}); // master 可能已关闭，忽略发送失败
    }

    this.running = false;
    this.#pending.rejectAll(new Error("节点已停止，所有待处理请求已取消。"));
    await this.#teardown();
  }

  /**
   * 清理所有运行时资源
   * 顺序：停止定时器 → 关闭 socket → 等待读循环退出 → 清空所有注册表
   */
  async #teardown() {
    // 停止心跳相关定时器
    clearInterval(this.#heartbeatTimer);
    clearInterval(this.#heartbeatCheckTimer);
    this.#heartbeatTimer = null;
    this.#heartbeatCheckTimer = null;

    for (const socket of Object.values(this.#sockets)) {
      try {
        socket.close();
      } catch {}
    }
    await Promise.allSettled(this.#readLoops);

    this.#readLoops = [];
    this.#sockets = {};
    this.#sendQueue.clear();
    this.#slaves.clear(); // 清空 slave 注册表，避免 restart 时残留旧条目
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Socket 初始化
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 初始化 Master 侧 ROUTER socket（bind 模式），并启动读循环和死节点扫描定时器
   */
  async #startMasterSockets() {
    const router = new zmq.Router();
    await router.bind(this.endpoints.router);
    this.#sockets.router = router;

    this.#consume(router, (frames) => this.#handleRouterFrames(frames));
    this.#startHeartbeatCheck();
  }

  /**
   * 初始化 Slave 侧 DEALER socket（connect 模式），并启动读循环
   * 连接后立即发送注册帧，再启动心跳定时器
   */
  async #startSlaveSockets() {
    // routingId 即节点 id，Master 侧通过此字段识别发送方身份
    const dealer = new zmq.Dealer({ routingId: this.id });
    dealer.connect(this.endpoints.router);
    this.#sockets.dealer = dealer;

    this.#consume(dealer, (frames) => this.#handleDealerFrames(frames));

    // 自动发送注册帧（携带 authKey，供 master 进行认证）
    await this.#sendQueue.enqueue("dealer", () =>
      dealer.send(buildRegisterFrames(this.authKey)),
    );

    // 注册成功后启动心跳
    this.#startHeartbeat();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  帧处理（接收方向）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 处理 Master 侧 ROUTER 收到的帧
   * ZMQ ROUTER 帧结构：[identity, ...控制帧]
   * identity 由 ZMQ 自动注入，表示发送方的 routingId
   */
  async #handleRouterFrames(rawFrames) {
    const [identity, ...bodyFrames] = rawFrames;
    const identityText = identityToString(identity);
    const parsed = parseControlFrames(bodyFrames);
    const payload = payloadFromFrames(parsed.payloadFrames);

    const event = this.#buildAndEmit("router", rawFrames, {
      identity,
      identityText,
      payload,
      ...parsed,
    });

    // ── 心跳：更新 slave 的最后活跃时间 ───────────────────────────────────
    if (parsed.kind === "heartbeat") {
      const entry = this.#slaves.get(identityText);
      if (entry) entry.lastSeen = Date.now();
      return;
    }

    // ── 注册：slave 上线 ────────────────────────────────────────────────────
    if (parsed.kind === "register") {
      // 若启用认证，注册时同样校验 authKey
      if (this.requireAuth && parsed.authKey !== this.authKey) {
        this.emit("auth_failed", { ...event, expectedAuthKey: this.authKey });
        return;
      }
      this.#slaves.set(identityText, { identity, lastSeen: Date.now() });
      this.emit("slave_connected", identityText);
      return;
    }

    // ── 注销：slave 主动下线 ────────────────────────────────────────────────
    if (parsed.kind === "unregister") {
      if (this.#slaves.delete(identityText)) {
        this.emit("slave_disconnected", identityText);
      }
      return;
    }

    // ── RPC 请求：slave 发来的请求 ──────────────────────────────────────────
    if (parsed.kind === "request") {
      // 认证校验：Key 不匹配则丢弃并触发 auth_failed 事件
      if (this.requireAuth && parsed.authKey !== this.authKey) {
        this.emit("auth_failed", { ...event, expectedAuthKey: this.authKey });
        return;
      }

      this.emit("request", event);

      // 有自动回复处理器时，执行并回复
      if (this.#routerAutoHandler) {
        try {
          const replyPayload = await this.#routerAutoHandler(event);
          await this.#replyTo(identity, parsed.requestId, replyPayload);
        } catch (error) {
          this.emit("error", error);
        }
      }
      return;
    }

    // ── RPC 响应：slave 回复了 master 之前主动发出的请求 ───────────────────
    if (parsed.kind === "response") {
      const key = this.#pending.key(parsed.requestId, identityText);
      this.#pending.resolve(key, event);
      this.emit("response", event);
    }
  }

  /**
   * 处理 Slave 侧 DEALER 收到的帧
   * ZMQ DEALER 帧结构：[...控制帧]（无 identity 帧）
   */
  async #handleDealerFrames(frames) {
    const parsed = parseControlFrames(frames);
    const payload = payloadFromFrames(parsed.payloadFrames);

    const event = this.#buildAndEmit("dealer", frames, { payload, ...parsed });

    // ── PUB 广播：master 推送的消息 ────────────────────────────────────────
    if (parsed.kind === "publish") {
      const pubEvent = { topic: parsed.topic, payload };

      // 触发统一广播事件（所有 topic 都会触发，方便兜底监听）
      this.emit("publish", pubEvent);

      // 触发精确 topic 订阅处理器
      const handler = this.#subscriptions.get(parsed.topic);
      if (handler) {
        try {
          await handler(pubEvent);
        } catch (error) {
          this.emit("error", error);
        }
      }
      return;
    }

    // ── RPC 请求：master 主动发来的请求 ────────────────────────────────────
    if (parsed.kind === "request") {
      this.emit("request", event);

      if (this.#dealerAutoHandler) {
        try {
          const replyPayload = await this.#dealerAutoHandler(event);
          await this.#reply(parsed.requestId, replyPayload);
        } catch (error) {
          this.emit("error", error);
        }
      }
      return;
    }

    // ── RPC 响应：master 回复了 slave 之前发出的请求 ───────────────────────
    if (parsed.kind === "response") {
      const key = this.#pending.key(parsed.requestId);
      this.#pending.resolve(key, event);
      this.emit("response", event);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RPC 请求发送（主动方向）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Slave → Master：通过 DEALER socket 发送 RPC 请求，返回响应 Promise
   * 流程：创建 pending → 入队等待发送 → 发送后启动超时计时 → 等待响应 resolve
   */
  async #request(payload, { timeoutMs } = {}) {
    const socket = this.#requireSocket("dealer", "DEALER");
    this.#pending.ensureCapacity();

    const requestId = randomUUID();
    const key = this.#pending.key(requestId);
    const { promise, startTimer } = this.#pending.create(
      key,
      timeoutMs,
      requestId,
    );
    const frames = buildRequestFrames(
      requestId,
      normalizeFrames(payload),
      this.authKey,
    );

    // 入队：等前一个发送完成后再发；发送完毕后立即启动超时计时
    this.#sendQueue
      .enqueue("dealer", async () => {
        startTimer();
        await socket.send(frames);
      })
      .catch((error) => this.#pending.reject(key, error));

    return promise;
  }

  /**
   * Master → Slave：通过 ROUTER socket 向指定 Slave 发送 RPC 请求，返回响应 Promise
   */
  async #requestTo(identity, payload, { timeoutMs } = {}) {
    const socket = this.#requireSocket("router", "ROUTER");
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
    const frames = buildRequestFrames(
      requestId,
      normalizeFrames(payload),
      this.authKey,
    );

    this.#sendQueue
      .enqueue("router", async () => {
        startTimer();
        // ROUTER socket 发送时必须在最前面附上 identity 帧
        await socket.send([idFrame, ...frames]);
      })
      .catch((error) => this.#pending.reject(key, error));

    return promise;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RPC 响应发送（被动方向）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Slave 回复 Master 的 RPC 请求（使用 DEALER socket）
   * @param {string} requestId
   * @param {*} payload
   */
  async #reply(requestId, payload) {
    const socket = this.#requireSocket("dealer", "DEALER");
    const frames = buildResponseFrames(requestId, normalizeFrames(payload));
    await this.#sendQueue.enqueue("dealer", () => socket.send(frames));
  }

  /**
   * Master 回复指定 Slave 的 RPC 请求（使用 ROUTER socket）
   * @param {Buffer|string} identity
   * @param {string} requestId
   * @param {*} payload
   */
  async #replyTo(identity, requestId, payload) {
    const socket = this.#requireSocket("router", "ROUTER");
    const idFrame = identityToBuffer(identity);
    const frames = buildResponseFrames(requestId, normalizeFrames(payload));
    await this.#sendQueue.enqueue("router", () =>
      socket.send([idFrame, ...frames]),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  心跳（内部实现）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 启动 slave 侧心跳发送定时器
   * 每隔 #heartbeatInterval ms 向 master 发送一帧心跳，证明自己还活着
   */
  #startHeartbeat() {
    if (this.#heartbeatInterval <= 0) return;

    this.#heartbeatTimer = setInterval(() => {
      if (!this.running || !this.#sockets.dealer) return;
      this.#sendQueue
        .enqueue("dealer", () =>
          this.#sockets.dealer.send([CONTROL_PREFIX, CONTROL_HEARTBEAT]),
        )
        .catch(() => {}); // 发送失败静默处理，不影响业务
    }, this.#heartbeatInterval);
  }

  /**
   * 启动 master 侧死节点扫描定时器
   * 每隔 #heartbeatInterval ms 扫描一次，将超过 3 个周期未活跃的 slave 视为崩溃并移除
   */
  #startHeartbeatCheck() {
    if (this.#heartbeatInterval <= 0) return;

    // 超时阈值 = 3 个心跳周期，给网络抖动留出充分余量
    const timeout = this.#heartbeatInterval * 3;

    this.#heartbeatCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const [slaveId, entry] of this.#slaves) {
        if (now - entry.lastSeen > timeout) {
          this.#slaves.delete(slaveId);
          this.emit("slave_disconnected", slaveId);
        }
      }
    }, this.#heartbeatInterval);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  工具方法
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 启动 socket 的异步读取循环（for-await-of）
   * 循环在 socket 被关闭后自然退出，Promise 保存到 #readLoops 供 teardown 等待
   *
   * @param {import("zeromq").Socket} socket
   * @param {(frames: Array) => Promise<void>} handler
   */
  #consume(socket, handler) {
    const loop = (async () => {
      try {
        for await (const rawFrames of socket) {
          if (!this.running) return;
          // zeromq v6 单帧时返回 Buffer，多帧时返回数组，统一转为数组处理
          const frames = Array.isArray(rawFrames) ? rawFrames : [rawFrames];
          try {
            await handler(frames);
          } catch (error) {
            this.emit("error", error);
          }
        }
      } catch (error) {
        // socket 关闭时 for-await 会抛出，仅在运行中时才视为错误
        if (this.running) this.emit("error", error);
      }
    })();

    this.#readLoops.push(loop);
  }

  /**
   * 构建事件对象，并同时触发 channel 专项事件和 message 统一事件
   * @param {string} channel
   * @param {Array} frames
   * @param {object} extra
   * @returns {object} 事件对象
   */
  #buildAndEmit(channel, frames, extra = {}) {
    const event = { channel, frames, ...extra };
    this.emit(channel, event);
    this.emit("message", event);
    return event;
  }

  /**
   * 获取指定 socket，不存在时抛出明确的错误提示
   * @param {string} name
   * @param {string} displayName
   * @returns {import("zeromq").Socket}
   */
  #requireSocket(name, displayName) {
    const socket = this.#sockets[name];
    if (!socket) {
      throw new Error(`${displayName} socket 尚未就绪，请先调用 start()。`);
    }
    return socket;
  }

  /**
   * 规范化心跳间隔：必须是非负整数，否则使用默认值
   * @param {*} n
   * @returns {number}
   */
  #normalizeHeartbeatInterval(n) {
    const v = Number(n);
    if (Number.isFinite(v) && v >= 0) return Math.floor(v);
    return DEFAULT_HEARTBEAT_INTERVAL;
  }
}
