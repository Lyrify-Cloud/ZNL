import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as zmq from "zeromq";

const DEFAULT_ENDPOINTS = {
  pub: "tcp://127.0.0.1:6002",
  router: "tcp://127.0.0.1:6003",
};

const DEFAULT_TOPIC = "";
const DEFAULT_TIMEOUT_MS = 5000;
const EMPTY_BUFFER = Buffer.alloc(0);

// request/response 的内部控制帧（仅 request API 使用）
const CONTROL_PREFIX = "__zmqnode_v1__";
const CONTROL_REQ = "req";
const CONTROL_RES = "res";
const CONTROL_AUTH = "__zmqnode_v1_auth__";

export class ZmqClusterNode extends EventEmitter {
  constructor({
    role,
    id,
    endpoints = {},
    subscribeTopics = [DEFAULT_TOPIC],
    maxPending = 0,
    authKey = "",
  } = {}) {
    super();

    if (!role || (role !== "master" && role !== "slave")) {
      throw new Error('`role` 必须是 "master" 或 "slave"。');
    }
    if (!id) {
      throw new Error("`id` 不能为空。");
    }

    this.role = role;
    this.id = String(id);
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this.subscribeTopics = subscribeTopics.length
      ? subscribeTopics
      : [DEFAULT_TOPIC];

    this.running = false;
    this.sockets = {};
    this.readLoops = [];
    this.startPromise = null;
    this.stopPromise = null;

    // key => { resolve, reject, timer }
    this.pending = new Map();
    this.maxPending = this.#normalizeMaxPending(maxPending);
    this.authKey = this.#normalizeAuthKey(authKey);
    this.requireAuth = this.role === "master" && this.authKey.length > 0;

    // 各 socket 的发送队列（解决 ZeroMQ 同 socket 并发 send 的 EBUSY）
    this.sendQueues = new Map();

    // 自动请求处理函数（可选）
    this.routerAutoHandler = null;
    this.dealerAutoHandler = null;
  }

  // 启动节点：按角色自动创建并连接/绑定对应 socket。
  async start() {
    if (this.running) return;

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    if (this.stopPromise) {
      await this.stopPromise;
    }

    this.startPromise = (async () => {
      this.running = true;

      try {
        if (this.role === "master") {
          await this.#startMasterSockets();
        } else {
          await this.#startSlaveSockets();
        }
      } catch (error) {
        this.running = false;
        await this.#closeAllSockets();
        await Promise.allSettled(this.readLoops);
        this.readLoops = [];
        this.sockets = {};
        this.sendQueues.clear();
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();

    await this.startPromise;
  }

  // 停止节点：关闭全部 socket，并取消未完成请求。
  async stop() {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }

    if (!this.running && Object.keys(this.sockets).length === 0) {
      return;
    }

    this.stopPromise = (async () => {
      this.running = false;
      this.#rejectAllPending(new Error("节点已停止，未完成请求已取消。"));
      await this.#closeAllSockets();
      await Promise.allSettled(this.readLoops);

      this.readLoops = [];
      this.sockets = {};
      this.sendQueues.clear();
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  // 对外 API：PUB（master 广播）
  async PUB(topic = DEFAULT_TOPIC, payload = EMPTY_BUFFER) {
    const socket = this.#getSocket("pub", "PUB");
    const frames = this.#normalizeFrames(payload);
    await this.#sendQueued("pub", () => socket.send([topic, ...frames]));
  }

  // 内部请求：slave 侧自动 requestId + 自动等待 response + 自动超时。
  async #request(payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const socket = this.#getSocket("dealer", "DEALER");
    this.#ensurePendingCapacity();

    const requestId = randomUUID();
    const key = this.#pendingKey(requestId);
    const pending = this.#createPending(key, timeoutMs, requestId);
    const payloadFrames = this.#normalizeFrames(payload);
    const requestFrames = this.#buildRequestFrames(requestId, payloadFrames);

    // 注意：超时从“真正开始发送”算起，避免大并发排队时被提前超时。
    this.#sendQueued("dealer", async () => {
      pending.startTimer();
      await socket.send(requestFrames);
    }).catch((error) => {
      this.#rejectPending(key, error);
    });

    return pending.promise;
  }

  // 内部请求：master 侧请求指定 identity，自动 requestId/匹配/超时。
  async #requestTo(identity, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const socket = this.#getSocket("router", "ROUTER");
    this.#ensurePendingCapacity();

    const identityText = this.#identityToString(identity);
    const requestId = randomUUID();
    const key = this.#pendingKey(requestId, identityText);
    const pending = this.#createPending(
      key,
      timeoutMs,
      requestId,
      identityText
    );
    const idFrame = this.#identityToBuffer(identity);
    const payloadFrames = this.#normalizeFrames(payload);
    const requestFrames = this.#buildRequestFrames(requestId, payloadFrames);

    // 注意：超时从“真正开始发送”算起，避免大并发排队时被提前超时。
    this.#sendQueued("router", async () => {
      pending.startTimer();
      await socket.send([
        idFrame,
        ...requestFrames,
      ]);
    }).catch((error) => {
      this.#rejectPending(key, error);
    });

    return pending.promise;
  }

  // 高层 API：slave 侧一行发起请求并等待响应，不用自己管 requestId。
  async DEALER(payloadOrHandler, options = {}) {
    if (typeof payloadOrHandler === "function") {
      this.dealerAutoHandler = payloadOrHandler;
      return;
    }

    const response = await this.#request(payloadOrHandler, options);
    return response.payload;
  }

  // 高层 API：
  // 1) 传函数 => master 自动处理来自 dealer 的请求并自动回包
  // 2) 传 identity + payload => master 主动发起请求并等待响应
  async ROUTER(identityOrHandler, payload, options = {}) {
    if (typeof identityOrHandler === "function") {
      this.routerAutoHandler = identityOrHandler;
      return;
    }

    const response = await this.#requestTo(identityOrHandler, payload, options);
    return response.payload;
  }

  // 内部回包：slave 侧回复 request（配合 requestId）。
  async #reply(requestId, payload) {
    const socket = this.#getSocket("dealer", "DEALER");
    const frames = this.#normalizeFrames(payload);

    await this.#sendQueued("dealer", () =>
      socket.send([
        CONTROL_PREFIX,
        CONTROL_RES,
        String(requestId),
        ...frames,
      ])
    );
  }

  // 内部回包：master 侧回复某个 identity 的 request（配合 requestId）。
  async #replyTo(identity, requestId, payload) {
    const socket = this.#getSocket("router", "ROUTER");
    const idFrame = this.#identityToBuffer(identity);
    const frames = this.#normalizeFrames(payload);

    await this.#sendQueued("router", () =>
      socket.send([
        idFrame,
        CONTROL_PREFIX,
        CONTROL_RES,
        String(requestId),
        ...frames,
      ])
    );
  }

  // 对外 API：SUB（slave 订阅）
  SUB(topic) {
    const sub = this.#getSocket("sub", "SUB");
    sub.subscribe(topic ?? DEFAULT_TOPIC);
  }

  async #startMasterSockets() {
    const pub = new zmq.Publisher();
    await pub.bind(this.endpoints.pub);
    this.sockets.pub = pub;

    const router = new zmq.Router();
    await router.bind(this.endpoints.router);
    this.sockets.router = router;

    this.#consume(router, async (frames) => {
      const identity = frames[0];
      const identityText = this.#identityToString(identity);

      const bodyFrames = frames.slice(1);
      const parsed = this.#parseControlFrames(bodyFrames);
      const payload = this.#payloadFromFrames(parsed.payloadFrames);

      const event = this.#emitMessage("router", frames, {
        identity,
        identityText,
        kind: parsed.kind,
        requestId: parsed.requestId,
        authKey: parsed.authKey,
        payloadFrames: parsed.payloadFrames,
        payload,
      });

      if (parsed.kind === "request") {
        if (this.requireAuth && parsed.authKey !== this.authKey) {
          this.emit("auth_failed", {
            ...event,
            expectedAuthKey: this.authKey,
          });
          return;
        }

        this.emit("request", event);

        if (this.routerAutoHandler) {
          try {
            const replyPayload = await this.routerAutoHandler(event);
            await this.#replyTo(identity, parsed.requestId, replyPayload);
          } catch (error) {
            this.emit("error", error);
          }
        }
      }

      if (parsed.kind === "response") {
        const key = this.#pendingKey(parsed.requestId, identityText);
        this.#resolvePending(key, event);
        this.emit("response", event);
      }
    });
  }

  async #startSlaveSockets() {
    const sub = new zmq.Subscriber();
    sub.connect(this.endpoints.pub);
    for (const topic of this.subscribeTopics) {
      sub.subscribe(topic);
    }
    this.sockets.sub = sub;

    this.#consume(sub, (frames) => {
      const topic = frames[0]?.toString() ?? DEFAULT_TOPIC;
      const payloadFrames = frames.slice(1);
      const payload = this.#payloadFromFrames(payloadFrames);

      this.#emitMessage("sub", frames, {
        topic,
        kind: "message",
        requestId: null,
        payloadFrames,
        payload,
      });
    });

    const dealer = new zmq.Dealer({ routingId: this.id });
    dealer.connect(this.endpoints.router);
    this.sockets.dealer = dealer;

    this.#consume(dealer, async (frames) => {
      const parsed = this.#parseControlFrames(frames);
      const payload = this.#payloadFromFrames(parsed.payloadFrames);

      const event = this.#emitMessage("dealer", frames, {
        kind: parsed.kind,
        requestId: parsed.requestId,
        authKey: parsed.authKey,
        payloadFrames: parsed.payloadFrames,
        payload,
      });

      if (parsed.kind === "request") {
        this.emit("request", event);

        if (this.dealerAutoHandler) {
          try {
            const replyPayload = await this.dealerAutoHandler(event);
            await this.#reply(parsed.requestId, replyPayload);
          } catch (error) {
            this.emit("error", error);
          }
        }
      }

      if (parsed.kind === "response") {
        const key = this.#pendingKey(parsed.requestId);
        this.#resolvePending(key, event);
        this.emit("response", event);
      }
    });
  }

  // 统一消费 socket 帧，异常通过 error 事件抛给业务层。
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

    this.readLoops.push(loop);
  }

  #emitMessage(channel, frames, extra = {}) {
    const payload = { channel, frames, ...extra };
    this.emit(channel, payload);
    this.emit("message", payload);
    return payload;
  }

  #parseControlFrames(frames) {
    if (frames.length >= 3 && frames[0]?.toString() === CONTROL_PREFIX) {
      const action = frames[1]?.toString();
      const requestId = frames[2]?.toString();

      if ((action === CONTROL_REQ || action === CONTROL_RES) && requestId) {
        let payloadStart = 3;
        let authKey = null;

        if (
          action === CONTROL_REQ &&
          frames.length >= 5 &&
          frames[3]?.toString() === CONTROL_AUTH
        ) {
          authKey = frames[4]?.toString() ?? "";
          payloadStart = 5;
        }

        return {
          kind: action === CONTROL_REQ ? "request" : "response",
          requestId,
          authKey,
          payloadFrames: frames.slice(payloadStart),
        };
      }
    }

    return {
      kind: "message",
      requestId: null,
      authKey: null,
      payloadFrames: frames,
    };
  }

  #payloadFromFrames(frames) {
    if (!frames || frames.length === 0) return EMPTY_BUFFER;
    if (frames.length === 1) return frames[0];
    return frames;
  }

  #normalizeFrames(payload) {
    if (Array.isArray(payload)) {
      return payload.map((item) => this.#normalizeFrame(item));
    }
    return [this.#normalizeFrame(payload)];
  }

  #normalizeFrame(frame) {
    if (frame == null) return EMPTY_BUFFER;
    if (typeof frame === "string") return frame;
    if (Buffer.isBuffer(frame)) return frame;
    if (frame instanceof Uint8Array) return Buffer.from(frame);

    throw new TypeError(
      "payload 仅支持 string / Buffer / Uint8Array（或这些类型组成的数组）。"
    );
  }

  #buildRequestFrames(requestId, payloadFrames) {
    const frames = [CONTROL_PREFIX, CONTROL_REQ, requestId];
    if (this.authKey) {
      frames.push(CONTROL_AUTH, this.authKey);
    }
    return [...frames, ...payloadFrames];
  }

  #pendingKey(requestId, identityText = "") {
    return identityText ? `${identityText}::${requestId}` : String(requestId);
  }

  #ensurePendingCapacity() {
    if (this.maxPending === 0) return;
    if (this.pending.size < this.maxPending) return;

    throw new Error(
      `请求过载: pending=${this.pending.size}, maxPending=${this.maxPending}`
    );
  }

  #createPending(key, timeoutMs, requestId, identityText = "") {
    const ms = this.#normalizeTimeout(timeoutMs);
    const entry = {
      resolve: () => {},
      reject: () => {},
      timer: null,
    };

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    const startTimer = () => {
      if (entry.timer) return;

      entry.timer = setTimeout(() => {
        this.pending.delete(key);
        entry.reject(
          new Error(
            identityText
              ? `请求超时: requestId=${requestId}, identity=${identityText}`
              : `请求超时: requestId=${requestId}`
          )
        );
      }, ms);
    };

    this.pending.set(key, entry);
    return { promise, startTimer };
  }

  #resolvePending(key, value) {
    const item = this.pending.get(key);
    if (!item) return false;

    clearTimeout(item.timer);
    this.pending.delete(key);
    item.resolve(value);
    return true;
  }

  #rejectPending(key, error) {
    const item = this.pending.get(key);
    if (!item) return false;

    clearTimeout(item.timer);
    this.pending.delete(key);
    item.reject(error);
    return true;
  }

  #rejectAllPending(error) {
    for (const [key, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(error);
      this.pending.delete(key);
    }
  }

  // 按 socket 串行发送，避免 "Socket is busy writing"。
  async #sendQueued(key, sendTask) {
    const tail = this.sendQueues.get(key) ?? Promise.resolve();
    const run = tail.then(() => sendTask(), () => sendTask());
    this.sendQueues.set(key, run.catch(() => {}));
    return run;
  }

  async #closeAllSockets() {
    for (const socket of Object.values(this.sockets)) {
      try {
        socket.close();
      } catch {}
    }
  }

  #getSocket(name, displayName) {
    const socket = this.sockets[name];
    if (!socket) {
      throw new Error(`${displayName} socket 未就绪。`);
    }
    return socket;
  }

  #normalizeTimeout(timeoutMs) {
    const n = Number(timeoutMs);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
    return n;
  }

  #normalizeMaxPending(maxPending) {
    const n = Number(maxPending);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  #normalizeAuthKey(authKey) {
    if (authKey == null) return "";
    return String(authKey);
  }

  #identityToString(identity) {
    return Buffer.isBuffer(identity) ? identity.toString() : String(identity);
  }

  #identityToBuffer(identity) {
    if (Buffer.isBuffer(identity)) return identity;
    if (identity instanceof Uint8Array) return Buffer.from(identity);
    return Buffer.from(String(identity));
  }
}

