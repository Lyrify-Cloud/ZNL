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
  buildRequestFrames,
  buildResponseFrames,
  buildPublishFrames,
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

  // ─── PUB/SUB 状态 ────────────────────────────────────────────────────────

  /**
   * master 侧：已注册的在线 slave 表
   * key   = slaveId（字符串）
   * value = { identity: Buffer, lastSeen: number }
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

    this.encrypted = Boolean(encrypted);
    this.#secureEnabled = this.encrypted;

    if (this.#secureEnabled) {
      if (!this.authKey) {
        throw new Error("启用 encrypted=true 时，必须提供非空 authKey。");
      }
      const { signKey, encryptKey } = deriveKeys(this.authKey);
      this.#signKey = signKey;
      this.#encryptKey = encryptKey;
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

    const topicText = String(topic);
    const payloadFrames = this.#sealPayloadFrames(
      "publish",
      topicText,
      payload,
    );
    const authProof = this.#secureEnabled
      ? this.#createAuthProof("publish", topicText, payloadFrames)
      : "";

    const frames = buildPublishFrames(topicText, payloadFrames, authProof);

    for (const [slaveId, entry] of this.#slaves) {
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
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;

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
    this.#slaves.clear();
    this.#masterNodeId = null;
    this.#replayGuard.clear();
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
    const dealer = new zmq.Dealer({ routingId: this.id });
    dealer.connect(this.endpoints.router);
    this.#sockets.dealer = dealer;

    this.#consume(dealer, (frames) => this.#handleDealerFrames(frames));

    // 注册帧：
    // - encrypted=true  : 发送签名证明令牌（放在 authKey 字段位）
    // - encrypted=false : 不携带认证信息
    const registerToken = this.#secureEnabled
      ? this.#createAuthProof("register", "", [])
      : "";

    await this.#sendQueue.enqueue("dealer", () =>
      dealer.send(buildRegisterFrames(registerToken)),
    );

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
      if (this.#secureEnabled) {
        const v = this.#verifyIncomingProof({
          kind: "heartbeat",
          proofToken: parsed.authProof,
          requestId: "",
          payloadFrames: [],
          expectedNodeId: identityText,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }
      }

      // 心跳视为在线确认：必要时自动补注册
      this.#ensureSlaveOnline(identityText, identity, { touch: true });
      return;
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    if (parsed.kind === "register") {
      if (this.#secureEnabled) {
        const v = this.#verifyIncomingProof({
          kind: "register",
          proofToken: parsed.authKey, // register 复用 authKey 字段承载 proof
          requestId: "",
          payloadFrames: [],
          expectedNodeId: identityText,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }
      }

      this.#slaves.set(identityText, { identity, lastSeen: Date.now() });
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

    // ── RPC 请求：slave -> master ──────────────────────────────────────────
    if (parsed.kind === "request") {
      let finalFrames = parsed.payloadFrames;

      if (this.#secureEnabled) {
        const v = this.#verifyIncomingProof({
          kind: "request",
          proofToken: parsed.authKey, // request 复用 authKey 字段承载 proof
          requestId: parsed.requestId,
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: identityText,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        // 认证通过后允许补注册（避免 master 重启后丢失在线表）
        this.#ensureSlaveOnline(identityText, identity, { touch: true });

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "request",
              parsed.requestId,
              parsed.payloadFrames,
              identityText,
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
        const v = this.#verifyIncomingProof({
          kind: "response",
          proofToken: parsed.authProof,
          requestId: parsed.requestId,
          payloadFrames: parsed.payloadFrames,
          expectedNodeId: identityText,
        });
        if (!v.ok) {
          this.#emitAuthFailed(event, v.error);
          return;
        }

        // 认证通过后允许补注册（避免 master 重启后丢失在线表）
        this.#ensureSlaveOnline(identityText, identity, { touch: true });

        if (this.encrypted) {
          try {
            finalFrames = this.#openPayloadFrames(
              "response",
              parsed.requestId,
              parsed.payloadFrames,
              identityText,
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
    const idFrame = identityToBuffer(identity);

    const payloadFrames = this.#sealPayloadFrames(
      "response",
      requestId,
      payload,
    );
    const authProof = this.#secureEnabled
      ? this.#createAuthProof("response", requestId, payloadFrames)
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
   * 启动 slave 侧心跳发送定时器
   */
  #startHeartbeat() {
    if (this.#heartbeatInterval <= 0) return;

    this.#heartbeatTimer = setInterval(() => {
      if (!this.running || !this.#sockets.dealer) return;

      const proof = this.#secureEnabled
        ? this.#createAuthProof("heartbeat", "", [])
        : "";

      // plain 模式仍保持历史帧结构 [CONTROL_PREFIX, CONTROL_HEARTBEAT]
      const frames = this.#secureEnabled
        ? buildHeartbeatFrames(proof)
        : [CONTROL_PREFIX, CONTROL_HEARTBEAT];

      this.#sendQueue
        .enqueue("dealer", () => this.#sockets.dealer.send(frames))
        .catch(() => {});
    }, this.#heartbeatInterval);
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
   * @param {"register"|"heartbeat"|"request"|"response"|"publish"} kind
   * @param {string} requestId
   * @param {Buffer[]} payloadFrames
   * @returns {string}
   */
  #createAuthProof(kind, requestId, payloadFrames) {
    if (!this.#secureEnabled || !this.#signKey) return "";

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

    return encodeAuthProofToken(this.#signKey, envelope);
  }

  /**
   * 校验入站签名证明 + 防重放 + 摘要一致性
   *
   * @param {{
   *   kind: "register"|"heartbeat"|"request"|"response"|"publish",
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
  }) {
    if (!this.#secureEnabled) return { ok: true, envelope: null };
    if (!this.#signKey) {
      return { ok: false, error: "签名密钥未初始化。" };
    }

    if (!proofToken) {
      return { ok: false, error: "缺少认证证明（proofToken）。" };
    }

    const decoded = decodeAuthProofToken(this.#signKey, proofToken, {
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
   * @param {"request"|"response"|"publish"} kind
   * @param {string} requestId
   * @param {*} payload
   * @returns {Buffer[]}
   */
  #sealPayloadFrames(kind, requestId, payload) {
    if (!this.encrypted) {
      // 非加密模式保持历史行为：沿用协议层的原始帧类型（string/Buffer）
      return normalizeFrames(payload);
    }

    if (!this.#encryptKey) {
      throw new Error("加密密钥未初始化。");
    }

    const rawFrames = toFrameBuffers(payload);
    const aad = Buffer.from(
      `znl-aad-v1|${String(kind)}|${String(this.id)}|${String(requestId ?? "")}`,
      "utf8",
    );

    const { iv, ciphertext, tag } = encryptFrames(
      this.#encryptKey,
      rawFrames,
      aad,
    );

    // 用统一信封包装：version + iv + tag + ciphertext
    return [Buffer.from(SECURITY_ENVELOPE_VERSION), iv, tag, ciphertext];
  }

  /**
   * 入站 payload 解封：
   * - encrypted=true 时要求收到加密信封
   * - 解密后恢复为 Buffer[]，再由 payloadFromFrames 还原
   *
   * @param {"request"|"response"|"publish"} kind
   * @param {string} requestId
   * @param {Buffer[]} payloadFrames
   * @param {string} senderNodeId
   * @returns {Buffer[]}
   */
  #openPayloadFrames(kind, requestId, payloadFrames, senderNodeId) {
    if (!this.encrypted) return payloadFrames;
    if (!this.#encryptKey) throw new Error("加密密钥未初始化。");

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

    return decryptFrames(this.#encryptKey, iv, ciphertext, tag, aad);
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
  #ensureSlaveOnline(identityText, identity, { touch = true } = {}) {
    const id = String(identityText ?? "");
    if (!id) return;

    const now = Date.now();
    const entry = this.#slaves.get(id);
    if (entry) {
      if (touch) entry.lastSeen = now;
      return;
    }

    this.#slaves.set(id, {
      identity: identityToBuffer(identity),
      lastSeen: now,
    });
    this.emit("slave_connected", id);
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
