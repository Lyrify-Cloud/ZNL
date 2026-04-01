export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

export const FS_SERVICE_NAME = "fs";

export const OPS = Object.freeze({
  LIST: "file/list",
  GET: "file/get",
  CREATE: "file/create",
  MKDIR: "file/mkdir",
  PATCH: "file/patch",
  INIT: "file/init",
  RESUME: "file/resume",
  CHUNK: "file/chunk",
  ACK: "file/ack",
  COMPLETE: "file/complete",
  DOWNLOAD_INIT: "file/download_init",
  DOWNLOAD_CHUNK: "file/download_chunk",
  DOWNLOAD_COMPLETE: "file/download_complete",
  DELETE: "file/delete",
  RENAME: "file/rename",
  STAT: "file/stat",
});

export function encodeJson(value) {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8");
}

export function decodeJson(buffer) {
  if (!buffer) return {};
  const text = Buffer.isBuffer(buffer)
    ? buffer.toString("utf8")
    : String(buffer);
  if (!text) return {};
  return JSON.parse(text);
}

export function normalizePayloadFrames(payload) {
  if (Array.isArray(payload)) return payload;
  return [payload];
}

export function parseRpcPayload(payload) {
  const frames = normalizePayloadFrames(payload);
  if (!frames.length) return { meta: {}, body: [] };
  const [metaFrame, ...body] = frames;
  return { meta: decodeJson(metaFrame), body };
}

export function buildRpcPayload(meta, bodyFrames = []) {
  const metaFrame = encodeJson(meta);
  return [metaFrame, ...bodyFrames];
}

export function ensureOp(meta, expectedOp) {
  const op = meta?.op;
  if (op !== expectedOp) {
    throw new Error(`协议错误：期望 op=${expectedOp}，实际 op=${op}`);
  }
}

export function ensureFsMeta(meta) {
  if (!meta || typeof meta !== "object") {
    throw new Error("协议错误：meta 必须是对象。");
  }

  const service = String(meta.service ?? FS_SERVICE_NAME);
  if (service !== FS_SERVICE_NAME) {
    throw new Error(
      `协议错误：期望 service=${FS_SERVICE_NAME}，实际 service=${service}`,
    );
  }

  return { ...meta, service };
}

export function buildFsPayload(meta, bodyFrames = []) {
  return buildRpcPayload(
    {
      service: FS_SERVICE_NAME,
      ...meta,
    },
    bodyFrames,
  );
}

export function parseFsPayload(payload) {
  const parsed = parseRpcPayload(payload);
  return {
    meta: ensureFsMeta(parsed.meta),
    body: parsed.body,
  };
}

export function toSessionId(value) {
  const text = String(value ?? "");
  if (!text) throw new Error("sessionId 不能为空。");
  return text;
}
