/**
 * Slave 文件服务测试
 *
 * 目标：
 *  1. 启动一个 slave 节点
 *  2. 暴露 slave.fs root，供 master 通过内建 fs 服务管理
 *  3. 保留一个简单的 DEALER 自动回复处理器，便于 master 用 ping 测试连通性
 *  4. 支持命令行参数：
 *     --encrypted / --no-encrypted
 *     --json
 *
 * 用法：
 *   node test/slave/index.js
 *   node test/slave/index.js <slaveId>
 *   node test/slave/index.js <slaveId> <rootPath>
 *   node test/slave/index.js <slaveId> <rootPath> --encrypted --json
 *
 * 示例：
 *   node test/slave/index.js slave-001
 *   node test/slave/index.js slave-002 ./sandbox/slave-002
 *   node test/slave/index.js slave-003 ./sandbox/slave-003 --encrypted
 *   node test/slave/index.js slave-004 ./sandbox/slave-004 --json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ZNL } from "../../index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 参数解析 ─────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const flags = {
    encrypted: true,
    json: false,
  };

  const positionals = [];

  for (const arg of argv) {
    switch (arg) {
      case "--encrypted":
        flags.encrypted = true;
        break;
      case "--no-encrypted":
        flags.encrypted = false;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        positionals.push(arg);
        break;
    }
  }

  return {
    flags,
    positionals,
  };
}

function printHelp() {
  console.log(`
用法：
  node test/slave/index.js [slaveId] [rootPath] [--encrypted|--no-encrypted] [--json]

参数：
  slaveId
    slave 节点 ID，默认 slave-001

  rootPath
    暴露给 master.fs 的根目录
    默认 test/slave/data/<slaveId>

选项：
  --encrypted
    启用加密（默认开启）

  --no-encrypted
    禁用加密

  --json
    使用 JSON 行日志输出

  --help, -h
    显示帮助

示例：
  node test/slave/index.js
  node test/slave/index.js slave-001
  node test/slave/index.js slave-002 ./sandbox/slave-002 --encrypted
  node test/slave/index.js slave-003 ./sandbox/slave-003 --json
`);
}

const { flags, positionals } = parseCliArgs(process.argv.slice(2));

if (flags.help) {
  printHelp();
  process.exit(0);
}

const id = positionals[0] ?? "slave-001";
const inputRoot = positionals[1] ?? path.join(__dirname, "data", id);

const AUTH_KEY = "znl-demo-fixed-key";
const ROUTER_ENDPOINT = "tcp://127.0.0.1:6003";
const rootPath = path.resolve(inputRoot);
const JSON_OUTPUT = flags.json;
const ENCRYPTED = flags.encrypted;

// ─── 输出工具 ─────────────────────────────────────────────────────────────────

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeError(error) {
  if (!error) return null;
  return {
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
}

function emitJson(level, event, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      slaveId: id,
      ...data,
    }),
  );
}

function logInfo(message, data = {}) {
  if (JSON_OUTPUT) {
    emitJson("info", message, data);
    return;
  }

  console.log(message);
}

function logWarn(message, data = {}) {
  if (JSON_OUTPUT) {
    emitJson("warn", message, data);
    return;
  }

  console.warn(message);
}

function logError(message, error = null, data = {}) {
  if (JSON_OUTPUT) {
    emitJson("error", message, {
      ...data,
      error: safeError(error),
    });
    return;
  }

  console.error(message, error?.message ?? error ?? "");
}

function logEvent(event, data = {}) {
  if (JSON_OUTPUT) {
    emitJson("info", event, data);
  }
}

// ─── 节点初始化 ────────────────────────────────────────────────────────────────

const slave = new ZNL({
  role: "slave",
  id,
  endpoints: {
    router: ROUTER_ENDPOINT,
  },
  maxPending: 2000,
  authKey: AUTH_KEY,
  encrypted: ENCRYPTED,
});

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

async function waitForMasterOnline(timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (slave.isMasterOnline()) return true;
    await sleep(intervalMs);
  }

  return false;
}

async function ensureRootReady(dir) {
  await fs.mkdir(dir, { recursive: true });

  const welcomeFile = path.join(dir, "README.txt");
  const helloFile = path.join(dir, "hello.txt");
  const notesDir = path.join(dir, "notes");
  const sampleJson = path.join(dir, "notes", "sample.json");

  await fs.mkdir(notesDir, { recursive: true });

  try {
    await fs.access(welcomeFile);
  } catch {
    await fs.writeFile(
      welcomeFile,
      [
        `slave id: ${id}`,
        `root path: ${dir}`,
        `encrypted: ${ENCRYPTED}`,
        `json output: ${JSON_OUTPUT}`,
        "",
        "这个目录被暴露给 master.fs 进行远程管理。",
        "你可以在 master 侧执行：",
        "  fs ls",
        "  fs cat README.txt",
        "  fs upload <local> <remote>",
        "  fs download <remote> <local>",
        "  fs mv <from> <to>",
        "  fs rm <path>",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  try {
    await fs.access(helloFile);
  } catch {
    await fs.writeFile(
      helloFile,
      `你好，我是 ${id}\n当前时间：${new Date().toLocaleString("zh-CN", { hour12: false })}\n`,
      "utf8",
    );
  }

  try {
    await fs.access(sampleJson);
  } catch {
    await fs.writeFile(
      sampleJson,
      JSON.stringify(
        {
          slaveId: id,
          enabledFs: true,
          encrypted: ENCRYPTED,
          jsonOutput: JSON_OUTPUT,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

// ─── 启用 fs 服务 ─────────────────────────────────────────────────────────────

await ensureRootReady(rootPath);
slave.fs.setRoot(rootPath);

// ─── 业务 RPC 自动回复处理器 ───────────────────────────────────────────────────

await slave.DEALER(async ({ payload }) => {
  const text = toText(payload);

  if (JSON_OUTPUT) {
    logEvent("rpc_request_received", {
      payload: text,
    });
  } else {
    console.log(`[${id}][收到 Master 请求] ${text}`);
  }

  if (text === "whoami") {
    return JSON.stringify({
      id,
      role: "slave",
      fsRoot: rootPath,
      encrypted: ENCRYPTED,
      jsonOutput: JSON_OUTPUT,
      masterOnline: slave.isMasterOnline(),
      time: Date.now(),
    });
  }

  return `来自 ${id} 的回复：${text}`;
});

// ─── 事件监听 ──────────────────────────────────────────────────────────────────

slave.on("error", (error) => {
  logError(`[${id}][ERROR]`, error, {
    event: "error",
  });
});

slave.on("fs_access", ({ op, path: targetPath, meta }) => {
  if (JSON_OUTPUT) {
    logEvent("fs_access", {
      op: op ?? "",
      path: targetPath ?? "",
      meta: meta ?? null,
    });
    return;
  }

  console.log(
    `[${id}][FS ACCESS] op=${op ?? "<unknown>"} path=${targetPath ?? ""}`,
  );
});

slave.on("fs_error", ({ op, path: targetPath, error }) => {
  if (JSON_OUTPUT) {
    logError("fs_error", error, {
      event: "fs_error",
      op: op ?? "",
      path: targetPath ?? "",
    });
    return;
  }

  console.error(
    `[${id}][FS ERROR] op=${op ?? "<unknown>"} path=${targetPath ?? ""} reason=${error?.message ?? error}`,
  );
});

slave.on("fs_upload_chunk", ({ path: targetPath, chunkId, offset, size }) => {
  if (JSON_OUTPUT) {
    logEvent("fs_upload_chunk", {
      path: targetPath,
      chunkId,
      offset,
      size,
    });
    return;
  }

  console.log(
    `[${id}][FS UPLOAD] path=${targetPath} chunk=${chunkId} offset=${offset} size=${size}`,
  );
});

slave.on("fs_download_chunk", ({ path: targetPath, chunkId, offset, size }) => {
  if (JSON_OUTPUT) {
    logEvent("fs_download_chunk", {
      path: targetPath,
      chunkId,
      offset,
      size,
    });
    return;
  }

  console.log(
    `[${id}][FS DOWNLOAD] path=${targetPath} chunk=${chunkId} offset=${offset} size=${size}`,
  );
});

// ─── 启动节点 ──────────────────────────────────────────────────────────────────

await slave.start();

if (JSON_OUTPUT) {
  logEvent("started", {
    router: ROUTER_ENDPOINT,
    fsRoot: rootPath,
    encrypted: ENCRYPTED,
    json: JSON_OUTPUT,
  });
  logEvent("waiting_master_online", {
    router: ROUTER_ENDPOINT,
  });
} else {
  console.log(`[${id}] 已启动，连接到 ${ROUTER_ENDPOINT}`);
  console.log(`[${id}] fs root = ${rootPath}`);
  console.log(`[${id}] encrypted = ${ENCRYPTED}`);
  console.log(`[${id}] json = ${JSON_OUTPUT}`);
  console.log(`[${id}] 正在等待 Master 在线确认...`);
}

if (await waitForMasterOnline(5000)) {
  if (JSON_OUTPUT) {
    logEvent("master_online", {
      fsRoot: rootPath,
    });
  } else {
    console.log(`[${id}] Master 已在线，可接受远程 fs 管理`);
  }

  try {
    const bootReply = await slave.DEALER(`你好，我是 ${id}，fs root 已启用`, {
      timeoutMs: 4000,
    });

    if (JSON_OUTPUT) {
      logEvent("boot_greeting_reply", {
        reply: toText(bootReply),
      });
    } else {
      console.log(`[${id}][启动问候回复] ${toText(bootReply)}`);
    }
  } catch (error) {
    logError(`[${id}][启动问候失败]`, error, {
      event: "boot_greeting_failed",
    });
  }

  try {
    slave.PUSH("system", `slave ready: ${id} | fs root: ${rootPath}`);
    if (JSON_OUTPUT) {
      logEvent("push_sent", {
        topic: "system",
        payload: `slave ready: ${id} | fs root: ${rootPath}`,
      });
    }
  } catch (error) {
    logError(`[${id}][PUSH 失败]`, error, {
      event: "push_failed",
    });
  }
} else {
  logWarn(
    JSON_OUTPUT
      ? "master_online_wait_timeout"
      : `[${id}] 等待 Master 在线超时，后续会继续自动重连`,
    {
      event: "master_online_wait_timeout",
      fsRoot: rootPath,
    },
  );
}

// ─── 保活日志 ──────────────────────────────────────────────────────────────────

const statusTimer = setInterval(() => {
  if (JSON_OUTPUT) {
    logEvent("status", {
      masterOnline: slave.isMasterOnline(),
      fsRoot: rootPath,
      encrypted: ENCRYPTED,
    });
    return;
  }

  console.log(
    `[${id}][STATUS] masterOnline=${slave.isMasterOnline()} fsRoot=${rootPath}`,
  );
}, 15000);

// ─── 优雅退出 ──────────────────────────────────────────────────────────────────

let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  if (JSON_OUTPUT) {
    logEvent("stopping", {
      fsRoot: rootPath,
    });
  } else {
    console.log(`[${id}] 正在停止...`);
  }

  clearInterval(statusTimer);

  try {
    await slave.stop();
  } catch (error) {
    logError(`[${id}][STOP ERROR]`, error, {
      event: "stop_error",
    });
  }

  if (JSON_OUTPUT) {
    logEvent("stopped", {
      fsRoot: rootPath,
    });
  } else {
    console.log(`[${id}] 已停止`);
  }

  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
