import fs from "node:fs/promises";
import path from "node:path";
import { applyPatch } from "diff";

import {
  OPS,
  DEFAULT_CHUNK_SIZE,
  buildRpcPayload,
  parseRpcPayload,
  toSessionId,
} from "./protocol.js";

import {
  assertRoot,
  toSafePath,
  ensureDir,
  statSafe,
  sanitizeListEntry,
  pathExists,
} from "./utils.js";

function ensureSlave(instance) {
  if (!instance || instance.role !== "slave") {
    throw new Error("fs 命名空间只能挂载在 slave 实例上。");
  }
}

function normalizeChunkSize(size) {
  const v = Number(size);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.min(Math.max(64 * 1024, Math.floor(v)), 32 * 1024 * 1024);
}

function normalizeClientPath(inputPath) {
  const raw = String(inputPath ?? "");
  if (!raw) return raw;

  if (path.isAbsolute(raw)) {
    const root = path.parse(raw).root;
    return path.relative(root, raw);
  }

  return raw;
}

function safePath(root, inputPath) {
  const normalized = normalizeClientPath(inputPath);
  return toSafePath(root, normalized);
}

function okMeta(op, extra = {}) {
  return { ok: true, op, ...extra };
}

function errMeta(op, error) {
  return {
    ok: false,
    op,
    error: error?.message ? String(error.message) : String(error),
  };
}

function createSessionStore() {
  return new Map();
}

async function openOrCreateTmpFile(tmpPath) {
  await ensureDir(path.dirname(tmpPath));
  await fs.open(tmpPath, "a").then((h) => h.close());
}

async function getTmpSize(tmpPath) {
  const stat = await statSafe(tmpPath);
  return stat?.size ?? 0;
}

async function writeChunk(tmpPath, offset, chunk) {
  const handle = await fs.open(tmpPath, "r+");
  try {
    await handle.write(chunk, 0, chunk.length, offset);
  } finally {
    await handle.close();
  }
}

async function removeIfExists(targetPath) {
  if (!(await pathExists(targetPath))) return;
  await fs.rm(targetPath, { force: true, recursive: true });
}

function normalizePatchText(rawPatch) {
  return String(rawPatch ?? "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("==="))
    .join("\n")
    .replace(/\s+$/u, "");
}

export function createSlaveFsApi(slave) {
  ensureSlave(slave);

  const sessions = createSessionStore();
  let rootDir = null;
  let cleanupTimer = null;
  let serviceRegistered = false;
  let serviceHandler = null;

  const SESSION_TTL_MS = 30 * 60 * 1000;

  function emit(eventName, payload) {
    if (typeof slave.emit === "function") {
      slave.emit(eventName, payload);
    }
  }

  function touchSession(session) {
    session.updatedAt = Date.now();
    session.expiresAt = session.updatedAt + SESSION_TTL_MS;
    return session;
  }

  function createSession(base) {
    const now = Date.now();
    return {
      ...base,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
  }

  async function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt > now) continue;

      sessions.delete(sessionId);

      if (session.mode === "upload" && session.tmpPath) {
        try {
          await fs.rm(session.tmpPath, { force: true });
        } catch {}
      }
    }
  }

  function ensureCleanupTimer() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      cleanupExpiredSessions().catch((error) => {
        emit("fs_error", {
          phase: "cleanup",
          error,
        });
      });
    }, 60 * 1000);

    if (typeof cleanupTimer.unref === "function") {
      cleanupTimer.unref();
    }
  }

  function ensureRootConfigured() {
    if (!rootDir) {
      throw new Error(
        "fs root 尚未设置，请先调用 slave.fs.setRoot(rootPath)。",
      );
    }
    return rootDir;
  }

  async function handleList(meta) {
    const root = ensureRootConfigured();
    const target = safePath(root, meta.path);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      throw new Error("目标不是目录。");
    }

    const entries = await fs.readdir(target, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      const full = path.join(target, entry.name);
      const childStat = await statSafe(full);
      result.push(sanitizeListEntry(entry, childStat));
    }

    return buildRpcPayload(
      okMeta(OPS.LIST, {
        path: String(meta.path ?? ""),
        entries: result,
      }),
    );
  }

  async function handleStat(meta) {
    const root = ensureRootConfigured();
    const target = safePath(root, meta.path);
    const stat = await fs.stat(target);

    return buildRpcPayload(
      okMeta(OPS.STAT, {
        path: String(meta.path ?? ""),
        size: stat.size,
        mtime: stat.mtimeMs,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
      }),
    );
  }

  async function handleGet(meta) {
    const root = ensureRootConfigured();
    const target = safePath(root, meta.path);
    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const buffer = await fs.readFile(target);
    return buildRpcPayload(
      okMeta(OPS.GET, {
        path: String(meta.path ?? ""),
        size: buffer.length,
      }),
      [buffer],
    );
  }

  async function handleDelete(meta) {
    const root = ensureRootConfigured();
    const target = safePath(root, meta.path);

    await fs.rm(target, { recursive: true, force: true });

    return buildRpcPayload(
      okMeta(OPS.DELETE, {
        path: String(meta.path ?? ""),
      }),
    );
  }

  async function handleRename(meta) {
    const root = ensureRootConfigured();
    const fromPath = safePath(root, meta.from);
    const toPath = safePath(root, meta.to);

    await ensureDir(path.dirname(toPath));
    await fs.rename(fromPath, toPath);

    return buildRpcPayload(
      okMeta(OPS.RENAME, {
        from: String(meta.from ?? ""),
        to: String(meta.to ?? ""),
      }),
    );
  }

  async function handlePatch(meta) {
    const root = ensureRootConfigured();
    const target = safePath(root, meta.path);
    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const content = await fs.readFile(target, "utf8");
    const patchText = normalizePatchText(meta.patch);
    const normalizedContent = content.replace(/\r\n/g, "\n");

    const candidates = [
      patchText,
      `${patchText}\n`,
      patchText.replace(/^\uFEFF/, ""),
    ];

    let patched = false;
    for (const candidate of candidates) {
      patched = applyPatch(normalizedContent, candidate, { fuzzFactor: 3 });
      if (patched !== false) break;
    }

    if (patched === false) {
      return buildRpcPayload(
        okMeta(OPS.PATCH, {
          path: String(meta.path ?? ""),
          applied: false,
          message: "patch 应用失败",
        }),
      );
    }

    const tmpPath = `${target}.patch.tmp`;
    await fs.writeFile(tmpPath, patched, "utf8");
    await fs.rename(tmpPath, target);

    return buildRpcPayload(
      okMeta(OPS.PATCH, {
        path: String(meta.path ?? ""),
        applied: true,
      }),
    );
  }

  async function handleInit(meta) {
    const root = ensureRootConfigured();
    const sessionId = toSessionId(meta.sessionId);
    const chunkSize = normalizeChunkSize(meta.chunkSize);
    const targetPath = safePath(root, meta.path);
    const tmpPath = `${targetPath}.tmp`;

    await openOrCreateTmpFile(tmpPath);
    const offset = await getTmpSize(tmpPath);

    sessions.set(
      sessionId,
      createSession({
        mode: "upload",
        sessionId,
        targetPath,
        tmpPath,
        chunkSize,
        fileSize: Number(meta.fileSize ?? 0),
      }),
    );

    return buildRpcPayload(
      okMeta(OPS.RESUME, {
        sessionId,
        path: String(meta.path ?? ""),
        offset,
        chunkSize,
      }),
    );
  }

  async function handleChunk(meta, body) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);

    if (!session || session.mode !== "upload") {
      throw new Error("upload session 不存在或已过期。");
    }

    touchSession(session);

    const chunk = body?.[0];
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("chunk payload 缺失或格式非法。");
    }

    const expectedOffset = Number(meta.offset ?? 0);
    const expectedChunkId = Number(meta.chunkId ?? 0);

    const offset = await getTmpSize(session.tmpPath);
    const currentChunkId = Math.floor(offset / session.chunkSize);

    if (offset !== expectedOffset || currentChunkId !== expectedChunkId) {
      throw new Error(
        `chunk 偏移不一致：expect offset=${expectedOffset}, actual offset=${offset}`,
      );
    }

    await writeChunk(session.tmpPath, offset, chunk);

    emit("fs_upload_chunk", {
      sessionId,
      path: String(meta.path ?? ""),
      chunkId: expectedChunkId,
      offset,
      size: chunk.length,
    });

    return buildRpcPayload(
      okMeta(OPS.ACK, {
        sessionId,
        path: String(meta.path ?? ""),
        chunkId: expectedChunkId,
        offset: offset + chunk.length,
        size: chunk.length,
      }),
    );
  }

  async function handleComplete(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);

    if (!session || session.mode !== "upload") {
      throw new Error("upload session 不存在或已过期。");
    }

    await ensureDir(path.dirname(session.targetPath));
    await removeIfExists(session.targetPath);
    await fs.rename(session.tmpPath, session.targetPath);

    sessions.delete(sessionId);

    return buildRpcPayload(
      okMeta(OPS.COMPLETE, {
        sessionId,
        path: String(meta.path ?? ""),
        ok: true,
      }),
    );
  }

  async function handleDownloadInit(meta) {
    const root = ensureRootConfigured();
    const sessionId = toSessionId(meta.sessionId);
    const chunkSize = normalizeChunkSize(meta.chunkSize);
    const targetPath = safePath(root, meta.path);

    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const fileSize = stat.size;
    const offsetInput = Number(meta.offset ?? 0);
    const offset =
      Number.isFinite(offsetInput) && offsetInput > 0 ? offsetInput : 0;

    if (offset > fileSize) {
      throw new Error("download offset 超出文件大小。");
    }

    sessions.set(
      sessionId,
      createSession({
        mode: "download",
        sessionId,
        targetPath,
        chunkSize,
        fileSize,
      }),
    );

    return buildRpcPayload(
      okMeta(OPS.DOWNLOAD_INIT, {
        sessionId,
        path: String(meta.path ?? ""),
        fileSize,
        offset,
        chunkSize,
      }),
    );
  }

  async function handleDownloadChunk(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);

    if (!session || session.mode !== "download") {
      throw new Error("download session 不存在或已过期。");
    }

    touchSession(session);

    const offset = Number(meta.offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error("download offset 非法。");
    }

    if (offset > session.fileSize) {
      throw new Error("download offset 超出文件大小。");
    }

    const size = Math.min(session.chunkSize, session.fileSize - offset);
    const buffer = Buffer.allocUnsafe(size);

    const handle = await fs.open(session.targetPath, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      const chunk =
        bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);

      emit("fs_download_chunk", {
        sessionId,
        path: String(meta.path ?? ""),
        chunkId: Number(meta.chunkId ?? 0),
        offset,
        size: chunk.length,
      });

      return buildRpcPayload(
        okMeta(OPS.DOWNLOAD_CHUNK, {
          sessionId,
          path: String(meta.path ?? ""),
          chunkId: Number(meta.chunkId ?? 0),
          offset,
          size: chunk.length,
          eof: offset + chunk.length >= session.fileSize,
        }),
        [chunk],
      );
    } finally {
      await handle.close();
    }
  }

  async function handleDownloadComplete(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);

    if (!session || session.mode !== "download") {
      throw new Error("download session 不存在或已过期。");
    }

    sessions.delete(sessionId);

    return buildRpcPayload(
      okMeta(OPS.DOWNLOAD_COMPLETE, {
        sessionId,
        path: String(meta.path ?? ""),
        ok: true,
      }),
    );
  }

  async function dispatch(payload) {
    const { meta, body } = parseRpcPayload(payload);

    emit("fs_access", {
      op: meta?.op ?? "",
      path: meta?.path ?? "",
      meta,
    });

    switch (meta?.op) {
      case OPS.LIST:
        return await handleList(meta);
      case OPS.STAT:
        return await handleStat(meta);
      case OPS.GET:
        return await handleGet(meta);
      case OPS.DELETE:
        return await handleDelete(meta);
      case OPS.RENAME:
        return await handleRename(meta);
      case OPS.PATCH:
        return await handlePatch(meta);
      case OPS.INIT:
        return await handleInit(meta);
      case OPS.CHUNK:
        return await handleChunk(meta, body);
      case OPS.COMPLETE:
        return await handleComplete(meta);
      case OPS.DOWNLOAD_INIT:
        return await handleDownloadInit(meta);
      case OPS.DOWNLOAD_CHUNK:
        return await handleDownloadChunk(meta);
      case OPS.DOWNLOAD_COMPLETE:
        return await handleDownloadComplete(meta);
      default:
        throw new Error(`未知 op：${meta?.op}`);
    }
  }

  serviceHandler = async (payload) => {
    try {
      return await dispatch(payload);
    } catch (error) {
      let meta = {};
      try {
        meta = parseRpcPayload(payload).meta || {};
      } catch {}
      emit("fs_error", {
        op: meta?.op ?? "error",
        path: meta?.path ?? "",
        error,
      });
      return buildRpcPayload(errMeta(meta.op || "error", error));
    }
  };

  const api = {
    setRoot(rootPath) {
      rootDir = assertRoot(rootPath);
      ensureCleanupTimer();

      if (
        !serviceRegistered &&
        typeof slave.registerService === "function"
      ) {
        slave.registerService("fs", serviceHandler);
        serviceRegistered = true;
      }

      return api;
    },

    getRoot() {
      return rootDir;
    },

    isEnabled() {
      return Boolean(rootDir);
    },

    getServiceName() {
      return "fs";
    },

    getServiceHandler() {
      return serviceHandler;
    },

    async handleServiceRequest(payload) {
      return serviceHandler(payload);
    },
  };

  return api;
}
