import fs from "node:fs/promises";
import path from "node:path";

export function assertRoot(root) {
  const text = String(root ?? "").trim();
  if (!text) {
    throw new Error("fs root 不能为空。");
  }

  const resolved = path.resolve(text);
  if (!resolved) {
    throw new Error("fs root 非法。");
  }

  return resolved;
}

export function normalizeClientPath(inputPath) {
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

export function toSafePath(root, targetPath) {
  const base = assertRoot(root);
  const relativePath = normalizeClientPath(targetPath);
  const resolved = path.resolve(base, relativePath);

  const normalizedBase = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (resolved !== base && !resolved.startsWith(normalizedBase)) {
    throw new Error("路径越权：目标不在 root 范围内。");
  }

  return resolved;
}

export function toPosixPath(value) {
  return String(value ?? "").split(path.sep).join("/");
}

export function safeJoin(root, ...parts) {
  return toSafePath(root, path.join(...parts));
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

export async function removeIfExists(targetPath) {
  if (!(await pathExists(targetPath))) return;
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function openOrCreateFile(filePath) {
  await ensureDir(path.dirname(filePath));
  const handle = await fs.open(filePath, "a");
  await handle.close();
}

export async function getFileSize(filePath) {
  const stat = await statSafe(filePath);
  return stat?.size ?? 0;
}

export async function writeChunk(filePath, offset, chunk) {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.write(chunk, 0, chunk.length, offset);
  } finally {
    await handle.close();
  }
}

export function sanitizeListEntry(entry, stats) {
  return {
    name: entry.name,
    type: entry.isDirectory()
      ? "dir"
      : entry.isSymbolicLink()
        ? "symlink"
        : "file",
    size: stats?.size ?? 0,
    mtime: stats?.mtimeMs ?? 0,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
    isSymbolicLink: entry.isSymbolicLink(),
  };
}

export function toErrorMessage(error, fallback = "未知错误") {
  if (error?.message) return String(error.message);
  if (error == null) return fallback;
  return String(error);
}
