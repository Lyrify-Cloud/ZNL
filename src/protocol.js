/**
 * ZMQ 帧协议层
 *
 * 负责所有帧的构建与解析，全部为纯函数，无副作用。
 *
 * 控制帧格式：
 *   注册帧：     [PREFIX, "register", (AUTH_MARKER, authKey)?]
 *   注销帧：     [PREFIX, "unregister"]
 *   心跳帧：     [PREFIX, "heartbeat", (AUTH_MARKER, authProof)?]
 *   心跳应答帧： [PREFIX, "heartbeat_ack", (AUTH_MARKER, authProof)?]
 *   请求帧：     [PREFIX, "req", requestId, (AUTH_MARKER, authKey)?, ...payload]
 *   响应帧：     [PREFIX, "res", requestId, ...payload]
 *   广播帧：     [PREFIX, "pub", topic, ...payload]
 *   推送帧：     [PREFIX, "push", topic, ...payload]
 *   Router 侧额外在最前面加一帧：[identity, ...]
 */

import {
  CONTROL_PREFIX,
  CONTROL_REQ,
  CONTROL_RES,
  CONTROL_AUTH,
  CONTROL_REGISTER,
  CONTROL_UNREGISTER,
  CONTROL_PUB,
  CONTROL_PUSH,
  CONTROL_HEARTBEAT,
  CONTROL_HEARTBEAT_ACK,
  EMPTY_BUFFER,
} from "./constants.js";

// ─── Identity 工具 ────────────────────────────────────────────────────────────

/**
 * 将 identity 帧转换为可读字符串（用于日志和 Map key）
 * @param {Buffer|string} identity
 * @returns {string}
 */
export function identityToString(identity) {
  return Buffer.isBuffer(identity) ? identity.toString() : String(identity);
}

/**
 * 将 identity 转换为 Buffer（ZMQ 帧要求 Buffer 格式）
 * @param {Buffer|Uint8Array|string} identity
 * @returns {Buffer}
 */
export function identityToBuffer(identity) {
  if (Buffer.isBuffer(identity)) return identity;
  if (identity instanceof Uint8Array) return Buffer.from(identity);
  return Buffer.from(String(identity));
}

// ─── Payload 工具 ─────────────────────────────────────────────────────────────

/**
 * 标准化单个帧为 ZMQ 可传输的格式
 * - null/undefined → 空 Buffer
 * - string         → 原样保留
 * - Buffer         → 原样保留
 * - Uint8Array     → 转为 Buffer
 * - 其他           → 抛出 TypeError
 * @param {string|Buffer|Uint8Array|null|undefined} frame
 * @returns {string|Buffer}
 */
export function normalizeFrame(frame) {
  if (frame == null) return EMPTY_BUFFER;
  if (typeof frame === "string") return frame;
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof Uint8Array) return Buffer.from(frame);
  throw new TypeError(
    "payload 仅支持 string / Buffer / Uint8Array（或它们的数组）。",
  );
}

/**
 * 将 payload 标准化为帧数组
 * 数组类型逐项标准化，非数组包装成单元素数组
 * @param {string|Buffer|Uint8Array|Array} payload
 * @returns {Array<string|Buffer>}
 */
export function normalizeFrames(payload) {
  if (Array.isArray(payload)) return payload.map(normalizeFrame);
  return [normalizeFrame(payload)];
}

/**
 * 从帧数组中提取 payload
 * - 空帧组 → 空 Buffer
 * - 单帧   → 直接返回（避免不必要的数组包装）
 * - 多帧   → 返回数组（多帧 payload 原样保留）
 * @param {Array} frames
 * @returns {Buffer|Array}
 */
export function payloadFromFrames(frames) {
  if (!frames?.length) return EMPTY_BUFFER;
  return frames.length === 1 ? frames[0] : frames;
}

// ─── 帧构建 ───────────────────────────────────────────────────────────────────

/**
 * 构建注册控制帧数组（slave → master，连接时自动发送）
 * 帧结构：[PREFIX, "register", (AUTH_MARKER, authKey)?]
 * @param {string} [authKey] - 可选认证 Key
 * @returns {Array}
 */
export function buildRegisterFrames(authKey = "") {
  const frames = [CONTROL_PREFIX, CONTROL_REGISTER];
  if (authKey) frames.push(CONTROL_AUTH, authKey);
  return frames;
}

/**
 * 构建注销控制帧数组（slave → master，断开时自动发送）
 * 帧结构：[PREFIX, "unregister"]
 * @returns {Array}
 */
export function buildUnregisterFrames() {
  return [CONTROL_PREFIX, CONTROL_UNREGISTER];
}

/**
 * 构建请求控制帧数组
 * 帧结构：[PREFIX, "req", requestId, (AUTH_MARKER, authKey)?, ...payloadFrames]
 * @param {string} requestId - UUID
 * @param {Array<string|Buffer>} payloadFrames - 已标准化的 payload 帧
 * @param {string} [authKey] - 可选认证 Key
 * @returns {Array}
 */
export function buildRequestFrames(requestId, payloadFrames, authKey = "") {
  const header = [CONTROL_PREFIX, CONTROL_REQ, requestId];
  if (authKey) header.push(CONTROL_AUTH, authKey);
  return [...header, ...payloadFrames];
}

/**
 * 构建响应控制帧数组
 * 帧结构：[PREFIX, "res", requestId, (AUTH_MARKER, authProof)?, ...payloadFrames]
 *
 * 说明：
 * - `authProof` 是可选的认证证明（例如签名令牌），与 `authKey` 概念不同。
 * - 不传时与历史协议完全兼容。
 *
 * @param {string} requestId
 * @param {Array<string|Buffer>} payloadFrames
 * @param {string} [authProof] - 可选认证证明
 * @returns {Array}
 */
export function buildResponseFrames(requestId, payloadFrames, authProof = "") {
  const header = [CONTROL_PREFIX, CONTROL_RES, String(requestId)];
  if (authProof) header.push(CONTROL_AUTH, authProof);
  return [...header, ...payloadFrames];
}

/**
 * 构建广播控制帧数组（master → slave）
 * 帧结构：[PREFIX, "pub", topic, (AUTH_MARKER, authProof)?, ...payloadFrames]
 *
 * 说明：
 * - `authProof` 是可选的认证证明（例如签名令牌）。
 * - 不传时与历史协议完全兼容。
 *
 * @param {string} topic - 消息主题
 * @param {Array<string|Buffer>} payloadFrames - 已标准化的 payload 帧
 * @param {string} [authProof] - 可选认证证明
 * @returns {Array}
 */
export function buildPublishFrames(topic, payloadFrames, authProof = "") {
  const header = [CONTROL_PREFIX, CONTROL_PUB, String(topic)];
  if (authProof) header.push(CONTROL_AUTH, authProof);
  return [...header, ...payloadFrames];
}

/**
 * 构建推送控制帧数组（slave → master）
 * 帧结构：[PREFIX, "push", topic, (AUTH_MARKER, authProof)?, ...payloadFrames]
 *
 * 说明：
 * - `authProof` 是可选的认证证明（例如签名令牌）。
 * - 不传时与历史协议完全兼容。
 *
 * @param {string} topic - 消息主题
 * @param {Array<string|Buffer>} payloadFrames - 已标准化的 payload 帧
 * @param {string} [authProof] - 可选认证证明
 * @returns {Array}
 */
export function buildPushFrames(topic, payloadFrames, authProof = "") {
  const header = [CONTROL_PREFIX, CONTROL_PUSH, String(topic)];
  if (authProof) header.push(CONTROL_AUTH, authProof);
  return [...header, ...payloadFrames];
}

/**
 * 构建心跳控制帧数组（slave → master）
 * 帧结构：[PREFIX, "heartbeat", (AUTH_MARKER, authProof)?]
 *
 * @param {string} [authProof] - 可选认证证明
 * @returns {Array}
 */
export function buildHeartbeatFrames(authProof = "") {
  const frames = [CONTROL_PREFIX, CONTROL_HEARTBEAT];
  if (authProof) frames.push(CONTROL_AUTH, authProof);
  return frames;
}

/**
 * 构建心跳应答控制帧数组（master → slave）
 * 帧结构：[PREFIX, "heartbeat_ack", (AUTH_MARKER, authProof)?]
 *
 * @param {string} [authProof] - 可选认证证明
 * @returns {Array}
 */
export function buildHeartbeatAckFrames(authProof = "") {
  const frames = [CONTROL_PREFIX, CONTROL_HEARTBEAT_ACK];
  if (authProof) frames.push(CONTROL_AUTH, authProof);
  return frames;
}

// ─── 帧解析 ───────────────────────────────────────────────────────────────────

/**
 * 解析 ZMQ 原始帧，识别控制帧并提取语义字段
 *
 * 返回 kind 说明：
 * - "register"      → slave 上线注册（携带可选 authKey）
 * - "unregister"    → slave 主动下线注销
 * - "heartbeat"     → slave 发起保活心跳
 * - "heartbeat_ack" → master 返回心跳应答
 * - "publish"       → master 广播消息（携带 topic）
 * - "push"          → slave 单向推送消息（携带 topic）
 * - "request"       → 对端主动发起的 RPC 请求
 * - "response"      → 对端返回的 RPC 响应（匹配 pending 请求）
 * - "message"       → 非控制帧，普通消息透传
 *
 * @param {Array} frames - 不含 identity 帧的帧数组
 * @returns {{
 *   kind         : "register"|"unregister"|"heartbeat"|"heartbeat_ack"|"publish"|"push"|"request"|"response"|"message",
 *   requestId    : string|null,
 *   authKey      : string|null,
 *   authProof    : string|null,
 *   topic        : string|null,
 *   payloadFrames: Array
 * }}
 */
export function parseControlFrames(frames) {
  // 至少需要 2 帧且首帧匹配前缀才能识别控制帧
  if (frames.length < 2 || frames[0]?.toString() !== CONTROL_PREFIX) {
    return {
      kind: "message",
      requestId: null,
      authKey: null,
      authProof: null,
      topic: null,
      payloadFrames: frames,
    };
  }

  const action = frames[1]?.toString();

  // ── 注册帧：[PREFIX, "register", (AUTH_MARKER, authKey)?] ─────────────────
  if (action === CONTROL_REGISTER) {
    let authKey = null;
    if (frames.length >= 4 && frames[2]?.toString() === CONTROL_AUTH) {
      authKey = frames[3]?.toString() ?? "";
    }
    return {
      kind: "register",
      requestId: null,
      authKey,
      authProof: null,
      topic: null,
      payloadFrames: [],
    };
  }

  // ── 注销帧：[PREFIX, "unregister"] ────────────────────────────────────────
  if (action === CONTROL_UNREGISTER) {
    return {
      kind: "unregister",
      requestId: null,
      authKey: null,
      authProof: null,
      topic: null,
      payloadFrames: [],
    };
  }

  // ── 心跳帧：[PREFIX, "heartbeat"] ─────────────────────────────────────────
  if (action === CONTROL_HEARTBEAT) {
    let authProof = null;
    if (frames.length >= 4 && frames[2]?.toString() === CONTROL_AUTH) {
      authProof = frames[3]?.toString() ?? "";
    }

    return {
      kind: "heartbeat",
      requestId: null,
      authKey: null,
      authProof,
      topic: null,
      payloadFrames: [],
    };
  }

  // ── 心跳应答帧：[PREFIX, "heartbeat_ack"] ─────────────────────────────────
  if (action === CONTROL_HEARTBEAT_ACK) {
    let authProof = null;
    if (frames.length >= 4 && frames[2]?.toString() === CONTROL_AUTH) {
      authProof = frames[3]?.toString() ?? "";
    }

    return {
      kind: "heartbeat_ack",
      requestId: null,
      authKey: null,
      authProof,
      topic: null,
      payloadFrames: [],
    };
  }

  // ── 广播帧：[PREFIX, "pub", topic, ...payloadFrames] ─────────────────────
  if (action === CONTROL_PUB && frames.length >= 3) {
    const topic = frames[2]?.toString() ?? "";
    let payloadStart = 3;
    let authProof = null;

    // 广播帧可携带可选认证证明：[PREFIX, "pub", topic, AUTH_MARKER, authProof, ...payload]
    if (frames.length >= 5 && frames[3]?.toString() === CONTROL_AUTH) {
      authProof = frames[4]?.toString() ?? "";
      payloadStart = 5;
    }

    return {
      kind: "publish",
      requestId: null,
      authKey: null,
      authProof,
      topic,
      payloadFrames: frames.slice(payloadStart),
    };
  }

  // ── 推送帧：[PREFIX, "push", topic, ...payloadFrames] ────────────────────
  if (action === CONTROL_PUSH && frames.length >= 3) {
    const topic = frames[2]?.toString() ?? "";
    let payloadStart = 3;
    let authProof = null;

    // 推送帧可携带可选认证证明：[PREFIX, "push", topic, AUTH_MARKER, authProof, ...payload]
    if (frames.length >= 5 && frames[3]?.toString() === CONTROL_AUTH) {
      authProof = frames[4]?.toString() ?? "";
      payloadStart = 5;
    }

    return {
      kind: "push",
      requestId: null,
      authKey: null,
      authProof,
      topic,
      payloadFrames: frames.slice(payloadStart),
    };
  }

  // ── 请求 / 响应帧：[PREFIX, "req"/"res", requestId, ...] ─────────────────
  if (
    (action === CONTROL_REQ || action === CONTROL_RES) &&
    frames.length >= 3
  ) {
    const requestId = frames[2]?.toString();
    if (requestId) {
      let payloadStart = 3;
      let authKey = null;
      let authProof = null;

      // 请求帧可携带 authKey：[PREFIX, "req", requestId, AUTH_MARKER, authKey, ...payload]
      if (
        action === CONTROL_REQ &&
        frames.length >= 5 &&
        frames[3]?.toString() === CONTROL_AUTH
      ) {
        authKey = frames[4]?.toString() ?? "";
        payloadStart = 5;
      }

      // 响应帧可携带 authProof：[PREFIX, "res", requestId, AUTH_MARKER, authProof, ...payload]
      if (
        action === CONTROL_RES &&
        frames.length >= 5 &&
        frames[3]?.toString() === CONTROL_AUTH
      ) {
        authProof = frames[4]?.toString() ?? "";
        payloadStart = 5;
      }

      return {
        kind: action === CONTROL_REQ ? "request" : "response",
        requestId,
        authKey,
        authProof,
        topic: null,
        payloadFrames: frames.slice(payloadStart),
      };
    }
  }

  // ── 无法识别：透传为普通消息 ──────────────────────────────────────────────
  return {
    kind: "message",
    requestId: null,
    authKey: null,
    authProof: null,
    topic: null,
    payloadFrames: frames,
  };
}
