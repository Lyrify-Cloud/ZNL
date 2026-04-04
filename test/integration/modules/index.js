import { runConstructorAndApiTests } from "./constructor-and-api.test.js";
import { runRpcAndPayloadTests } from "./rpc-and-payload.test.js";
import { runLifecycleAndPendingTests } from "./lifecycle-and-pending.test.js";
import { runPubsubAndHeartbeatTests } from "./pubsub-and-heartbeat.test.js";
import { runSecurityTests } from "./security.test.js";
import { runFsServiceTests } from "./fs-service.test.js";
import { runRunnerOutputTests } from "./runner-output.test.js";

/**
 * Canonical integration module order used by full-suite runs.
 */
export const canonicalModuleNames = Object.freeze([
  "constructor",
  "rpc",
  "lifecycle",
  "pubsub",
  "security",
  "fs",
  "runner",
]);

/**
 * Canonical module runners (no aliases).
 * Kept as a Map to preserve deterministic execution order.
 */
export const moduleRunners = new Map([
  ["constructor", runConstructorAndApiTests],
  ["rpc", runRpcAndPayloadTests],
  ["lifecycle", runLifecycleAndPendingTests],
  ["pubsub", runPubsubAndHeartbeatTests],
  ["security", runSecurityTests],
  ["fs", runFsServiceTests],
  ["runner", runRunnerOutputTests],
]);

/**
 * Aliases for CLI convenience.
 */
export const moduleAliases = Object.freeze({
  api: "constructor",
  payload: "rpc",
  pending: "lifecycle",
  heartbeat: "pubsub",
});

/**
 * Expanded module map including canonical names + aliases.
 */
export const modules = new Map(moduleRunners);

for (const [alias, canonical] of Object.entries(moduleAliases)) {
  const run = moduleRunners.get(canonical);
  if (run) modules.set(alias, run);
}

/**
 * Alias hints for help output.
 */
export const aliasHints = Object.freeze(
  Object.entries(moduleAliases).map(([alias, target]) => [alias, target]),
);

export function resolveCanonicalModuleName(name) {
  const input = String(name ?? "")
    .trim()
    .toLowerCase();
  if (!input) return "";
  return moduleAliases[input] || input;
}

export function getModuleRunner(name) {
  const canonical = resolveCanonicalModuleName(name);
  return moduleRunners.get(canonical) || null;
}

export default {
  canonicalModuleNames,
  moduleRunners,
  moduleAliases,
  modules,
  aliasHints,
  resolveCanonicalModuleName,
  getModuleRunner,
};
