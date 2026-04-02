import fs from "node:fs/promises";
import { ZNL } from "../../../index.js";
import {
  deriveKeys,
  digestFrames,
  encodeAuthProofToken,
  encryptFrames,
  toFrameBuffers,
} from "../../../src/security.js";
import { SECURITY_ENVELOPE_VERSION } from "../../../src/constants.js";
import { buildRequestFrames } from "../../../src/protocol.js";

const TRUE_RE = /^(1|true|yes|on)$/i;

const envBool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return Boolean(fallback);
  return TRUE_RE.test(String(raw).trim());
};

const envNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return Number(fallback);
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number(fallback);
};

export const TIMEOUT_SCALE = Math.max(
  0.1,
  envNumber("ZNL_TEST_TIMEOUT_SCALE", envBool("CI", false) ? 2 : 1),
);

export const VERBOSE = envBool("ZNL_TEST_VERBOSE", false);

export const TEST_CONFIG = Object.freeze({
  timeoutScale: TIMEOUT_SCALE,
  verbose: VERBOSE,
  wait: Object.freeze({
    defaultTimeoutMs: envNumber("ZNL_TEST_WAIT_TIMEOUT_MS", 2000),
    defaultIntervalMs: envNumber("ZNL_TEST_WAIT_INTERVAL_MS", 50),
    registerTimeoutMs: envNumber("ZNL_TEST_REGISTER_TIMEOUT_MS", 3000),
    startupDelayMs: envNumber("ZNL_TEST_STARTUP_DELAY_MS", 200),
    onlineTimeoutMs: envNumber("ZNL_TEST_ONLINE_TIMEOUT_MS", 2000),
    offlineTimeoutMs: envNumber("ZNL_TEST_OFFLINE_TIMEOUT_MS", 2500),
  }),
});

export const toText = (value) =>
  Buffer.isBuffer(value) ? value.toString("utf8") : String(value);

export const scaleMs = (ms) => Math.round(Number(ms) * TIMEOUT_SCALE);

export const delay = (ms) =>
  new Promise((resolve) => setTimeout(resolve, scaleMs(ms)));

export const log = (...args) => {
  if (VERBOSE) console.log(...args);
};

export const fmt = (payload) => {
  const text = Array.isArray(payload)
    ? payload.map(toText).join(" | ")
    : toText(payload);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

export const readFsBodyText = (result) => {
  const frame = Array.isArray(result?.body) ? result.body[0] : null;
  return Buffer.isBuffer(frame) ? frame.toString("utf8") : String(frame ?? "");
};

export async function resetDir(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
}

export function wrapTimeoutOptions(options) {
  if (!options || typeof options.timeoutMs !== "number") return options;
  return { ...options, timeoutMs: scaleMs(options.timeoutMs) };
}

let timeoutPatched = false;

export function installTimeoutScaling() {
  if (timeoutPatched) return;

  const originalDealer = ZNL.prototype.DEALER;
  ZNL.prototype.DEALER = async function (payloadOrHandler, options = {}) {
    if (typeof payloadOrHandler === "function") {
      return originalDealer.call(this, payloadOrHandler);
    }
    return originalDealer.call(
      this,
      payloadOrHandler,
      wrapTimeoutOptions(options),
    );
  };

  const originalRouter = ZNL.prototype.ROUTER;
  ZNL.prototype.ROUTER = async function (
    identityOrHandler,
    payload,
    options = {},
  ) {
    if (typeof identityOrHandler === "function") {
      return originalRouter.call(this, identityOrHandler);
    }
    return originalRouter.call(
      this,
      identityOrHandler,
      payload,
      wrapTimeoutOptions(options),
    );
  };

  timeoutPatched = true;
}

export function attachLogger(node, label, state = { silent: false }) {
  node.on("request", ({ identityText, payload }) => {
    if (state.silent) return;
    const from = identityText ? `  from=${identityText}` : "";
    log(`    [${label}] ◀ REQ${from}  "${fmt(payload)}"`);
  });

  node.on("response", ({ identityText, payload }) => {
    if (state.silent) return;
    const from = identityText ? `  from=${identityText}` : "";
    log(`    [${label}] ◀ RES${from}  "${fmt(payload)}"`);
  });

  return state;
}

export async function waitFor(
  predicate,
  {
    timeoutMs = TEST_CONFIG.wait.defaultTimeoutMs,
    intervalMs = TEST_CONFIG.wait.defaultIntervalMs,
  } = {},
) {
  const deadline = Date.now() + scaleMs(timeoutMs);

  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(intervalMs);
  }

  return false;
}

export async function waitForRegistered(
  master,
  slaveId,
  { timeoutMs = TEST_CONFIG.wait.registerTimeoutMs, intervalMs = 100 } = {},
) {
  return waitFor(() => master?.slaves?.includes(slaveId), {
    timeoutMs,
    intervalMs,
  });
}

export async function waitForOnline(
  slave,
  { timeoutMs = TEST_CONFIG.wait.onlineTimeoutMs, intervalMs = 100 } = {},
) {
  return waitFor(
    () => Boolean(slave?.masterOnline) && Boolean(slave?.isMasterOnline?.()),
    { timeoutMs, intervalMs },
  );
}

export async function waitForOffline(
  slave,
  { timeoutMs = TEST_CONFIG.wait.offlineTimeoutMs, intervalMs = 100 } = {},
) {
  return waitFor(
    () => !slave?.masterOnline && !Boolean(slave?.isMasterOnline?.()),
    { timeoutMs, intervalMs },
  );
}

export async function waitForCount(
  getCount,
  expected,
  {
    timeoutMs = TEST_CONFIG.wait.defaultTimeoutMs,
    intervalMs = TEST_CONFIG.wait.defaultIntervalMs,
    compare = (count, exp) => count >= exp,
  } = {},
) {
  return waitFor(async () => compare(await getCount(), expected), {
    timeoutMs,
    intervalMs,
  });
}

/**
 * @deprecated 请改用 waitForRegistered(master, slaveId, { timeoutMs, intervalMs }).
 * Backward-compatible alias:
 * waitForSlave(master, slaveId, maxMs)
 */
export async function waitForSlave(master, slaveId, maxMs = 2000) {
  return waitForRegistered(master, slaveId, {
    timeoutMs: maxMs,
    intervalMs: 100,
  });
}

export async function safeStop(...nodes) {
  for (const node of nodes.filter(Boolean).reverse()) {
    try {
      await node.stop();
    } catch {
      // keep teardown best-effort for compatibility
    }
  }
}

export function buildEncryptedRequestFrames({
  authKey,
  nodeId,
  requestId,
  payload,
  nonce,
  timestamp,
}) {
  const { signKey, encryptKey } = deriveKeys(authKey);
  const rawFrames = toFrameBuffers(payload);

  const aad = Buffer.from(
    `znl-aad-v1|request|${String(nodeId)}|${String(requestId ?? "")}`,
    "utf8",
  );
  const { iv, ciphertext, tag } = encryptFrames(encryptKey, rawFrames, aad);

  const payloadFrames = [
    Buffer.from(SECURITY_ENVELOPE_VERSION),
    iv,
    tag,
    ciphertext,
  ];

  const envelope = {
    kind: "request",
    nodeId: String(nodeId),
    requestId: String(requestId ?? ""),
    timestamp: Number(timestamp),
    nonce: String(nonce),
    payloadDigest: digestFrames(payloadFrames),
  };

  const proof = encodeAuthProofToken(signKey, envelope);
  const frames = buildRequestFrames(requestId, payloadFrames, proof);

  return { frames, payloadFrames };
}
