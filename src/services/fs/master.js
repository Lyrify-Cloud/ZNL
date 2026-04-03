import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  OPS,
  DEFAULT_CHUNK_SIZE,
  buildRpcPayload,
  parseRpcPayload,
  toSessionId,
} from "./protocol.js";

function ensureMaster(instance) {
  if (!instance || instance.role !== "master") {
    throw new Error("fs 命名空间只能挂载在 master 实例上。");
  }
}

function normalizeOptions(options) {
  if (!options || typeof options !== "object") return {};
  return options;
}

function normalizeChunkSize(size) {
  const v = Number(size);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.max(64 * 1024, Math.min(32 * 1024 * 1024, Math.floor(v)));
}

function createSessionId() {
  return randomUUID();
}

function resolveProgressHandler(options) {
  const onProgress = options?.onProgress;
  return typeof onProgress === "function" ? onProgress : null;
}

function progressPercent(transferred, total) {
  const n = Number(transferred ?? 0);
  const t = Number(total ?? 0);

  if (!Number.isFinite(t) || t <= 0) return 100;
  if (!Number.isFinite(n) || n <= 0) return 0;

  return Math.max(0, Math.min(100, (n / t) * 100));
}

function emitProgress(onProgress, payload) {
  if (!onProgress) return;
  try {
    onProgress(payload);
  } catch {}
}

function createProgressCalculator() {
  let startedAt = 0;
  let lastSampleAt = 0;
  let lastSampleBytes = 0;
  let smoothedBps = 0;

  return (transferred, total, phase = "chunk") => {
    const nowTs = Date.now();
    const n = Number(transferred ?? 0);
    const t = Number(total ?? 0);
    const bytes = Number.isFinite(n) && n > 0 ? n : 0;
    const totalBytes = Number.isFinite(t) && t >= 0 ? t : 0;

    if (startedAt === 0 || phase === "init") {
      startedAt = nowTs;
      lastSampleAt = nowTs;
      lastSampleBytes = bytes;
      smoothedBps = 0;
    }

    const deltaMs = Math.max(0, nowTs - lastSampleAt);
    const deltaBytes = Math.max(0, bytes - lastSampleBytes);

    if (deltaMs > 0) {
      const instantBps = (deltaBytes * 1000) / deltaMs;
      if (instantBps > 0) {
        smoothedBps =
          smoothedBps > 0 ? smoothedBps * 0.75 + instantBps * 0.25 : instantBps;
      }
      lastSampleAt = nowTs;
      lastSampleBytes = bytes;
    }

    const elapsedMs = Math.max(1, nowTs - startedAt);
    const avgBps = bytes > 0 ? (bytes * 1000) / elapsedMs : 0;
    const speedBps = smoothedBps > 0 ? smoothedBps : avgBps;

    const remaining = Math.max(0, totalBytes - bytes);
    const etaSeconds =
      remaining <= 0 ? 0 : speedBps > 0 ? remaining / speedBps : null;

    return {
      percent: progressPercent(bytes, totalBytes),
      speedBps,
      etaSeconds,
    };
  };
}

function assertOk(meta, fallbackOp = "file/unknown") {
  const op = String(meta?.op ?? fallbackOp);
  if (meta?.ok === false) {
    throw new Error(meta?.error ? String(meta.error) : `远端操作失败：${op}`);
  }
  return meta;
}

async function request(master, slaveId, meta, bodyFrames = [], options = {}) {
  const payload = buildRpcPayload(meta, bodyFrames);
  const opts = normalizeOptions(options);

  if (typeof master._serviceRequest === "function") {
    return parseRpcPayload(
      await master._serviceRequest("fs", slaveId, payload, opts),
    );
  }

  if (typeof master._requestService === "function") {
    return parseRpcPayload(
      await master._requestService("fs", slaveId, payload, opts),
    );
  }

  if (typeof master.requestService === "function") {
    return parseRpcPayload(
      await master.requestService("fs", slaveId, payload, opts),
    );
  }

  if (
    master._serviceManager &&
    typeof master._serviceManager.requestTo === "function"
  ) {
    return parseRpcPayload(
      await master._serviceManager.requestTo(slaveId, "fs", payload, opts),
    );
  }

  if (
    master.serviceManager &&
    typeof master.serviceManager.requestTo === "function"
  ) {
    return parseRpcPayload(
      await master.serviceManager.requestTo(slaveId, "fs", payload, opts),
    );
  }

  throw new Error("当前 ZNL 实例未挂载内部 service 通道，无法使用 master.fs。");
}

export function createMasterFsApi(master) {
  ensureMaster(master);

  return {
    async list(slaveId, dirPath, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.LIST,
          path: String(dirPath ?? ""),
        },
        [],
        options,
      );

      return assertOk(parsed.meta, OPS.LIST);
    },

    async stat(slaveId, targetPath, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.STAT,
          path: String(targetPath ?? ""),
        },
        [],
        options,
      );

      return assertOk(parsed.meta, OPS.STAT);
    },

    async get(slaveId, targetPath, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.GET,
          path: String(targetPath ?? ""),
        },
        [],
        options,
      );

      assertOk(parsed.meta, OPS.GET);
      return parsed;
    },

    async create(slaveId, targetPath, options = {}) {
      const opts = normalizeOptions(options);
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.CREATE,
          path: String(targetPath ?? ""),
          overwrite: Boolean(opts.overwrite),
          recursive: opts.recursive !== false,
        },
        [],
        opts,
      );

      return assertOk(parsed.meta, OPS.CREATE);
    },

    async mkdir(slaveId, targetPath, options = {}) {
      const opts = normalizeOptions(options);
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.MKDIR,
          path: String(targetPath ?? ""),
          recursive: opts.recursive !== false,
          existOk: opts.existOk !== false,
        },
        [],
        opts,
      );

      return assertOk(parsed.meta, OPS.MKDIR);
    },

    async delete(slaveId, targetPath, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.DELETE,
          path: String(targetPath ?? ""),
        },
        [],
        options,
      );

      return assertOk(parsed.meta, OPS.DELETE);
    },

    async rename(slaveId, fromPath, toPath, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.RENAME,
          from: String(fromPath ?? ""),
          to: String(toPath ?? ""),
        },
        [],
        options,
      );

      return assertOk(parsed.meta, OPS.RENAME);
    },

    async patch(slaveId, targetPath, unifiedDiff, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.PATCH,
          path: String(targetPath ?? ""),
          patch: String(unifiedDiff ?? ""),
        },
        [],
        options,
      );

      return assertOk(parsed.meta, OPS.PATCH);
    },

    async upload(slaveId, localPath, remotePath, options = {}) {
      const opts = normalizeOptions(options);
      const onProgress = resolveProgressHandler(opts);
      const chunkSize = normalizeChunkSize(opts.chunkSize);
      const sessionId = toSessionId(opts.sessionId ?? createSessionId());
      const absolutePath = path.resolve(String(localPath ?? ""));

      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        throw new Error("upload 仅支持文件路径。");
      }

      const initResp = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.INIT,
          sessionId,
          path: String(remotePath ?? ""),
          fileName: path.basename(absolutePath),
          fileSize: stat.size,
          chunkSize,
        },
        [],
        opts,
      );

      assertOk(initResp.meta, OPS.INIT);

      const resumeOffset = Number(initResp.meta?.offset ?? 0);
      let offset =
        Number.isFinite(resumeOffset) && resumeOffset > 0 ? resumeOffset : 0;

      const totalChunks = Math.ceil(stat.size / chunkSize);
      let chunkId = Math.floor(offset / chunkSize);
      const calcProgress = createProgressCalculator();

      emitProgress(onProgress, {
        direction: "upload",
        phase: "init",
        slaveId,
        sessionId,
        localPath: absolutePath,
        remotePath: String(remotePath ?? ""),
        transferred: offset,
        total: stat.size,
        totalChunks,
        chunkId,
        ...calcProgress(offset, stat.size, "init"),
      });

      const handle = await fs.open(absolutePath, "r");
      try {
        while (offset < stat.size) {
          const remaining = stat.size - offset;
          const readSize = Math.min(chunkSize, remaining);
          const buffer = Buffer.allocUnsafe(readSize);
          const { bytesRead } = await handle.read(buffer, 0, readSize, offset);
          const chunk =
            bytesRead === buffer.length
              ? buffer
              : buffer.subarray(0, bytesRead);

          const ack = await request(
            master,
            slaveId,
            {
              service: "fs",
              op: OPS.CHUNK,
              sessionId,
              path: String(remotePath ?? ""),
              chunkId,
              totalChunks,
              offset,
              size: chunk.length,
            },
            [chunk],
            opts,
          );

          assertOk(ack.meta, OPS.CHUNK);

          if (ack.meta?.op && ack.meta.op !== OPS.ACK) {
            throw new Error(
              `上传分片 ACK 异常：expect=${OPS.ACK}, got=${ack.meta.op}`,
            );
          }

          if (
            Number.isFinite(Number(ack.meta?.chunkId)) &&
            Number(ack.meta.chunkId) !== chunkId
          ) {
            throw new Error(
              `上传分片 ACK chunkId 不匹配：expect=${chunkId}, got=${ack.meta.chunkId}`,
            );
          }

          offset += chunk.length;
          chunkId += 1;

          emitProgress(onProgress, {
            direction: "upload",
            phase: "chunk",
            slaveId,
            sessionId,
            localPath: absolutePath,
            remotePath: String(remotePath ?? ""),
            transferred: offset,
            total: stat.size,
            totalChunks,
            chunkId: chunkId - 1,
            size: chunk.length,
            ...calcProgress(offset, stat.size, "chunk"),
          });
        }

        const complete = await request(
          master,
          slaveId,
          {
            service: "fs",
            op: OPS.COMPLETE,
            sessionId,
            path: String(remotePath ?? ""),
            fileName: path.basename(absolutePath),
            fileSize: stat.size,
            totalChunks,
          },
          [],
          opts,
        );

        const meta = assertOk(complete.meta, OPS.COMPLETE);

        emitProgress(onProgress, {
          direction: "upload",
          phase: "complete",
          slaveId,
          sessionId,
          localPath: absolutePath,
          remotePath: String(remotePath ?? ""),
          transferred: stat.size,
          total: stat.size,
          totalChunks,
          ...calcProgress(stat.size, stat.size, "complete"),
          meta,
        });

        return meta;
      } finally {
        await handle.close();
      }
    },

    async download(slaveId, remotePath, localPath, options = {}) {
      const opts = normalizeOptions(options);
      const onProgress = resolveProgressHandler(opts);
      const chunkSize = normalizeChunkSize(opts.chunkSize);
      const sessionId = toSessionId(opts.sessionId ?? createSessionId());
      const absolutePath = path.resolve(String(localPath ?? ""));

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });

      const tmpPath = `${absolutePath}.tmp`;
      let offset = 0;

      try {
        const stat = await fs.stat(tmpPath);
        if (stat.isFile()) offset = stat.size;
      } catch {}

      const initResp = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.DOWNLOAD_INIT,
          sessionId,
          path: String(remotePath ?? ""),
          chunkSize,
          offset,
        },
        [],
        opts,
      );

      assertOk(initResp.meta, OPS.DOWNLOAD_INIT);

      const fileSize = Number(
        initResp.meta?.fileSize ?? initResp.meta?.size ?? 0,
      );
      if (!Number.isFinite(fileSize) || fileSize < 0) {
        throw new Error("download 初始化失败：fileSize 无效。");
      }

      const resumeOffset = Number(initResp.meta?.offset ?? offset);
      offset =
        Number.isFinite(resumeOffset) && resumeOffset > 0 ? resumeOffset : 0;

      const totalChunks = Math.ceil(fileSize / chunkSize);
      const calcProgress = createProgressCalculator();

      emitProgress(onProgress, {
        direction: "download",
        phase: "init",
        slaveId,
        sessionId,
        remotePath: String(remotePath ?? ""),
        localPath: absolutePath,
        transferred: offset,
        total: fileSize,
        totalChunks,
        chunkId: Math.floor(offset / chunkSize),
        ...calcProgress(offset, fileSize, "init"),
      });

      const createHandle = await fs.open(tmpPath, "a");
      await createHandle.close();

      const handle = await fs.open(tmpPath, "r+");
      try {
        let chunkId = Math.floor(offset / chunkSize);

        while (offset < fileSize) {
          const resp = await request(
            master,
            slaveId,
            {
              service: "fs",
              op: OPS.DOWNLOAD_CHUNK,
              sessionId,
              path: String(remotePath ?? ""),
              chunkId,
              offset,
              chunkSize,
              totalChunks,
            },
            [],
            opts,
          );

          assertOk(resp.meta, OPS.DOWNLOAD_CHUNK);

          const chunk = resp.body?.[0];
          if (!Buffer.isBuffer(chunk)) {
            throw new Error("download chunk payload 缺失或格式非法。");
          }

          await handle.write(chunk, 0, chunk.length, offset);

          offset += chunk.length;
          chunkId += 1;

          emitProgress(onProgress, {
            direction: "download",
            phase: "chunk",
            slaveId,
            sessionId,
            remotePath: String(remotePath ?? ""),
            localPath: absolutePath,
            transferred: offset,
            total: fileSize,
            totalChunks,
            chunkId: chunkId - 1,
            size: chunk.length,
            ...calcProgress(offset, fileSize, "chunk"),
          });
        }
      } finally {
        await handle.close();
      }

      await fs.rm(absolutePath, { force: true });
      await fs.rename(tmpPath, absolutePath);

      const complete = await request(
        master,
        slaveId,
        {
          service: "fs",
          op: OPS.DOWNLOAD_COMPLETE,
          sessionId,
          path: String(remotePath ?? ""),
          fileSize,
          totalChunks,
        },
        [],
        opts,
      );

      const meta = assertOk(complete.meta, OPS.DOWNLOAD_COMPLETE);

      emitProgress(onProgress, {
        direction: "download",
        phase: "complete",
        slaveId,
        sessionId,
        remotePath: String(remotePath ?? ""),
        localPath: absolutePath,
        transferred: fileSize,
        total: fileSize,
        totalChunks,
        ...calcProgress(fileSize, fileSize, "complete"),
        meta,
      });

      return meta;
    },
  };
}
