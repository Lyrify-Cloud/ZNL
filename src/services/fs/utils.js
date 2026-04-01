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
  return String(value ?? "").replace(/\\/g, "/");
}

export function normalizePolicyPath(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  const normalized = text.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized === "." ? "" : normalized;
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

export async function lstatSafe(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return null;
  }
}

export async function realpathSafe(targetPath) {
  try {
    return await fs.realpath(targetPath);
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

function escapeRegex(text) {
  return String(text).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  const source = normalizePolicyPath(glob);
  if (!source) return /^$/u;

  let pattern = "^";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

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
  return new RegExp(pattern, "u");
}

export function normalizeFsPolicy(policy = {}) {
  const input =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? policy
      : {};

  const readOnly = Boolean(input.readOnly);
  const allowDelete = readOnly ? false : input.allowDelete !== false;
  const allowPatch = readOnly ? false : input.allowPatch !== false;
  const allowUpload = readOnly ? false : input.allowUpload !== false;

  const allowedPaths = Array.isArray(input.allowedPaths)
    ? input.allowedPaths
        .map((item) => normalizePolicyPath(item))
        .filter(Boolean)
    : [];

  const denyGlobs = Array.isArray(input.denyGlobs)
    ? input.denyGlobs.map((item) => normalizePolicyPath(item)).filter(Boolean)
    : [];

  return {
    readOnly,
    allowDelete,
    allowPatch,
    allowUpload,
    allowedPaths,
    denyGlobs,
    denyMatchers: denyGlobs.map((item) => ({
      pattern: item,
      regex: globToRegExp(item),
    })),
  };
}

export function toPolicyRelativePath(inputPath) {
  const normalized = normalizeClientPath(inputPath);
  const posixPath = normalizePolicyPath(toPosixPath(normalized));
  return posixPath;
}

export function isPathAllowedByPolicy(policy, inputPath) {
  const effective = normalizeFsPolicy(policy);
  const relativePath = toPolicyRelativePath(inputPath);

  if (effective.allowedPaths.length > 0) {
    const matched = effective.allowedPaths.some((allowed) => {
      if (!allowed) return true;
      return relativePath === allowed || relativePath.startsWith(`${allowed}/`);
    });

    if (!matched) {
      return {
        ok: false,
        reason: "路径不在 allowedPaths 白名单内。",
        path: relativePath,
      };
    }
  }

  const denied = effective.denyMatchers.find(({ regex }) =>
    regex.test(relativePath),
  );
  if (denied) {
    return {
      ok: false,
      reason: `路径命中 denyGlobs 规则：${denied.pattern}`,
      path: relativePath,
    };
  }

  return {
    ok: true,
    path: relativePath,
  };
}

export function assertPathAllowed(policy, inputPath) {
  const result = isPathAllowedByPolicy(policy, inputPath);
  if (!result.ok) {
    throw new Error(result.reason || "路径被策略拒绝。");
  }
  return result;
}

export function assertOperationAllowed(policy, operation) {
  const effective = normalizeFsPolicy(policy);
  const op = String(operation ?? "").trim();

  if (!op) return effective;

  if (effective.readOnly) {
    if (["delete", "patch", "upload", "rename"].includes(op)) {
      throw new Error(`当前 fs root 为只读模式，禁止执行 ${op} 操作。`);
    }
  }

  if (op === "delete" && !effective.allowDelete) {
    throw new Error("当前 fs 策略禁止 delete 操作。");
  }

  if (op === "patch" && !effective.allowPatch) {
    throw new Error("当前 fs 策略禁止 patch 操作。");
  }

  if (op === "upload" && !effective.allowUpload) {
    throw new Error("当前 fs 策略禁止 upload 操作。");
  }

  return effective;
}

async function assertPathSegmentNotSymlink(targetPath, label) {
  const stats = await lstatSafe(targetPath);
  if (!stats) return false;

  if (stats.isSymbolicLink()) {
    throw new Error(
      `${label} 包含符号链接，已拒绝访问：${toPosixPath(targetPath)}`,
    );
  }

  return true;
}

export async function assertNoSymlinkInPath(root, targetPath) {
  const base = assertRoot(root);
  const resolved = toSafePath(base, path.relative(base, targetPath) || ".");

  await assertPathSegmentNotSymlink(base, "fs root");

  const relative = path.relative(base, resolved);
  if (!relative || relative === ".") {
    return resolved;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = base;

  for (const segment of segments) {
    current = path.join(current, segment);
    const exists = await assertPathSegmentNotSymlink(current, "目标路径");
    if (!exists) break;
  }

  return resolved;
}

export async function resolveSecurePath(root, inputPath, options = {}) {
  const { allowMissingLeaf = true } = options;
  const absolutePath = toSafePath(root, inputPath);

  await assertNoSymlinkInPath(root, absolutePath);

  if (!allowMissingLeaf) {
    const stats = await lstatSafe(absolutePath);
    if (!stats) {
      throw new Error("目标不存在。");
    }
    if (stats.isSymbolicLink()) {
      throw new Error("目标路径包含符号链接，已拒绝访问。");
    }
  }

  return absolutePath;
}
