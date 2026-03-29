/**
 * ZNL —— ZeroMQ 集群节点主类
 *
 * 封装 ROUTER/DEALER 双向通信，对外提供：
 *  - DEALER()       slave 侧发 RPC 请求 / 注册自动回复处理器
 *  - ROUTER()       master 侧发 RPC 请求 / 注册自动回复处理器
 *  - PUBLISH()      master 侧向所有在线 slave 广播消息（模拟 PUB）
 *  - SUBSCRIBE()    slave 侧订阅指定 topic
 *  - UNSUBSCRIBE()  slave 侧取消订阅
 *  - PUSH()         slave 侧向 master 单向推送消息（模拟 PUSH）
 *  - start() / stop() 生命周期管理
 *  - EventEmitter 事件总线：
 *      router / dealer / request / response / message
 *      auth_failed / slave_connected / slave_disconnected
 *      publish / push / error
 *
 * 加密模式（encrypted）：
 *  - false : 明文模式（不签名/不加密）
 *  - true  : 签名 + 防重放 + payload 透明加密（AES-256-GCM）
 *
 * 心跳机制：
 *  - slave 每隔 heartbeatInterval ms 向 master 发送一帧心跳
 *  - master 每隔 heartbeatInterval ms 扫描一次在线列表
 *  - 超过 heartbeatTimeoutMs 未收到心跳，判定 slave 已崩溃并移除
 *    （heartbeatTimeoutMs <= 0 时，默认按 heartbeatInterval × 3 计算）
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as zmq from "zeromq";

import {
  DEFAULT_ENDPOINTS,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MAX_PENDING,
  DEFAULT_ENABLE_PAYLOAD_DIGEST,
  CONTROL_PREFIX,
  CONTROL_HEARTBEAT,
  SECURITY_ENVELOPE_VERSION,
  MAX_TIME_SKEW_MS,
  REPLAY_WINDOW_MS,
} from "./constants.js";

import {
  identityToString,
  identityToBuffer,
  normalizeFrames,
  payloadFromFrames,
  buildRegisterFrames,
  buildUnregisterFrames,
  buildHeartbeatFrames,
  buildHeartbeatAckFrames,
  buildRequestFrames,
  buildResponseFrames,
  buildPublishFrames,
  buildPushFrames,
  parseControlFrames,
} from "./protocol.js";

import {
  ReplayGuard,
  deriveKeys,
  toFrameBuffers,
  digestFrames,
  generateNonce,
  nowMs,
  canonicalSignInput,
  encodeAuthProofToken,
  decodeAuthProofToken,
  encryptFrames,
  decryptFrames,
} from "./security.js";

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

  /** @type {string} 共享认证 Key（仅 encrypted=true 使用） */
  authKey;

  /** @type {boolean} 是否启用加密安全（签名+防重放+透明加密） */
  encrypted;

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

  /** @type {number} 心跳超时时间（ms），0 表示使用 interval × 3 */
  #heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS;

  /** @type {boolean} 是否启用 payload 摘要校验（安全模式用） */
  #enablePayloadDigest = DEFAULT_ENABLE_PAYLOAD_DIGEST;

  /** @type {Map<string, string>} master 侧 authKey 配置表（按 slaveId） */
  #authKeyMap = new Map();

  /** @type {Map<string, { signKey: Buffer, encryptKey: Buffer }>} master 侧派生密钥缓存 */
  #slaveKeyCache = new Map();

  // ─── PUB/SUB 状态 ────────────────────────────────────────────────────────

  /**
   * master 侧：已注册的在线 slave 表
   * key   = slaveId（字符串）
   * value = { identity: Buffer, lastSeen: number, signKey: Buffer|null, encryptKey: Buffer|null }
   * @type {Map<string, { identity: Buffer, lastSeen: number, signKey: Buffer|null, encryptKey: Buffer|null }>}
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

  /** slave 侧单次心跳调度定时器句柄 */
  #heartbeatTimer = null;

  /** slave 侧等待心跳应答的超时定时器句柄 */
  #heartbeatAckTimer = null;

  /** slave 侧当前是否存在未确认的心跳 */
  #heartbeatWaitingAck = false;

  /** slave 侧最近一次确认主节点在线的时间戳 */
  #lastMasterSeenAt = 0;

  /** slave 侧缓存的主节点在线状态 */
  #masterOnline = false;

  /** slave 侧正在进行的 Dealer 重连 Promise（防止并发重连） */
  #dealerReconnectPromise = null;

  /** master 侧扫描死节点的定时器句柄 */
  #heartbeatCheckTimer = null;

  // ─── 安全运行时状态 ───────────────────────────────────────────────────────

  /** @type {boolean} 当前是否启用签名安全（auth / encrypted） */
  #secureEnabled = false;

  /** @type {Buffer|null} HMAC 签名密钥（由 authKey HKDF 派生） */
  #signKey = null;

  /** @type {Buffer|null} 对称加密密钥（由 authKey HKDF 派生） */
  #encryptKey = null;

  /** @type {ReplayGuard} 防重放缓存 */
  #replayGuard;

  /** @type {number} 时间戳最大允许漂移（毫秒） */
  #maxTimeSkewMs = MAX_TIME_SKEW_MS;

  /** @type {string|null} slave 侧学习到的 master 节点 ID（来自签名证明） */
  #masterNodeId = null;

  // ═══════════════════════════════════════════════════════════════════════════
  //  构造函数
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @param {{
   *   role               : "master"|"slave",
   *   id                 : string,
   *   endpoints?         : { router?: string },
   *   maxPending?          : number,
   *   authKey?             : string,
   *   authKeyMap?          : Record<string, string>,
   *   heartbeatInterval?   : number,
   *   heartbeatTimeoutMs?  : number,
   *   encrypted?           : boolean,
   *   enablePayloadDigest? : boolean,
   *   maxTimeSkewMs?       : number,
   *   replayWindowMs?      : number,
   * }} options
   */
  constructor({
    role,
    id,
    endpoints = {},
    maxPending = DEFAULT_MAX_PENDING,
    authKey = "",
    authKeyMap = null,
    heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    encrypted = false,
    enablePayloadDigest = DEFAULT_ENABLE_PAYLOAD_DIGEST,
    maxTimeSkewMs = MAX_TIME_SKEW_MS,
    replayWindowMs = REPLAY_WINDOW_MS,
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

    if (this.role === "master") {
      if (authKeyMap != null) {
        if (typeof authKeyMap !== "object") {
          throw new TypeError(
            "`authKeyMap` 必须是对象（slaveId -> authKey）。",
          );
        }
        for (const [slaveId, key] of Object.entries(authKeyMap)) {
          if (key == null) continue;
          this.#authKeyMap.set(String(slaveId), String(key));
        }
      }
    }

    this.encrypted = Boolean(encrypted);
    this.#secureEnabled = this.encrypted;

    if (this.#secureEnabled) {
      const hasAuthMap = this.role === "master" && authKeyMap != null;
      if (!this.authKey && !hasAuthMap) {
        throw new Error(
          "启用 encrypted=true 时，必须提供非空 authKey 或 authKeyMap。",
        );
      }
      if (this.authKey) {
        const { signKey, encryptKey } = deriveKeys(this.authKey);
        this.#signKey = signKey;
        this.#encryptKey = encryptKey;
      }
    }

    this.#pending = new PendingManager(maxPending);
    this.#sendQueue = new SendQueue();
    this.#heartbeatInterval =
      this.#normalizeHeartbeatInterval(heartbeatInterval);

    // 是否启用 payload 摘要校验（安全模式用）
    this.#enablePayloadDigest = Boolean(enablePayloadDigest);

    // 心跳超时：<=0 则由 heartbeatInterval 推导
    this.#heartbeatTimeoutMs = this.#normalizePositiveInt(
      heartbeatTimeoutMs,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    );

    this.#maxTimeSkewMs = this.#normalizePositiveInt(
      maxTimeSkewMs,
      MAX_TIME_SKEW_MS,
    );
    this.#replayGuard = new ReplayGuard({
      windowMs: this.#normalizePositiveInt(replayWindowMs, REPLAY_WINDOW_MS),
    });
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
  //  公开 API —— PUB/SUB/PUSH
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
  PUBLISH(topic, payload) {
    if (this.role !== "master") {
      throw new Error("PUBLISH() 只能在 master 侧调用。");
    }
    const socket = this.#requireSocket("router", "ROUTER");
    if (this.#slaves.size === 0) return;

    const topicText = String(topic);

    for (const [slaveId, entry] of this.#slaves) {
      const keys = this.#secureEnabled ? this.#resolveSlaveKeys(slaveId) : null;
      if (this.#secureEnabled && !keys) {
        if (this.#slaves.delete(slaveId)) {
          this.emit("slave_disconnected", slaveId);
        }
        continue;
      }

      const payloadFrames = this.#sealPayloadFrames(
        "publish",
        topicText,
        payload,
        keys?.encryptKey ?? null,
      );
      const authProof = this.#secureEnabled
        ? this.#createAuthProof(
            "publish",
            topicText,
            payloadFrames,
            keys.signKey,
          )
        : "";

      const frames = buildPublishFrames(topicText, payloadFrames, authProof);
      const idFrame = identityToBuffer(entry.identity);

      this.#sendQueue
        .enqueue("router", () => socket.send([idFrame, ...frames]))
        .catch(() => {
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
  SUBSCRIBE(topic, handler) {
    if (this.role !== "slave") {
      throw new Error("SUBSCRIBE() 只能在 slave 侧调用。");
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
  UNSUBSCRIBE(topic) {
    if (this.role !== "slave") {
      throw new Error("UNSUBSCRIBE() 只能在 slave 侧调用。");
    }
    this.#subscriptions.delete(String(topic));
    return this;
  }

  /**
   * 【Slave 侧】向 master 单向推送消息（fire-and-forget）
   *
   * 发送异步入队后立即返回，无需 await。
   *
   * @param {string} topic
   * @param {string|Buffer|Uint8Array|Array} payload
   */
  PUSH(topic, payload) {
    if (this.role !== "slave") {
      throw new Error("PUSH() 只能在 slave 侧调用。");
    }
    const socket = this.#requireSocket("dealer", "DEALER");
    const topicText = String(topic);

    const payloadFrames = this.#sealPayloadFrames(
      "push",
      topicText,
      payload,
      this.#encryptKey,
    );
    const authProof = this.#secureEnabled
      ? this.#createAuthProof("push", topicText, payloadFrames)
      : "";

    const frames = buildPushFrames(topicText, payloadFrames, authProof);
    this.#sendQueue
      .enqueue("dealer", () => socket.send(frames))
      .catch(() => {});
  }

  /**
   * 【Master 侧】获取当前所有在线 slave 的 ID 列表（只读快照）
   * @returns {string[]}
   */
  get slaves() {
    return [...this.#slaves.keys()];
  }

  /**
   * 【Slave 侧】当前已确认的主节点在线状态
   * - 仅在 slave 角色下有意义
   * - 收到合法 heartbeat_ack / request / response / publish 时置为 true
   * - 心跳应答超时、重连、stop 时置为 false
   */
  get masterOnline() {
    return this.role === "slave" ? this.#masterOnline : false;
  }

  /**
   * 【Slave 侧】查询当前主节点是否在线
   * 说明：
   * - 这是对外公开的轻量 API，适合业务层主动轮询
   * - 返回值基于最近一次链路确认结果，而非一次实时网络探测
   * @returns {boolean}
   */
  isMasterOnline() {
    return this.masterOnline;
  }

  /**
   * 【Master 侧】动态添加/更新某个 slave 的 authKey（立即生效）
   * @param {string} slaveId
   * @param {string} authKey
   * @returns {this}
   */
  addAuthKey(slaveId, authKey) {
    if (this.role !== "master") {
      throw new Error("addAuthKey() 只能在 master 侧调用。");
    }
    const id = String(slaveId ?? "");
    if (!id) {
      throw new Error("slaveId 不能为空。");
    }
    const key = authKey == null ? "" : String(authKey);
    if (!key) {
      throw new Error("authKey 不能为空。");
    }

    this.#authKeyMap.set(id, key);

    if (this.#secureEnabled) {
      const derived = deriveKeys(key);
      this.#slaveKeyCache.set(id, derived);
      const entry = this.#slaves.get(id);
      if (entry) {
        entry.signKey = derived.signKey;
        entry.encryptKey = derived.encryptKey;
      }
    }
    return this;
  }

  /**
   * 【Master 侧】移除某个 slave 的 authKey（立即生效）
   * @param {string} slaveId
   * @returns {this}
   */
  removeAuthKey(slaveId) {
    if (this.role !== "master") {
      throw new Error("removeAuthKey() 只能在 master 侧调用。");
    }
    const id = String(slaveId ?? "");
    if (!id) {
      throw new Error("slaveId 不能为空。");
    }

    this.#authKeyMap.delete(id);
    this.#slaveKeyCache.delete(id);

    if (this.#slaves.has(id)) {
      this.#slaves.delete(id);
      this.emit("slave_disconnected", id);
    }
    return this;
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
      clearTimeout(this.#heartbeatTimer);
      clearTimeout(this.#heartbeatAckTimer);
      this.#heartbeatTimer = null;
      this.#heartbeatAckTimer = null;
      this.#heartbeatWaitingAck = false;
      this.#masterOnline = false;
      this.#lastMasterSeenAt = 0;

      await this.#sendQueue
        .enqueue("dealer", () =>
          this.#sockets.dealer.send(buildUnregisterFrames()),
        )
        .catch(() => {});
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
    clearTimeout(this.#heartbeatTimer);
    clearTimeout(this.#heartbeatAckTimer);
    clearInterval(this.#heartbeatCheckTimer);
    this.#heartbeatTimer = null;
    this.#heartbeatAckTimer = null;
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
    this.#slaves.clear();
    this.#slaveKeyCache.clear();
    this.#masterNodeId = null;
    this.#masterOnline = false;
    this.#lastMasterSeenAt = 0;
    this.#heartbeatWaitingAck = false;
    this.#dealerReconnectPromise = null;
    this.#replayGuard.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Socket 初始化
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 初始化 Master 侧 ROUTER socket（bind 模式），并启动读循环和死节点扫描定时器
   */
  async #startMasterSockets() {
    const router = new zmq.Router({ handover: true });
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
    this.#masterOnline = false;
    this.#lastMasterSeenAt = 0;
    this.#heartbeatWaitingAck = false;

    const dealer = this.#createDealerSocket();
    this.#sockets.dealer = dealer;

    // 注册帧改为“尽力发送”：
    // - master 尚未上线时无需阻塞启动流程
    // - 后续 heartbeat_ack 成功后仍可自然恢复在线状态
    this.#trySendRegister();
    this.#startHeartbeat();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  帧处理（接收方向）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 处理 Master 侧 ROUTER 收到的帧
   * ZMQ ROUTER 帧结构：[identity, ...控制帧]
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

    // ── 心跳 ────────────────────────────────────────────────────────────────
    if (parsed.kind === "heartbeat") {
      let ackFrames = buildHeartbeatAckFrames();

      if (this.#secureEnabled) {
        const keys = this.#resolveSlaveKeys(identityText);
        if (!keys) {
          this.#emitAuthFailed(event, "未配置该 slave 的 authKey。");
          if (this.#slaves.delete(identityText)) {
            this.emit("slave_disconnected", identityText);
          }
          return;
        }

        const v = this.#verifyIncomingProof({
          kind: "heartbeat",
          proofToken: parsed.authProof,
          requestId: "",
          payloadFrames: [],
          expectedNodeId: identityText,
          signKey: keys.signKey,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        this.#ensureSlaveOnline(identityText, identity, {
          touch: true,
          signKey: keys.signKey,
          encryptKey: keys.encryptKey,
        });

        ackFrames = buildHeartbeatAckFrames(
          this.#createAuthProof("heartbeat_ack", "", [], keys.signKey),
        );
      } else {
        // 心跳视为在线确认：必要时自动补注册
        this.#ensureSlaveOnline(identityText, identity, { touch: true });
      }

      await this.#sendQueue
        .enqueue("router", () =>
          this.#sockets.router.send([identityToBuffer(identity), ...ackFrames]),
        )
        .catch(() => {});
      return;
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    if (parsed.kind === "register") {
      if (this.#secureEnabled) {
        const keys = this.#resolveSlaveKeys(identityText);
        if (!keys) {
          this.#emitAuthFailed(event, "未配置该 slave 的 authKey。");
          if (this.#slaves.delete(identityText)) {
            this.emit("slave_disconnected", identityText);
          }
          return;
        }

        const v = this.#verifyIncomingProof({
          kind: "register",
          proofToken: parsed.authKey, // register 复用 authKey 字段承载 proof
          requestId: "",
          payloadFrames: [],
          expectedNodeId: identityText,
          signKey: keys.signKey,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        this.#ensureSlaveOnline(identityText, identity, {
          touch: true,
          signKey: keys.signKey,
          encryptKey: keys.encryptKey,
        });
        return;
      }

      this.#slaves.set(identityText, {
        identity,
        lastSeen: Date.now(),
        signKey: null,
        encryptKey: null,
      });
      this.emit("slave_connected", identityText);
      return;
    }

    // ── 注销 ────────────────────────────────────────────────────────────────
    if (parsed.kind === "unregister") {
      if (this.#slaves.delete(identityText)) {
        this.emit("slave_disconnected", identityText);
      }
      return;
    }

    // ── PUSH 推送：slave -> master ─────────────────────────────────────────
    if (parsed.kind === "push") {
      let finalFrames = parsed.payloadFrames;

      if (this.#secureEnabled) {
        const keys = this.#resolveSlaveKeys(identityText);
        if (!keys) {
          this.#emitAuthFailed(event, "未配置该 slave 的 authKey。");
          if (this.#slaves.delete(identityText)) {
            this.emit("slave_disconnected", identityText);
          }
          return;
        }

        const v = this.#verifyIncomingProof({
          kind: "push",
          proofToken: parsed.authProof,
          requestId: parsed.topic ?? "",
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: identityText,
          signKey: keys.signKey,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        this.#ensureSlaveOnline(identityText, identity, {
          touch: true,
          signKey: keys.signKey,
          encryptKey: keys.encryptKey,
        });

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "push",
              parsed.topic ?? "",
              parsed.payloadFrames,
              identityText,
              keys.encryptKey,
            );
          } catch (error) {
            this.#emitAuthFailed(
              event,
              `推送 payload 解密失败：${error?.message ?? error}`,
            );
            return;
          }
        }
      } else {
        this.#ensureSlaveOnline(identityText, identity, { touch: true });
      }

      const finalPayload = payloadFromFrames(finalFrames);
      const pushEvent = {
        ...event,
        topic: parsed.topic,
        payload: finalPayload,
      };
      this.emit("push", pushEvent);
      return;
    }

    // ── RPC 请求：slave -> master ──────────────────────────────────────────
    if (parsed.kind === "request") {
      let finalFrames = parsed.payloadFrames;

      if (this.#secureEnabled) {
        const keys = this.#resolveSlaveKeys(identityText);
        if (!keys) {
          this.#emitAuthFailed(event, "未配置该 slave 的 authKey。");
          if (this.#slaves.delete(identityText)) {
            this.emit("slave_disconnected", identityText);
          }
          return;
        }

        const v = this.#verifyIncomingProof({
          kind: "request",
          proofToken: parsed.authKey, // request 复用 authKey 字段承载 proof
          requestId: parsed.requestId,
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: identityText,
          signKey: keys.signKey,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        // 认证通过后允许补注册（避免 master 重启后丢失在线表）
        this.#ensureSlaveOnline(identityText, identity, {
          touch: true,
          signKey: keys.signKey,
          encryptKey: keys.encryptKey,
        });

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "request",
              parsed.requestId,
              parsed.payloadFrames,
              identityText,
              keys.encryptKey,
            );
          } catch (error) {
            this.#emitAuthFailed(
              event,
              `请求 payload 解密失败：${error?.message ?? error}`,
            );
            return;
          }
        }
      } else {
        // 明文模式同样补注册
        this.#ensureSlaveOnline(identityText, identity, { touch: true });
      }

      const finalPayload = payloadFromFrames(finalFrames);
      const requestEvent = { ...event, payload: finalPayload };
      this.emit("request", requestEvent);

      if (this.#routerAutoHandler) {
        try {
          const replyPayload = await this.#routerAutoHandler(requestEvent);
          await this.#replyTo(identity, parsed.requestId, replyPayload);
        } catch (error) {
          this.emit("error", error);
        }
      }
      return;
    }

    // ── RPC 响应：slave -> master ──────────────────────────────────────────
    if (parsed.kind === "response") {
      let finalFrames = parsed.payloadFrames;

      if (this.#secureEnabled) {
        const keys = this.#resolveSlaveKeys(identityText);
        if (!keys) {
          this.#emitAuthFailed(event, "未配置该 slave 的 authKey。");
          if (this.#slaves.delete(identityText)) {
            this.emit("slave_disconnected", identityText);
          }
          return;
        }

        const v = this.#verifyIncomingProof({
          kind: "response",
          proofToken: parsed.authProof,
          requestId: parsed.requestId,
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: identityText,
          signKey: keys.signKey,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        // 认证通过后允许补注册（避免 master 重启后丢失在线表）
        this.#ensureSlaveOnline(identityText, identity, {
          touch: true,
          signKey: keys.signKey,
          encryptKey: keys.encryptKey,
        });

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "response",
              parsed.requestId,
              parsed.payloadFrames,
              identityText,
              keys.encryptKey,
            );
          } catch (error) {
            this.#emitAuthFailed(
              event,
              `响应 payload 解密失败：${error?.message ?? error}`,
            );
            return;
          }
        }
      } else {
        // 明文模式同样补注册
        this.#ensureSlaveOnline(identityText, identity, { touch: true });
      }

      const finalPayload = payloadFromFrames(finalFrames);
      const responseEvent = { ...event, payload: finalPayload };
      const key = this.#pending.key(parsed.requestId, identityText);
      this.#pending.resolve(key, responseEvent);
      this.emit("response", responseEvent);
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

    // ── 心跳应答：master -> slave ──────────────────────────────────────────
    if (parsed.kind === "heartbeat_ack") {
      if (this.#secureEnabled) {
        const v = this.#verifyIncomingProof({
          kind: "heartbeat_ack",
          proofToken: parsed.authProof,
          requestId: "",
          payloadFrames: [],
          expectedNodeId: this.#masterNodeId,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        if (!this.#masterNodeId) this.#masterNodeId = v.envelope.nodeId;
      }

      this.#confirmMasterReachable({ scheduleNextHeartbeat: true });
      return;
    }

    // ── PUB 广播：master -> slave ──────────────────────────────────────────
    if (parsed.kind === "publish") {
      let finalFrames = parsed.payloadFrames;

      if (this.#secureEnabled) {
        const v = this.#verifyIncomingProof({
          kind: "publish",
          proofToken: parsed.authProof,
          requestId: parsed.topic ?? "",
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: this.#masterNodeId,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        // 第一次学习 master 节点 ID，后续锁定
        if (!this.#masterNodeId) this.#masterNodeId = v.envelope.nodeId;

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "publish",
              parsed.topic ?? "",
              parsed.payloadFrames,
              this.#masterNodeId,
            );
          } catch (error) {
            this.#emitAuthFailed(
              event,
              `广播 payload 解密失败：${error?.message ?? error}`,
            );
            return;
          }
        }
      }

      this.#confirmMasterReachable({ scheduleNextHeartbeat: true });

      const finalPayload = payloadFromFrames(finalFrames);
      const pubEvent = { topic: parsed.topic, payload: finalPayload };

      this.emit("publish", pubEvent);

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

    // ── RPC 请求：master -> slave ──────────────────────────────────────────
    if (parsed.kind === "request") {
      let finalFrames = parsed.payloadFrames;

      if (this.#secureEnabled) {
        const v = this.#verifyIncomingProof({
          kind: "request",
          proofToken: parsed.authKey, // request 复用 authKey 字段承载 proof
          requestId: parsed.requestId,
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: this.#masterNodeId,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        if (!this.#masterNodeId) this.#masterNodeId = v.envelope.nodeId;

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "request",
              parsed.requestId,
              parsed.payloadFrames,
              this.#masterNodeId,
            );
          } catch (error) {
            this.#emitAuthFailed(
              event,
              `请求 payload 解密失败：${error?.message ?? error}`,
            );
            return;
          }
        }
      }

      this.#confirmMasterReachable({ scheduleNextHeartbeat: true });

      const finalPayload = payloadFromFrames(finalFrames);
      const requestEvent = { ...event, payload: finalPayload };
      this.emit("request", requestEvent);

      if (this.#dealerAutoHandler) {
        try {
          const replyPayload = await this.#dealerAutoHandler(requestEvent);
          await this.#reply(parsed.requestId, replyPayload);
        } catch (error) {
          this.emit("error", error);
        }
      }
      return;
    }

    // ── RPC 响应：master -> slave ──────────────────────────────────────────
    if (parsed.kind === "response") {
      let finalFrames = parsed.payloadFrames;

      if (this.#secureEnabled) {
        const v = this.#verifyIncomingProof({
          kind: "response",
          proofToken: parsed.authProof,
          requestId: parsed.requestId,
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: this.#masterNodeId,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        if (!this.#masterNodeId) this.#masterNodeId = v.envelope.nodeId;

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "response",
              parsed.requestId,
              parsed.payloadFrames,
              this.#masterNodeId,
            );
          } catch (error) {
            this.#emitAuthFailed(
              event,
              `响应 payload 解密失败：${error?.message ?? error}`,
            );
            return;
          }
        }
      }

      this.#confirmMasterReachable({ scheduleNextHeartbeat: true });

      const finalPayload = payloadFromFrames(finalFrames);
      const responseEvent = { ...event, payload: finalPayload };
      const key = this.#pending.key(parsed.requestId);
      this.#pending.resolve(key, responseEvent);
      this.emit("response", responseEvent);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RPC 请求发送（主动方向）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Slave → Master：通过 DEALER socket 发送 RPC 请求，返回响应 Promise
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

    const payloadFrames = this.#sealPayloadFrames(
      "request",
      requestId,
      payload,
    );
    const proofOrAuthKey = this.#secureEnabled
      ? this.#createAuthProof("request", requestId, payloadFrames)
      : "";

    const frames = buildRequestFrames(requestId, payloadFrames, proofOrAuthKey);

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

    const keys = this.#secureEnabled
      ? this.#resolveSlaveKeys(identityText)
      : null;
    if (this.#secureEnabled && !keys) {
      throw new Error(`未配置该 slave 的 authKey：${identityText}`);
    }

    const payloadFrames = this.#sealPayloadFrames(
      "request",
      requestId,
      payload,
      keys?.encryptKey ?? null,
    );
    const proofOrAuthKey = this.#secureEnabled
      ? this.#createAuthProof("request", requestId, payloadFrames, keys.signKey)
      : "";

    const frames = buildRequestFrames(requestId, payloadFrames, proofOrAuthKey);

    this.#sendQueue
      .enqueue("router", async () => {
        startTimer();
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

    const payloadFrames = this.#sealPayloadFrames(
      "response",
      requestId,
      payload,
    );
    const authProof = this.#secureEnabled
      ? this.#createAuthProof("response", requestId, payloadFrames)
      : "";

    const frames = buildResponseFrames(requestId, payloadFrames, authProof);
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
    const identityText = identityToString(identity);
    const idFrame = identityToBuffer(identity);

    const keys = this.#secureEnabled
      ? this.#resolveSlaveKeys(identityText)
      : null;
    if (this.#secureEnabled && !keys) {
      throw new Error(`未配置该 slave 的 authKey：${identityText}`);
    }

    const payloadFrames = this.#sealPayloadFrames(
      "response",
      requestId,
      payload,
      keys?.encryptKey ?? null,
    );
    const authProof = this.#secureEnabled
      ? this.#createAuthProof(
          "response",
          requestId,
          payloadFrames,
          keys.signKey,
        )
      : "";

    const frames = buildResponseFrames(requestId, payloadFrames, authProof);
    await this.#sendQueue.enqueue("router", () =>
      socket.send([idFrame, ...frames]),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  心跳（内部实现）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 创建并初始化 slave 侧 Dealer socket
   * 设计要点：
   * - immediate=true：仅向已完成连接的 pipe 发送，避免离线期间无限积压旧消息
   * - linger=0     ：关闭旧 socket 时直接丢弃残留发送队列，避免旧心跳回灌
   * - sendTimeout=0：尽力发送，当前不可发时立即失败，不阻塞重连/启动流程
   *
   * @returns {import("zeromq").Dealer}
   */
  #createDealerSocket() {
    const dealer = new zmq.Dealer({
      routingId: this.id,
      immediate: true,
      linger: 0,
      sendTimeout: 0,
      reconnectInterval: 200,
      reconnectMaxInterval: 1000,
    });

    dealer.connect(this.endpoints.router);
    this.#consume(dealer, (frames) => this.#handleDealerFrames(frames));
    return dealer;
  }

  /**
   * 尝试发送注册帧
   * 说明：
   * - 该操作是“尽力发送”，不阻塞启动流程
   * - master 未上线时允许静默失败，由后续 heartbeat_ack 驱动恢复
   */
  #trySendRegister() {
    if (this.role !== "slave" || !this.running || !this.#sockets.dealer) return;

    const registerToken = this.#secureEnabled
      ? this.#createAuthProof("register", "", [])
      : "";

    this.#sendQueue
      .enqueue("dealer", () =>
        this.#sockets.dealer.send(buildRegisterFrames(registerToken)),
      )
      .catch(() => {});
  }

  /**
   * 标记主节点已确认在线
   */
  #markMasterOnline() {
    this.#masterOnline = true;
    this.#lastMasterSeenAt = Date.now();
  }

  /**
   * 标记主节点离线，并清理当前等待中的心跳状态
   */
  #markMasterOffline() {
    this.#masterOnline = false;
    this.#lastMasterSeenAt = 0;
    this.#heartbeatWaitingAck = false;
    clearTimeout(this.#heartbeatAckTimer);
    this.#heartbeatAckTimer = null;
  }

  /**
   * 确认链路已打通
   * - heartbeat_ack 是最直接的确认信号
   * - 其他来自 master 的合法业务帧同样证明链路可达
   *
   * @param {{ scheduleNextHeartbeat?: boolean }} [options]
   */
  #confirmMasterReachable({ scheduleNextHeartbeat = false } = {}) {
    this.#markMasterOnline();

    if (!this.#heartbeatWaitingAck) return;

    this.#heartbeatWaitingAck = false;
    clearTimeout(this.#heartbeatAckTimer);
    this.#heartbeatAckTimer = null;

    if (scheduleNextHeartbeat && this.#heartbeatInterval > 0) {
      this.#scheduleNextHeartbeat();
    }
  }

  /**
   * 计算心跳应答超时时间
   * - 优先复用用户配置的 heartbeatTimeoutMs
   * - 未配置时回退到 interval × 2，且至少 1000ms
   */
  #resolveHeartbeatAckTimeoutMs() {
    if (this.#heartbeatTimeoutMs > 0) return this.#heartbeatTimeoutMs;
    return Math.max(this.#heartbeatInterval * 2, 1000);
  }

  /**
   * 调度下一次心跳发送（单飞模式）
   * - 任意时刻最多只允许一个未确认心跳在飞
   * - 只有收到 heartbeat_ack 或其他合法回流后，才会进入下一轮
   *
   * @param {number} [delayMs=this.#heartbeatInterval]
   */
  #scheduleNextHeartbeat(delayMs = this.#heartbeatInterval) {
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = setTimeout(
      () => {
        this.#sendHeartbeatOnce().catch((error) => this.emit("error", error));
      },
      Math.max(0, Number(delayMs) || 0),
    );
  }

  /**
   * 启动 slave 侧心跳发送流程
   * 实现方式：
   * - 启动时立即发送第一帧心跳
   * - 后续改为“发一条 → 等应答 → 再调度下一条”
   */
  #startHeartbeat() {
    if (this.role !== "slave" || this.#heartbeatInterval <= 0) return;

    this.#heartbeatWaitingAck = false;
    clearTimeout(this.#heartbeatAckTimer);
    this.#heartbeatAckTimer = null;
    this.#scheduleNextHeartbeat(0);
  }

  /**
   * 发送单次心跳，并进入等待应答状态
   */
  async #sendHeartbeatOnce() {
    if (
      !this.running ||
      this.role !== "slave" ||
      this.#heartbeatInterval <= 0 ||
      !this.#sockets.dealer ||
      this.#heartbeatWaitingAck
    ) {
      return;
    }

    const proof = this.#secureEnabled
      ? this.#createAuthProof("heartbeat", "", [])
      : "";

    // plain 模式仍保持历史帧结构 [CONTROL_PREFIX, CONTROL_HEARTBEAT]
    const frames = this.#secureEnabled
      ? buildHeartbeatFrames(proof)
      : [CONTROL_PREFIX, CONTROL_HEARTBEAT];

    this.#heartbeatWaitingAck = true;
    clearTimeout(this.#heartbeatAckTimer);
    this.#heartbeatAckTimer = setTimeout(() => {
      this.#onHeartbeatAckTimeout();
    }, this.#resolveHeartbeatAckTimeoutMs());

    try {
      await this.#sendQueue.enqueue("dealer", () =>
        this.#sockets.dealer.send(frames),
      );
    } catch {
      this.#onHeartbeatAckTimeout();
    }
  }

  /**
   * 心跳应答超时处理：
   * - 将主节点状态置为离线
   * - 主动重建 Dealer，丢弃旧连接残留消息
   */
  #onHeartbeatAckTimeout() {
    if (!this.running || this.role !== "slave" || !this.#heartbeatWaitingAck) {
      return;
    }

    this.#markMasterOffline();
    this.#restartDealer("heartbeat_ack_timeout").catch((error) =>
      this.emit("error", error),
    );
  }

  /**
   * 重建 slave 侧 Dealer 连接
   * 设计目标：
   * - 避免 master 重启后旧 socket 中残留的心跳/请求继续回灌
   * - 将重连控制为单次串行过程，避免并发 close/connect 造成状态抖动
   *
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async #restartDealer(reason = "reconnect") {
    if (this.role !== "slave" || !this.running) return;
    if (this.#dealerReconnectPromise) return this.#dealerReconnectPromise;

    this.#dealerReconnectPromise = (async () => {
      clearTimeout(this.#heartbeatTimer);
      clearTimeout(this.#heartbeatAckTimer);
      this.#heartbeatTimer = null;
      this.#heartbeatAckTimer = null;
      this.#heartbeatWaitingAck = false;
      this.#masterOnline = false;
      this.#lastMasterSeenAt = 0;

      this.#pending.rejectAll(
        new Error(
          `与主节点的连接已重建（reason=${String(reason)}），待处理请求已取消。`,
        ),
      );

      const oldDealer = this.#sockets.dealer;
      delete this.#sockets.dealer;

      // slave 侧发送队列只服务 dealer，重建时直接清空可避免旧任务继续写入旧 socket
      this.#sendQueue.clear();

      if (oldDealer) {
        try {
          oldDealer.close();
        } catch {}
      }

      const dealer = this.#createDealerSocket();
      this.#sockets.dealer = dealer;

      this.#trySendRegister();
      this.#startHeartbeat();
    })().finally(() => {
      this.#dealerReconnectPromise = null;
    });

    return this.#dealerReconnectPromise;
  }

  /**
   * 启动 master 侧死节点扫描定时器
   */
  #startHeartbeatCheck() {
    if (this.#heartbeatInterval <= 0) return;

    // 心跳超时：优先使用配置值，<=0 则回退到 interval × 3
    const timeout =
      this.#heartbeatTimeoutMs > 0
        ? this.#heartbeatTimeoutMs
        : this.#heartbeatInterval * 3;

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
  //  安全辅助（签名/防重放/加密）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 生成签名证明令牌
   *
   * @param {"register"|"heartbeat"|"heartbeat_ack"|"request"|"response"|"publish"|"push"} kind
   * @param {string} requestId
   * @param {Buffer[]} payloadFrames
   * @returns {string}
   */
  #createAuthProof(kind, requestId, payloadFrames, signKeyOverride = null) {
    const signKey = signKeyOverride ?? this.#signKey;
    if (!this.#secureEnabled || !signKey) return "";

    const envelope = {
      kind: String(kind),
      nodeId: this.id,
      requestId: String(requestId ?? ""),
      timestamp: nowMs(),
      nonce: generateNonce(),
      // 可选 payload 摘要：关闭时写空串以提升性能
      payloadDigest: this.#enablePayloadDigest
        ? digestFrames(payloadFrames)
        : "",
    };

    // 保留 canonical 文本，便于后续排障（签名实际在 token 内完成）
    canonicalSignInput(envelope);

    return encodeAuthProofToken(signKey, envelope);
  }

  /**
   * 校验入站签名证明 + 防重放 + 摘要一致性
   *
   * @param {{
   *   kind: "register"|"heartbeat"|"heartbeat_ack"|"request"|"response"|"publish"|"push",
   *   proofToken: string|null,
   *   requestId: string|null,
   *   payloadFrames: Buffer[],
   *   expectedNodeId?: string|null,
   * }} input
   * @returns {{ ok: true, envelope: any } | { ok: false, error: string }}
   */
  #verifyIncomingProof({
    kind,
    proofToken,
    requestId,
    payloadFrames,
    expectedNodeId = null,
    signKey = null,
  }) {
    if (!this.#secureEnabled) return { ok: true, envelope: null };

    const verifyKey = signKey ?? this.#signKey;
    if (!verifyKey) {
      return { ok: false, error: "签名密钥未初始化。" };
    }

    if (!proofToken) {
      return { ok: false, error: "缺少认证证明（proofToken）。" };
    }

    const decoded = decodeAuthProofToken(verifyKey, proofToken, {
      maxSkewMs: this.#maxTimeSkewMs,
      now: Date.now(),
    });
    if (!decoded.ok) {
      return { ok: false, error: decoded.error || "认证证明解析失败。" };
    }

    const envelope = decoded.envelope;

    if (envelope.kind !== String(kind)) {
      return {
        ok: false,
        error: `证明 kind 不匹配：expect=${kind}, got=${envelope.kind}`,
      };
    }

    if (String(envelope.requestId ?? "") !== String(requestId ?? "")) {
      return {
        ok: false,
        error: `证明 requestId 不匹配：expect=${requestId ?? ""}, got=${envelope.requestId ?? ""}`,
      };
    }

    if (expectedNodeId && String(envelope.nodeId) !== String(expectedNodeId)) {
      return {
        ok: false,
        error: `证明 nodeId 不匹配：expect=${expectedNodeId}, got=${envelope.nodeId}`,
      };
    }

    if (this.#enablePayloadDigest) {
      const currentDigest = digestFrames(payloadFrames);
      if (String(envelope.payloadDigest) !== currentDigest) {
        return { ok: false, error: "payload 摘要不一致，疑似篡改。" };
      }
    }

    // 重放 key 加入 requestId，降低 nonce 碰撞误杀风险
    const replayKey = `${envelope.kind}|${envelope.nodeId}|${envelope.requestId}|${envelope.nonce}`;
    if (this.#replayGuard.seenOrAdd(replayKey)) {
      return { ok: false, error: "检测到重放请求（nonce 重复）。" };
    }

    return { ok: true, envelope };
  }

  /**
   * 出站 payload 处理：
   * - plain/auth   : 维持原有 normalizeFrames
   * - encrypted    : 透明加密为安全信封
   *
   * @param {"request"|"response"|"publish"|"push"} kind
   * @param {string} requestId
   * @param {*} payload
   * @returns {Buffer[]}
   */
  #sealPayloadFrames(kind, requestId, payload, encryptKeyOverride = null) {
    if (!this.encrypted) {
      // 非加密模式保持历史行为：沿用协议层的原始帧类型（string/Buffer）
      return normalizeFrames(payload);
    }

    const encryptKey = encryptKeyOverride ?? this.#encryptKey;
    if (!encryptKey) {
      throw new Error("加密密钥未初始化。");
    }

    const rawFrames = toFrameBuffers(payload);
    const aad = Buffer.from(
      `znl-aad-v1|${String(kind)}|${String(this.id)}|${String(requestId ?? "")}`,
      "utf8",
    );

    const { iv, ciphertext, tag } = encryptFrames(encryptKey, rawFrames, aad);

    // 用统一信封包装：version + iv + tag + ciphertext
    return [Buffer.from(SECURITY_ENVELOPE_VERSION), iv, tag, ciphertext];
  }

  /**
   * 入站 payload 解封：
   * - encrypted=true 时要求收到加密信封
   * - 解密后恢复为 Buffer[]，再由 payloadFromFrames 还原
   *
   * @param {"request"|"response"|"publish"|"push"} kind
   * @param {string} requestId
   * @param {Buffer[]} payloadFrames
   * @param {string} senderNodeId
   * @returns {Buffer[]}
   */
  #openPayloadFrames(
    kind,
    requestId,
    payloadFrames,
    senderNodeId,
    encryptKeyOverride = null,
  ) {
    if (!this.encrypted) return payloadFrames;
    const encryptKey = encryptKeyOverride ?? this.#encryptKey;
    if (!encryptKey) throw new Error("加密密钥未初始化。");

    if (!Array.isArray(payloadFrames) || payloadFrames.length !== 4) {
      throw new Error("加密信封格式非法：期望 4 帧。");
    }

    const [version, iv, tag, ciphertext] = payloadFrames;
    if (String(version?.toString?.() ?? "") !== SECURITY_ENVELOPE_VERSION) {
      throw new Error("加密信封版本不匹配。");
    }

    const aad = Buffer.from(
      `znl-aad-v1|${String(kind)}|${String(senderNodeId)}|${String(requestId ?? "")}`,
      "utf8",
    );

    return decryptFrames(encryptKey, iv, ciphertext, tag, aad);
  }

  /**
   * 触发统一 auth_failed 事件
   * @param {object} baseEvent
   * @param {string} reason
   */
  #emitAuthFailed(baseEvent, reason) {
    this.emit("auth_failed", {
      ...baseEvent,
      reason: String(reason ?? "认证失败"),
      encrypted: this.encrypted,
    });
  }

  /**
   * master 侧确保某个 slave 已登记在线
   * - 仅在认证通过后调用
   * - 支持心跳/请求/响应等路径的自动补注册
   *
   * @param {string} identityText
   * @param {Buffer|string|Uint8Array} identity
   * @param {{ touch?: boolean }} [options]
   */
  #ensureSlaveOnline(
    identityText,
    identity,
    { touch = true, signKey = null, encryptKey = null } = {},
  ) {
    const id = String(identityText ?? "");
    if (!id) return;

    const now = Date.now();
    const entry = this.#slaves.get(id);
    if (entry) {
      if (touch) entry.lastSeen = now;
      if (signKey) entry.signKey = signKey;
      if (encryptKey) entry.encryptKey = encryptKey;
      return;
    }

    this.#slaves.set(id, {
      identity: identityToBuffer(identity),
      lastSeen: now,
      signKey: signKey ?? null,
      encryptKey: encryptKey ?? null,
    });
    this.emit("slave_connected", id);
  }

  /**
   * master 侧解析某个 slave 的签名/加密密钥
   * - 优先匹配 authKeyMap
   * - 未命中时回退到 this.authKey（若提供）
   *
   * @param {string} slaveId
   * @returns {{ signKey: Buffer, encryptKey: Buffer }|null}
   */
  #resolveSlaveKeys(slaveId) {
    if (!this.#secureEnabled) return null;

    const id = String(slaveId ?? "");
    if (!id) return null;

    const cached = this.#slaveKeyCache.get(id);
    if (cached) return cached;

    let key = this.#authKeyMap.get(id);
    if (!key && this.authKey) {
      key = this.authKey;
    }
    if (!key) return null;

    const derived = deriveKeys(key);
    this.#slaveKeyCache.set(id, derived);

    const entry = this.#slaves.get(id);
    if (entry) {
      entry.signKey = derived.signKey;
      entry.encryptKey = derived.encryptKey;
    }

    return derived;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  工具方法
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 启动 socket 的异步读取循环（for-await-of）
   * @param {import("zeromq").Socket} socket
   * @param {(frames: Array) => Promise<void>} handler
   */
  #consume(socket, handler) {
    const loop = (async () => {
      try {
        for await (const rawFrames of socket) {
          if (!this.running) return;
          const frames = Array.isArray(rawFrames) ? rawFrames : [rawFrames];
          try {
            await handler(frames);
          } catch (error) {
            this.emit("error", error);
          }
        }
      } catch (error) {
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
   * @returns {object}
   */
  #buildAndEmit(channel, frames, extra = {}) {
    const event = { channel, frames, ...extra };
    this.emit(channel, event);
    this.emit("message", event);
    return event;
  }

  /**
   * 获取指定 socket，不存在时抛出明确错误
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

  /**
   * 规范化正整数（<=0 时回退默认值）
   * @param {*} n
   * @param {number} fallback
   * @returns {number}
   */
  #normalizePositiveInt(n, fallback) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
    return fallback;
  }
}
