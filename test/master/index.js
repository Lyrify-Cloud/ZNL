/**
 * Master 交互式测试
 *
 * 目标：
 *  1. 启动 master 节点
 *  2. 提供交互式命令行
 *  3. 通过内建 fs 服务管理指定 slave 的文件
 *  4. 支持 --encrypted / --no-encrypted
 *  5. 支持 --json 输出
 *
 * 用法：
 *   node test/master/index.js
 *   node test/master/index.js --encrypted
 *   node test/master/index.js --no-encrypted
 *   node test/master/index.js --json
 *   node test/master/index.js --encrypted --json
 *
 * 交互命令：
 *   help
 *   slaves
 *   use <slaveId>
 *   ping [text]
 *   fs pwd
 *   fs cd <dir>
 *   fs ls [dir]
 *   fs stat <path>
 *   fs cat <file>
 *   fs create <path>
 *   fs mkdir <path>
 *   fs rm <path>
 *   fs mv <from> <to>
 *   fs upload <localPath> <remotePath>
 *   fs download <remotePath> <localPath>
 *   clear
 *   exit
 */

import path from "node:path";
import { createInterface } from "node:readline";

import { ZNL } from "../../index.js";

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const AUTH_KEY = "znl-demo-fixed-key";
const ROUTER_ENDPOINT = "tcp://127.0.0.1:6003";

// ─── 参数解析 ─────────────────────────────────────────────────────────────────

function parseCliFlags(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let encrypted = true;
  let json = false;

  for (const arg of args) {
    switch (arg) {
      case "--encrypted":
        encrypted = true;
        break;
      case "--no-encrypted":
        encrypted = false;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        printBootHelp();
        process.exit(0);
        break;
      default:
        break;
    }
  }

  return { encrypted, json };
}

function printBootHelp() {
  console.log(`
Master 测试节点

用法：
  node test/master/index.js [--encrypted|--no-encrypted] [--json]

参数：
  --encrypted      启用加密通信（默认）
  --no-encrypted   关闭加密通信
  --json           将结果与事件以 JSON 形式输出
  -h, --help       显示本帮助
`);
}

const options = parseCliFlags(process.argv.slice(2));
const JSON_MODE = options.json;

// ─── 节点初始化 ───────────────────────────────────────────────────────────────

const master = new ZNL({
  role: "master",
  id: "master-demo",
  endpoints: { router: ROUTER_ENDPOINT },
  maxPending: 5000,
  authKey: AUTH_KEY,
  encrypted: options.encrypted,
});

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatTime = (time) =>
  new Date(time).toLocaleString("zh-CN", { hour12: false });

const pad = (value, size) => String(value).padEnd(size, " ");

const isPrintableText = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return true;
  if (buffer.length === 0) return true;

  let suspicious = 0;
  for (const byte of buffer) {
    if (
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126) ||
      byte >= 160
    ) {
      continue;
    }
    suspicious += 1;
  }

  return suspicious / buffer.length < 0.1;
};

const formatSize = (size) => {
  const value = Number(size ?? 0);
  if (!Number.isFinite(value) || value < 0) return "-";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let index = 0;

  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }

  return `${current.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const normalizeRemote = (targetPath) => {
  const raw = String(targetPath ?? "").trim();
  if (!raw || raw === ".") return ".";

  const normalized = raw.replace(/\\/g, "/");
  return path.posix.normalize(normalized);
};

const cwdState = new Map();
let currentSlaveId = null;

const getCurrentCwd = (slaveId = currentSlaveId) =>
  cwdState.get(slaveId) ?? ".";

const setCurrentCwd = (slaveId, dir) => {
  if (!slaveId) return;
  cwdState.set(slaveId, normalizeRemote(dir));
};

const resolveRemotePath = (inputPath, slaveId = currentSlaveId) => {
  const raw = String(inputPath ?? "").trim();
  if (!raw || raw === ".") return getCurrentCwd(slaveId);

  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return normalizeRemote(normalized.slice(1));
  }

  return normalizeRemote(path.posix.join(getCurrentCwd(slaveId), normalized));
};

const ensureSlaveSelected = () => {
  if (!currentSlaveId) {
    throw new Error("当前未选择 slave，请先执行 use <slaveId>。");
  }

  if (!master.slaves.includes(currentSlaveId)) {
    throw new Error(
      `当前选择的 slave "${currentSlaveId}" 不在线，请重新选择可用节点。`,
    );
  }

  return currentSlaveId;
};

const safeJson = (value) =>
  JSON.stringify(
    value,
    (_, current) => {
      if (Buffer.isBuffer(current)) {
        return {
          type: "Buffer",
          encoding: "base64",
          size: current.length,
          data: current.toString("base64"),
        };
      }

      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
      }

      return current;
    },
    2,
  );

function emitJson(type, payload = {}) {
  console.log(
    safeJson({
      type,
      time: new Date().toISOString(),
      ...payload,
    }),
  );
}

function output(type, message, payload = null) {
  if (JSON_MODE) {
    emitJson(type, payload ?? { message });
    return;
  }

  if (message !== undefined && message !== null) {
    console.log(message);
  }
}

function outputError(type, error, extra = {}) {
  const message = error?.message ?? String(error);

  if (JSON_MODE) {
    emitJson(type, {
      ok: false,
      error: {
        message,
        name: error?.name ?? "Error",
      },
      ...extra,
    });
    return;
  }

  console.error(message);
}

function printHelp() {
  if (JSON_MODE) {
    emitJson("help", {
      commands: [
        "help",
        "slaves",
        "use <slaveId>",
        "ping [text]",
        "fs pwd",
        "fs cd <dir>",
        "fs ls [dir]",
        "fs stat <path>",
        "fs cat <file>",
        "fs create <path>",
        "fs mkdir <path>",
        "fs rm <path>",
        "fs mv <from> <to>",
        "fs upload <localPath> <remotePath>",
        "fs download <remotePath> <localPath>",
        "clear",
        "exit",
      ],
      flags: {
        encrypted: options.encrypted,
        json: JSON_MODE,
      },
    });
    return;
  }

  console.log(`
可用命令：
  help
    显示帮助

  slaves
    查看当前在线 slave 列表

  use <slaveId>
    选择当前操作目标 slave

  ping [text]
    向当前 slave 发送一个普通 RPC 请求

  fs pwd
    查看当前 slave 的远端工作目录

  fs cd <dir>
    切换当前 slave 的远端工作目录
    说明：这是 master 本地维护的“工作目录”概念，不会修改 slave 进程自身 cwd

  fs ls [dir]
    列出远端目录内容

  fs stat <path>
    查看远端文件/目录信息

  fs cat <file>
    读取远端文件并尝试按文本打印

  fs create <path>
    在远端创建空文件

  fs mkdir <path>
    在远端创建目录

  fs rm <path>
    删除远端文件或目录

  fs mv <from> <to>
    重命名/移动远端文件或目录

  fs upload <localPath> <remotePath>
    上传本地文件到当前 slave

  fs download <remotePath> <localPath>
    从当前 slave 下载文件到本地

  clear
    清屏

  exit
    退出程序

启动参数：
  --encrypted / --no-encrypted
  --json

路径说明：
  - fs 命令中的远端路径默认相对于当前 fs cwd
  - 以 / 开头的远端路径会被视为 slave root 下的绝对相对路径
`);
}

function printSlaveList() {
  if (JSON_MODE) {
    emitJson("slaves", {
      currentSlaveId,
      slaves: master.slaves.map((id) => ({
        id,
        cwd: getCurrentCwd(id),
        selected: id === currentSlaveId,
      })),
    });
    return;
  }

  if (master.slaves.length === 0) {
    console.log("[MASTER] 当前没有在线 slave");
    return;
  }

  console.log("[MASTER] 当前在线 slave：");
  for (const id of master.slaves) {
    const marker = id === currentSlaveId ? "*" : " ";
    console.log(` ${marker} ${id}  cwd=${getCurrentCwd(id)}`);
  }
}

function printEntries(meta, slaveId) {
  const entries = Array.isArray(meta?.entries) ? meta.entries : [];
  const base = meta?.path || ".";

  if (JSON_MODE) {
    emitJson("fs.list", {
      ok: true,
      slaveId,
      cwd: getCurrentCwd(slaveId),
      path: base,
      entries,
    });
    return;
  }

  console.log(`[MASTER][FS] 目录列表: ${base}`);
  if (entries.length === 0) {
    console.log("  <empty>");
    return;
  }

  const rows = [...entries].sort((a, b) => {
    const typeA = a?.isDirectory ? 0 : 1;
    const typeB = b?.isDirectory ? 0 : 1;
    if (typeA !== typeB) return typeA - typeB;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
  });

  for (const entry of rows) {
    const type = entry?.isDirectory ? "dir " : "file";
    const size = entry?.isDirectory ? "-" : formatSize(entry?.size);
    const mtime = entry?.mtime ? formatTime(entry.mtime) : "-";
    console.log(
      `  ${pad(type, 5)} ${pad(size, 12)} ${pad(mtime, 20)} ${entry?.name ?? "<unknown>"}`,
    );
  }
}

function parseArgs(line) {
  const result = [];
  const regex =
    /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g;

  for (const match of line.matchAll(regex)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    result.push(token.replace(/\\(["'\\])/g, "$1"));
  }

  return result;
}

// ─── RPC 自动回复处理器 ──────────────────────────────────────────────────────

master.ROUTER(async ({ identityText, payload }) => {
  const text = toText(payload);

  if (JSON_MODE) {
    emitJson("rpc.incoming", {
      from: identityText,
      payload: text,
    });
  } else {
    console.log(`[MASTER][RPC ←] from=${identityText}  msg="${text}"`);
  }

  return `master reply: ${text}`;
});

// ─── 事件监听 ─────────────────────────────────────────────────────────────────

master.on("slave_connected", (id) => {
  if (!cwdState.has(id)) {
    setCurrentCwd(id, ".");
  }

  if (!currentSlaveId) {
    currentSlaveId = id;
  }

  if (JSON_MODE) {
    emitJson("slave_connected", {
      slaveId: id,
      currentSlaveId,
      slaves: master.slaves,
    });
    return;
  }

  console.log(`[MASTER][↑ 上线] ${id}`);
  if (currentSlaveId === id) {
    console.log(`[MASTER] 已自动选择当前 slave: ${id}`);
  }
});

master.on("slave_disconnected", (id) => {
  if (currentSlaveId === id) {
    currentSlaveId = master.slaves[0] ?? null;
  }

  if (JSON_MODE) {
    emitJson("slave_disconnected", {
      slaveId: id,
      currentSlaveId,
      slaves: master.slaves,
    });
    return;
  }

  console.log(`[MASTER][↓ 下线] ${id}`);

  if (currentSlaveId) {
    console.log(`[MASTER] 当前 slave 已切换为: ${currentSlaveId}`);
  } else {
    console.log("[MASTER] 当前没有可用 slave");
  }
});

master.on("push", ({ identityText, topic, payload }) => {
  const text = toText(payload);

  if (JSON_MODE) {
    emitJson("push", {
      from: identityText ?? null,
      topic: topic ?? null,
      payload: text,
    });
    return;
  }

  console.log(
    `[MASTER][PUSH ←] from=${identityText ?? "<unknown>"} topic=${topic ?? "<none>"} payload="${text}"`,
  );
});

master.on("error", (error) => {
  if (JSON_MODE) {
    emitJson("error", {
      ok: false,
      error: {
        message: error?.message ?? String(error),
        name: error?.name ?? "Error",
      },
    });
    return;
  }

  console.error("[MASTER][ERROR]", error?.message ?? error);
});

master.on("auth_failed", ({ identityText, reason }) => {
  if (JSON_MODE) {
    emitJson("auth_failed", {
      identityText,
      reason: reason ?? "<unknown>",
    });
    return;
  }

  console.error(
    `[MASTER][AUTH FAILED] from=${identityText} reason=${reason ?? "<unknown>"}`,
  );
});

// ─── 命令处理 ─────────────────────────────────────────────────────────────────

async function handleUse(args) {
  const slaveId = args[0];
  if (!slaveId) {
    throw new Error("用法: use <slaveId>");
  }

  if (!master.slaves.includes(slaveId)) {
    throw new Error(`slave "${slaveId}" 当前不在线。`);
  }

  currentSlaveId = slaveId;
  if (!cwdState.has(slaveId)) {
    setCurrentCwd(slaveId, ".");
  }

  output("use", `[MASTER] 当前 slave = ${currentSlaveId}`, {
    ok: true,
    slaveId: currentSlaveId,
    cwd: getCurrentCwd(currentSlaveId),
  });

  if (!JSON_MODE) {
    console.log(`[MASTER] 当前远端 cwd = ${getCurrentCwd(currentSlaveId)}`);
  }
}

async function handlePing(args) {
  const slaveId = ensureSlaveSelected();
  const text =
    args.length > 0 ? args.join(" ") : `ping @ ${new Date().toISOString()}`;
  const reply = await master.ROUTER(slaveId, text, { timeoutMs: 4000 });

  output("ping", `[MASTER][RPC →] ${slaveId} 回复: "${toText(reply)}"`, {
    ok: true,
    slaveId,
    request: text,
    reply: toText(reply),
  });
}

async function handleFs(args) {
  const slaveId = ensureSlaveSelected();
  const sub = args[0];

  if (!sub) {
    throw new Error(
      "用法: fs <pwd|cd|ls|stat|cat|create|mkdir|rm|mv|upload|download> ...",
    );
  }

  switch (sub) {
    case "pwd": {
      output(
        "fs.pwd",
        `[MASTER][FS] ${slaveId} cwd = ${getCurrentCwd(slaveId)}`,
        {
          ok: true,
          slaveId,
          cwd: getCurrentCwd(slaveId),
        },
      );
      return;
    }

    case "cd": {
      const input = args[1];
      if (!input) {
        throw new Error("用法: fs cd <dir>");
      }

      const target = resolveRemotePath(input, slaveId);
      const stat = await master.fs.stat(slaveId, target, { timeoutMs: 5000 });

      if (!stat.isDirectory) {
        throw new Error(`目标不是目录: ${target}`);
      }

      setCurrentCwd(slaveId, target);

      output("fs.cd", `[MASTER][FS] cwd => ${getCurrentCwd(slaveId)}`, {
        ok: true,
        slaveId,
        cwd: getCurrentCwd(slaveId),
        stat,
      });
      return;
    }

    case "ls": {
      const dir = args[1]
        ? resolveRemotePath(args[1], slaveId)
        : getCurrentCwd(slaveId);
      const meta = await master.fs.list(slaveId, dir, { timeoutMs: 8000 });
      printEntries(meta, slaveId);
      return;
    }

    case "stat": {
      const targetArg = args[1];
      if (!targetArg) {
        throw new Error("用法: fs stat <path>");
      }

      const target = resolveRemotePath(targetArg, slaveId);
      const meta = await master.fs.stat(slaveId, target, { timeoutMs: 5000 });

      if (JSON_MODE) {
        emitJson("fs.stat", {
          ok: true,
          slaveId,
          meta,
        });
        return;
      }

      console.log(`[MASTER][FS][STAT] slave=${slaveId}`);
      console.log(`  path       : ${meta.path}`);
      console.log(
        `  type       : ${meta.isDirectory ? "directory" : meta.isFile ? "file" : "unknown"}`,
      );
      console.log(
        `  size       : ${formatSize(meta.size)} (${meta.size ?? 0})`,
      );
      console.log(
        `  mtime      : ${meta.mtime ? formatTime(meta.mtime) : "-"}`,
      );
      return;
    }

    case "cat": {
      const targetArg = args[1];
      if (!targetArg) {
        throw new Error("用法: fs cat <file>");
      }

      const target = resolveRemotePath(targetArg, slaveId);
      const result = await master.fs.get(slaveId, target, { timeoutMs: 10000 });
      const buffer = Array.isArray(result.body) ? result.body[0] : null;

      if (!Buffer.isBuffer(buffer)) {
        throw new Error("远端返回的文件内容为空或格式非法。");
      }

      if (JSON_MODE) {
        emitJson("fs.cat", {
          ok: true,
          slaveId,
          meta: result.meta ?? null,
          encoding: isPrintableText(buffer) ? "utf8" : "base64",
          content: isPrintableText(buffer)
            ? buffer.toString("utf8")
            : buffer.toString("base64"),
          size: buffer.length,
          printable: isPrintableText(buffer),
        });
        return;
      }

      console.log(
        `[MASTER][FS][CAT] path=${result.meta?.path ?? target} size=${formatSize(buffer.length)}`,
      );

      if (!isPrintableText(buffer)) {
        console.log(
          "[MASTER][FS][CAT] 检测到二进制内容，以下输出前 64 字节 hex：",
        );
        console.log(buffer.subarray(0, 64).toString("hex"));
        return;
      }

      console.log("=".repeat(80));
      console.log(buffer.toString("utf8"));
      console.log("=".repeat(80));
      return;
    }

    case "create": {
      const targetArg = args[1];
      if (!targetArg) {
        throw new Error("用法: fs create <path>");
      }

      const target = resolveRemotePath(targetArg, slaveId);
      const meta = await master.fs.create(slaveId, target, {
        timeoutMs: 10000,
      });

      output("fs.create", `[MASTER][FS] 已创建空文件: ${target}`, {
        ok: true,
        slaveId,
        target,
        meta,
      });
      return;
    }

    case "mkdir": {
      const targetArg = args[1];
      if (!targetArg) {
        throw new Error("用法: fs mkdir <path>");
      }

      const target = resolveRemotePath(targetArg, slaveId);
      const meta = await master.fs.mkdir(slaveId, target, {
        timeoutMs: 10000,
      });

      output("fs.mkdir", `[MASTER][FS] 已创建目录: ${target}`, {
        ok: true,
        slaveId,
        target,
        meta,
      });
      return;
    }

    case "rm": {
      const targetArg = args[1];
      if (!targetArg) {
        throw new Error("用法: fs rm <path>");
      }

      const target = resolveRemotePath(targetArg, slaveId);
      const meta = await master.fs.delete(slaveId, target, {
        timeoutMs: 10000,
      });

      output("fs.rm", `[MASTER][FS] 已删除: ${target}`, {
        ok: true,
        slaveId,
        target,
        meta,
      });
      return;
    }

    case "mv": {
      const fromArg = args[1];
      const toArg = args[2];

      if (!fromArg || !toArg) {
        throw new Error("用法: fs mv <from> <to>");
      }

      const fromPath = resolveRemotePath(fromArg, slaveId);
      const toPath = resolveRemotePath(toArg, slaveId);

      const meta = await master.fs.rename(slaveId, fromPath, toPath, {
        timeoutMs: 10000,
      });

      output("fs.mv", `[MASTER][FS] 已重命名: ${fromPath} -> ${toPath}`, {
        ok: true,
        slaveId,
        from: fromPath,
        to: toPath,
        meta,
      });
      return;
    }

    case "upload": {
      const localArg = args[1];
      const remoteArg = args[2];

      if (!localArg || !remoteArg) {
        throw new Error("用法: fs upload <localPath> <remotePath>");
      }

      const localPath = path.resolve(localArg);
      const remotePath = resolveRemotePath(remoteArg, slaveId);

      if (!JSON_MODE) {
        console.log(
          `[MASTER][FS] 开始上传: ${localPath} -> ${slaveId}:${remotePath}`,
        );
      }

      const meta = await master.fs.upload(slaveId, localPath, remotePath, {
        timeoutMs: 15000,
      });

      output(
        "fs.upload",
        `[MASTER][FS] 上传完成: session=${meta.sessionId ?? "<none>"} path=${meta.path ?? remotePath}`,
        {
          ok: true,
          slaveId,
          localPath,
          remotePath,
          meta,
        },
      );
      return;
    }

    case "download": {
      const remoteArg = args[1];
      const localArg = args[2];

      if (!remoteArg || !localArg) {
        throw new Error("用法: fs download <remotePath> <localPath>");
      }

      const remotePath = resolveRemotePath(remoteArg, slaveId);
      const localPath = path.resolve(localArg);

      if (!JSON_MODE) {
        console.log(
          `[MASTER][FS] 开始下载: ${slaveId}:${remotePath} -> ${localPath}`,
        );
      }

      const meta = await master.fs.download(slaveId, remotePath, localPath, {
        timeoutMs: 15000,
      });

      output(
        "fs.download",
        `[MASTER][FS] 下载完成: session=${meta.sessionId ?? "<none>"} path=${meta.path ?? remotePath}`,
        {
          ok: true,
          slaveId,
          remotePath,
          localPath,
          meta,
        },
      );
      return;
    }

    default:
      throw new Error(`未知 fs 子命令: ${sub}`);
  }
}

async function handleCommand(line) {
  const args = parseArgs(line.trim());
  if (args.length === 0) return;

  const [command, ...rest] = args;

  switch (command) {
    case "help":
    case "?":
      printHelp();
      return;

    case "slaves":
      printSlaveList();
      return;

    case "use":
      await handleUse(rest);
      return;

    case "ping":
      await handlePing(rest);
      return;

    case "fs":
      await handleFs(rest);
      return;

    case "clear":
      if (!JSON_MODE) {
        console.clear();
      }
      return;

    case "exit":
    case "quit":
      await shutdown();
      return;

    default:
      if (JSON_MODE) {
        emitJson("command_error", {
          ok: false,
          error: {
            message: `未知命令: ${command}`,
          },
        });
      } else {
        console.log(`未知命令: ${command}`);
        console.log(`输入 help 查看可用命令`);
      }
  }
}

// ─── 启动交互式 CLI ──────────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  prompt: "master> ",
});

let shuttingDown = false;

function showPrompt() {
  if (!shuttingDown && !JSON_MODE) {
    rl.prompt();
  }
}

async function bootstrap() {
  await master.start();

  if (JSON_MODE) {
    emitJson("startup", {
      ok: true,
      router: ROUTER_ENDPOINT,
      encrypted: options.encrypted,
      json: JSON_MODE,
      role: "master",
      id: "master-demo",
    });
  } else {
    console.log(`[MASTER] 已启动，监听 ${ROUTER_ENDPOINT}`);
    console.log(`[MASTER] encrypted = ${options.encrypted}`);
    console.log(`[MASTER] json = ${JSON_MODE}`);
    console.log("[MASTER] 交互式文件管理 CLI 已就绪");
    console.log("[MASTER] 输入 help 查看命令\n");
  }

  await sleep(100);

  printSlaveList();
  showPrompt();
}

rl.on("line", async (line) => {
  rl.pause();

  try {
    await handleCommand(line);
  } catch (error) {
    if (JSON_MODE) {
      emitJson("command_error", {
        ok: false,
        error: {
          message: error?.message ?? String(error),
          name: error?.name ?? "Error",
        },
        input: line,
      });
    } else {
      console.error("[MASTER][CMD ERROR]", error?.message ?? error);
    }
  } finally {
    rl.resume();
    showPrompt();
  }
});

rl.on("close", async () => {
  await shutdown();
});

// ─── 优雅关闭 ─────────────────────────────────────────────────────────────────

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (JSON_MODE) {
    emitJson("shutdown", { phase: "stopping" });
  } else {
    console.log("\n[MASTER] 正在关闭...");
  }

  try {
    rl.close();
  } catch {}

  try {
    await master.stop();
  } catch (error) {
    if (JSON_MODE) {
      emitJson("shutdown_error", {
        ok: false,
        error: {
          message: error?.message ?? String(error),
          name: error?.name ?? "Error",
        },
      });
    } else {
      console.error("[MASTER][STOP ERROR]", error?.message ?? error);
    }
  }

  if (JSON_MODE) {
    emitJson("shutdown", { phase: "stopped" });
  } else {
    console.log("[MASTER] 已停止");
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── 主入口 ───────────────────────────────────────────────────────────────────

bootstrap().catch(async (error) => {
  if (JSON_MODE) {
    emitJson("fatal", {
      ok: false,
      error: {
        message: error?.message ?? String(error),
        name: error?.name ?? "Error",
      },
    });
  } else {
    console.error("[MASTER][FATAL]", error?.message ?? error);
  }

  try {
    await master.stop();
  } catch {}

  process.exit(1);
});
