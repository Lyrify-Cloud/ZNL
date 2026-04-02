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

import { assertRoot, ensureDir, pathExists, statSafe } from "./utils.js";

const FS_MKDIR_OP = "file/mkdir";

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
  const raw = String(inputPath ?? "").trim();
  if (!raw) {
    throw new Error("path 不能为空。");
  }

  if (path.isAbsolute(raw)) {
    const root = path.parse(raw).root;
    return path.relative(root, raw);
  }

  return raw;
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

async function lstatSafe(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return null;
  }
}

async function removeIfExists(targetPath) {
  const stat = await lstatSafe(targetPath);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error("拒绝操作符号链接。");
  }
  await fs.rm(targetPath, { force: true, recursive: true });
}

function normalizePatchText(rawPatch) {
  return String(rawPatch ?? "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("==="))
    .join("\n")
    .replace(/\s+$/u, "");
}

function normalizePolicy(policy = {}) {
  if (!policy || typeof policy !== "object") {
    return {
      readOnly: false,
      allowDelete: true,
      allowPatch: true,
      allowUpload: true,
      allowedPaths: [],
      denyGlobs: [],
    };
  }

  const toList = (value) =>
    Array.isArray(value)
      ? value
          .filter((item) => item != null && String(item).trim())
          .map((item) => toPosixPath(String(item).trim()))
      : [];

  return {
    readOnly: Boolean(policy.readOnly),
    allowDelete:
      policy.allowDelete == null ? true : Boolean(policy.allowDelete),
    allowPatch: policy.allowPatch == null ? true : Boolean(policy.allowPatch),
    allowUpload:
      policy.allowUpload == null ? true : Boolean(policy.allowUpload),
    allowedPaths: toList(policy.allowedPaths),
    denyGlobs: toList(policy.denyGlobs),
  };
}

function toPosixPath(value) {
  return String(value ?? "").replace(/[\\/]+/g, "/");
}

function escapeRegex(text) {
  return String(text).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  const normalized = toPosixPath(glob);
  let pattern = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const next = normalized[i + 1];

    if (ch === "*") {
      if (next === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    if (ch === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += escapeRegex(ch);
  }
  pattern += "$";
  return new RegExp(pattern);
}

function matchesGlob(glob, value) {
  return globToRegExp(glob).test(toPosixPath(value));
}

function isPathAllowedByList(relativePath, allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return true;

  const target = toPosixPath(relativePath).replace(/^\/+/, "");
  return allowedPaths.some((entry) => {
    const normalized = toPosixPath(entry)
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

    if (!normalized) return true;

    if (normalized.includes("*") || normalized.includes("?")) {
      if (matchesGlob(normalized, target)) return true;

      const prefix = normalized.replace(/\/+(?:\*\*|\*)$/u, "");
      if (prefix && (target === prefix || target.startsWith(`${prefix}/`))) {
        return true;
      }

      return false;
    }

    return target === normalized || target.startsWith(`${normalized}/`);
  });
}

function isPathDeniedByGlobs(relativePath, denyGlobs) {
  if (!Array.isArray(denyGlobs) || denyGlobs.length === 0) return false;
  const target = toPosixPath(relativePath).replace(/^\/+/, "");
  return denyGlobs.some((glob) => matchesGlob(glob, target));
}

function sanitizeListEntry(entry, stats) {
  return {
    name: entry.name,
    type: stats?.isSymbolicLink()
      ? "symlink"
      : entry.isDirectory()
        ? "dir"
        : "file",
    size: stats?.size ?? 0,
    mtime: stats?.mtimeMs ?? 0,
    isFile: Boolean(stats?.isFile?.()),
    isDirectory: Boolean(stats?.isDirectory?.()),
    isSymbolicLink: Boolean(stats?.isSymbolicLink?.()),
  };
}

async function ensureNoSymlinkInPath(
  base,
  target,
  { allowMissingLeaf = false } = {},
) {
  const resolvedBase = assertRoot(base);
  const resolvedTarget = path.resolve(target);

  const normalizedBase = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : `${resolvedBase}${path.sep}`;

  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(normalizedBase)
  ) {
    throw new Error("路径越权：目标不在 root 范围内。");
  }

  const relative = path.relative(resolvedBase, resolvedTarget);
  const segments = relative
    .split(path.sep)
    .filter((segment) => segment && segment !== ".");

  let current = resolvedBase;
  const baseStat = await lstatSafe(current);
  if (!baseStat) {
    throw new Error("fs root 不存在。");
  }
  if (baseStat.isSymbolicLink()) {
    throw new Error("fs root 不能是符号链接。");
  }

  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const stat = await lstatSafe(current);

    if (!stat) {
      if (allowMissingLeaf && i === segments.length - 1) {
        return resolvedTarget;
      }
      throw new Error("目标不存在。");
    }

    if (stat.isSymbolicLink()) {
      throw new Error("路径越权：路径中包含符号链接。");
    }
  }

  return resolvedTarget;
}

async function resolveSafePath(root, inputPath, options = {}) {
  const normalized = normalizeClientPath(inputPath);
  const target = path.resolve(root, normalized);
  const safe = await ensureNoSymlinkInPath(root, target, options);

  return {
    relativePath: toPosixPath(path.relative(root, safe) || "."),
    absolutePath: safe,
  };
}

async function resolveSafeParentPath(root, inputPath) {
  const normalized = normalizeClientPath(inputPath);
  const target = path.resolve(root, normalized);

  const normalizedBase = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(normalizedBase)) {
    throw new Error("路径越权：目标不在 root 范围内。");
  }

  const parent = target === root ? root : path.dirname(target);
  await ensureNoSymlinkInPath(root, parent, { allowMissingLeaf: true });

  return {
    relativePath: toPosixPath(path.relative(root, target) || "."),
    absolutePath: target,
  };
}

function isUploadDirectoryHint(inputPath) {
  const raw = String(inputPath ?? "").trim();
  if (!raw) return false;
  if (raw === "." || raw === "./" || raw === ".\\") return true;
  return /[\\/]+$/u.test(raw);
}

function normalizeUploadFileName(fileName) {
  const text = String(fileName ?? "").trim();
  if (!text) {
    throw new Error("upload 缺少有效 fileName。");
  }

  if (text.includes("/") || text.includes("\\")) {
    throw new Error("upload fileName 不能包含路径分隔符。");
  }

  if (text === "." || text === "..") {
    throw new Error("upload fileName 非法。");
  }

  return text;
}

async function resolveUploadTargetPath(root, inputPath, fileName) {
  const normalizedRoot = assertRoot(root);
  const requested = await resolveSafeParentPath(normalizedRoot, inputPath);
  const requestedStat = await lstatSafe(requested.absolutePath);

  if (requestedStat?.isSymbolicLink()) {
    throw new Error("拒绝写入符号链接目标。");
  }

  const isDirectoryTarget =
    requested.relativePath === "." ||
    isUploadDirectoryHint(inputPath) ||
    Boolean(requestedStat?.isDirectory());

  if (!isDirectoryTarget) {
    return requested;
  }

  const safeName = normalizeUploadFileName(fileName);
  const combinedRelative =
    requested.relativePath === "."
      ? safeName
      : `${requested.relativePath}/${safeName}`;

  return resolveSafeParentPath(normalizedRoot, combinedRelative);
}

function enforcePathPolicy(policy, relativePath, { op, write = false } = {}) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "");

  if (!isPathAllowedByList(normalized, policy.allowedPaths)) {
    throw new Error(
      `访问被策略拒绝：路径不在 allowedPaths 范围内（op=${op}）。`,
    );
  }

  if (isPathDeniedByGlobs(normalized, policy.denyGlobs)) {
    throw new Error(`访问被策略拒绝：路径命中 denyGlobs（op=${op}）。`);
  }

  if (write && policy.readOnly) {
    throw new Error(`访问被策略拒绝：当前 fs root 为只读模式（op=${op}）。`);
  }

  if (write && op === OPS.DELETE && !policy.allowDelete) {
    throw new Error("访问被策略拒绝：allowDelete=false。");
  }

  if (write && op === OPS.PATCH && !policy.allowPatch) {
    throw new Error("访问被策略拒绝：allowPatch=false。");
  }

  if (
    write &&
    (op === OPS.CREATE ||
      op === FS_MKDIR_OP ||
      op === OPS.INIT ||
      op === OPS.CHUNK ||
      op === OPS.COMPLETE)
  ) {
    if (!policy.allowUpload) {
      throw new Error("访问被策略拒绝：allowUpload=false。");
    }
  }
}

export function createSlaveFsApi(slave) {
  ensureSlave(slave);

  const sessions = createSessionStore();
  let rootDir = null;
  let cleanupTimer = null;
  let serviceRegistered = false;
  let serviceHandler = null;
  let policy = normalizePolicy();

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

  async function resolveReadPath(inputPath, op) {
    const root = ensureRootConfigured();
    const resolved = await resolveSafePath(root, inputPath, {
      allowMissingLeaf: false,
    });
    enforcePathPolicy(policy, resolved.relativePath, { op, write: false });
    return resolved;
  }

  async function resolveWritePath(
    inputPath,
    op,
    { allowMissingLeaf = false } = {},
  ) {
    const root = ensureRootConfigured();
    const resolved = allowMissingLeaf
      ? await resolveSafeParentPath(root, inputPath)
      : await resolveSafePath(root, inputPath, { allowMissingLeaf: false });

    enforcePathPolicy(policy, resolved.relativePath, { op, write: true });
    return resolved;
  }

  async function handleList(meta) {
    const targetInfo = await resolveReadPath(meta.path, OPS.LIST);
    const stat = await fs.lstat(targetInfo.absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("拒绝访问符号链接目录。");
    }
    if (!stat.isDirectory()) {
      throw new Error("目标不是目录。");
    }

    const entries = await fs.readdir(targetInfo.absolutePath, {
      withFileTypes: true,
    });
    const result = [];

    for (const entry of entries) {
      const full = path.join(targetInfo.absolutePath, entry.name);
      const childStat = await lstatSafe(full);
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
    const targetInfo = await resolveReadPath(meta.path, OPS.STAT);
    const stat = await fs.lstat(targetInfo.absolutePath);

    if (stat.isSymbolicLink()) {
      throw new Error("拒绝访问符号链接。");
    }

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
    const targetInfo = await resolveReadPath(meta.path, OPS.GET);
    const stat = await fs.lstat(targetInfo.absolutePath);

    if (stat.isSymbolicLink()) {
      throw new Error("拒绝读取符号链接。");
    }
    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const buffer = await fs.readFile(targetInfo.absolutePath);
    return buildRpcPayload(
      okMeta(OPS.GET, {
        path: String(meta.path ?? ""),
        size: buffer.length,
      }),
      [buffer],
    );
  }

  async function handleCreate(meta) {
    const recursive = meta?.recursive !== false;
    const overwrite = Boolean(meta?.overwrite);
    const targetInfo = await resolveWritePath(meta.path, OPS.CREATE, {
      allowMissingLeaf: true,
    });

    const existingStat = await lstatSafe(targetInfo.absolutePath);
    if (existingStat?.isSymbolicLink()) {
      throw new Error("拒绝创建或覆盖符号链接。");
    }
    if (existingStat?.isDirectory()) {
      throw new Error("目标已存在且为目录。");
    }
    if (existingStat && !overwrite) {
      throw new Error("目标文件已存在，请使用 overwrite=true 覆盖。");
    }

    const parentDir = path.dirname(targetInfo.absolutePath);
    if (recursive) {
      await ensureDir(parentDir);
    } else {
      const parentStat = await lstatSafe(parentDir);
      if (!parentStat) {
        throw new Error("父目录不存在。");
      }
      if (parentStat.isSymbolicLink()) {
        throw new Error("拒绝通过符号链接父目录创建文件。");
      }
      if (!parentStat.isDirectory()) {
        throw new Error("父路径不是目录。");
      }
    }

    await fs.writeFile(targetInfo.absolutePath, Buffer.alloc(0));

    return buildRpcPayload(
      okMeta(OPS.CREATE, {
        path: String(meta.path ?? ""),
        created: true,
        overwritten: Boolean(existingStat),
      }),
    );
  }

  async function handleMkdir(meta) {
    const recursive = meta?.recursive !== false;
    const existOk = meta?.existOk !== false;
    const targetInfo = await resolveWritePath(meta.path, FS_MKDIR_OP, {
      allowMissingLeaf: true,
    });

    const existingStat = await lstatSafe(targetInfo.absolutePath);
    if (existingStat?.isSymbolicLink()) {
      throw new Error("拒绝创建或复用符号链接目录。");
    }
    if (existingStat) {
      if (!existingStat.isDirectory()) {
        throw new Error("目标已存在且不是目录。");
      }
      if (!existOk) {
        throw new Error("目标目录已存在，请使用 existOk=true 允许复用。");
      }

      return buildRpcPayload(
        okMeta(FS_MKDIR_OP, {
          path: String(meta.path ?? ""),
          created: true,
          existed: true,
        }),
      );
    }

    const parentDir = path.dirname(targetInfo.absolutePath);
    if (!recursive) {
      const parentStat = await lstatSafe(parentDir);
      if (!parentStat) {
        throw new Error("父目录不存在。");
      }
      if (parentStat.isSymbolicLink()) {
        throw new Error("拒绝通过符号链接父目录创建目录。");
      }
      if (!parentStat.isDirectory()) {
        throw new Error("父路径不是目录。");
      }
    }

    await fs.mkdir(targetInfo.absolutePath, { recursive });

    return buildRpcPayload(
      okMeta(FS_MKDIR_OP, {
        path: String(meta.path ?? ""),
        created: true,
        existed: false,
      }),
    );
  }

  async function handleDelete(meta) {
    const targetInfo = await resolveWritePath(meta.path, OPS.DELETE);

    await removeIfExists(targetInfo.absolutePath);

    return buildRpcPayload(
      okMeta(OPS.DELETE, {
        path: String(meta.path ?? ""),
      }),
    );
  }

  async function handleRename(meta) {
    const fromInfo = await resolveWritePath(meta.from, OPS.RENAME);
    const toInfo = await resolveWritePath(meta.to, OPS.RENAME, {
      allowMissingLeaf: true,
    });

    const fromStat = await fs.lstat(fromInfo.absolutePath);
    if (fromStat.isSymbolicLink()) {
      throw new Error("拒绝重命名符号链接。");
    }

    const existingToStat = await lstatSafe(toInfo.absolutePath);
    if (existingToStat?.isSymbolicLink()) {
      throw new Error("拒绝覆盖符号链接。");
    }

    await ensureDir(path.dirname(toInfo.absolutePath));
    await fs.rename(fromInfo.absolutePath, toInfo.absolutePath);

    return buildRpcPayload(
      okMeta(OPS.RENAME, {
        from: String(meta.from ?? ""),
        to: String(meta.to ?? ""),
      }),
    );
  }

  async function handlePatch(meta) {
    const targetInfo = await resolveWritePath(meta.path, OPS.PATCH);
    const stat = await fs.lstat(targetInfo.absolutePath);

    if (stat.isSymbolicLink()) {
      throw new Error("拒绝修改符号链接。");
    }
    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const content = await fs.readFile(targetInfo.absolutePath, "utf8");
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

    const tmpPath = `${targetInfo.absolutePath}.patch.tmp`;
    await fs.writeFile(tmpPath, patched, "utf8");
    await fs.rename(tmpPath, targetInfo.absolutePath);

    return buildRpcPayload(
      okMeta(OPS.PATCH, {
        path: String(meta.path ?? ""),
        applied: true,
      }),
    );
  }

  async function handleInit(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const chunkSize = normalizeChunkSize(meta.chunkSize);
    const root = ensureRootConfigured();
    const targetInfo = await resolveUploadTargetPath(
      root,
      meta.path,
      meta.fileName,
    );

    enforcePathPolicy(policy, targetInfo.relativePath, {
      op: OPS.INIT,
      write: true,
    });

    const tmpPath = `${targetInfo.absolutePath}.tmp`;

    const tmpExisting = await lstatSafe(tmpPath);
    if (tmpExisting?.isSymbolicLink()) {
      throw new Error("拒绝写入符号链接临时文件。");
    }

    await openOrCreateTmpFile(tmpPath);
    const offset = await getTmpSize(tmpPath);

    sessions.set(
      sessionId,
      createSession({
        mode: "upload",
        sessionId,
        targetPath: targetInfo.absolutePath,
        relativePath: targetInfo.relativePath,
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

    enforcePathPolicy(policy, session.relativePath, {
      op: OPS.CHUNK,
      write: true,
    });

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

    enforcePathPolicy(policy, session.relativePath, {
      op: OPS.COMPLETE,
      write: true,
    });

    const tmpStat = await lstatSafe(session.tmpPath);
    if (tmpStat?.isSymbolicLink()) {
      throw new Error("拒绝完成符号链接上传。");
    }

    const targetStat = await lstatSafe(session.targetPath);
    if (targetStat?.isSymbolicLink()) {
      throw new Error("拒绝覆盖符号链接。");
    }
    if (targetStat?.isDirectory()) {
      throw new Error("拒绝将目录覆盖为文件。");
    }

    await ensureDir(path.dirname(session.targetPath));
    if (targetStat) {
      await fs.rm(session.targetPath, { force: true });
    }
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
    const sessionId = toSessionId(meta.sessionId);
    const chunkSize = normalizeChunkSize(meta.chunkSize);
    const targetInfo = await resolveReadPath(meta.path, OPS.DOWNLOAD_INIT);

    const stat = await fs.lstat(targetInfo.absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("拒绝下载符号链接。");
    }
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
        targetPath: targetInfo.absolutePath,
        relativePath: targetInfo.relativePath,
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

    enforcePathPolicy(policy, session.relativePath, {
      op: OPS.DOWNLOAD_CHUNK,
      write: false,
    });

    touchSession(session);

    const offset = Number(meta.offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error("download offset 非法。");
    }

    if (offset > session.fileSize) {
      throw new Error("download offset 超出文件大小。");
    }

    const fileStat = await fs.lstat(session.targetPath);
    if (fileStat.isSymbolicLink()) {
      throw new Error("拒绝读取符号链接。");
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
      policy: { ...policy },
    });

    switch (meta?.op) {
      case OPS.LIST:
        return await handleList(meta);
      case OPS.STAT:
        return await handleStat(meta);
      case OPS.GET:
        return await handleGet(meta);
      case OPS.CREATE:
        return await handleCreate(meta);
      case FS_MKDIR_OP:
        return await handleMkdir(meta);
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
    setRoot(rootPath, nextPolicy = {}) {
      rootDir = assertRoot(rootPath);
      policy = normalizePolicy(nextPolicy);
      ensureCleanupTimer();

      if (!serviceRegistered && typeof slave.registerService === "function") {
        slave.registerService("fs", serviceHandler);
        serviceRegistered = true;
      }

      return api;
    },

    getRoot() {
      return rootDir;
    },

    getPolicy() {
      return { ...policy };
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
