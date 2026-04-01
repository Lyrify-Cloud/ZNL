import fs from "node:fs/promises";
import { ZNL } from "../../../index.js";
import { deriveKeys, digestFrames, encodeAuthProofToken, encryptFrames, toFrameBuffers } from "../../../src/security.js";
import { SECURITY_ENVELOPE_VERSION } from "../../../src/constants.js";
import { buildRequestFrames } from "../../../src/protocol.js";

export const TIMEOUT_SCALE = /^(1|true|yes)$/i.test(process.env.CI ?? "") ? 2 : 1;
export const VERBOSE = /^(1|true|yes)$/i.test(process.env.ZNL_TEST_VERBOSE ?? "");

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
    return originalDealer.call(this, payloadOrHandler, wrapTimeoutOptions(options));
  };

  const originalRouter = ZNL.prototype.ROUTER;
  ZNL.prototype.ROUTER = async function (identityOrHandler, payload, options = {}) {
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

export async function waitForSlave(master, slaveId, maxMs = 2000) {
  const deadline = Date.now() + scaleMs(maxMs);
  while (Date.now() < deadline) {
    if (master.slaves.includes(slaveId)) return true;
    await delay(100);
  }
  return false;
}

export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + scaleMs(timeoutMs);
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(intervalMs);
  }
  return false;
}

export async function safeStop(...nodes) {
  for (const node of nodes.filter(Boolean).reverse()) {
    try {
      await node.stop();
    } catch {}
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
