import { TestRunner } from "./runner.js";
import { TEST_CONFIG, VERBOSE } from "./helpers/common.js";
import {
  handleFatalError,
  installGlobalFatalHandlers,
} from "./helpers/errors.js";
import { moduleRunners, canonicalModuleNames } from "./modules/index.js";

const normalizeReporter = (value) => {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "json" ? "json" : "human";
};

function resolveReporter(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] ?? "").trim();

    if (token === "--json") return "json";

    if (token === "--reporter" || token === "-r") {
      return normalizeReporter(argv[i + 1]);
    }

    if (token.startsWith("--reporter=")) {
      return normalizeReporter(token.slice("--reporter=".length));
    }
  }

  return normalizeReporter(process.env.ZNL_TEST_REPORTER);
}

function normalizeModuleEntries(registry) {
  if (registry instanceof Map) {
    return Array.from(registry.entries()).map(([name, run]) => ({ name, run }));
  }

  if (Array.isArray(registry)) {
    return registry
      .map((item) => {
        if (Array.isArray(item)) {
          const [name, run] = item;
          return { name, run };
        }

        if (item && typeof item === "object") {
          const name = item.name ?? item.id ?? item.key;
          const run = item.run ?? item.execute ?? item.fn;
          return { name, run };
        }

        return null;
      })
      .filter(
        (entry) =>
          entry &&
          typeof entry.name === "string" &&
          typeof entry.run === "function",
      );
  }

  if (registry && typeof registry === "object") {
    return Object.entries(registry)
      .map(([name, run]) => ({ name, run }))
      .filter((entry) => typeof entry.run === "function");
  }

  return [];
}

export async function runIntegrationTests({
  reporter = resolveReporter(),
} = {}) {
  const selectedReporter = normalizeReporter(reporter);
  const runner = new TestRunner({
    verbose: VERBOSE || TEST_CONFIG.verbose,
    reporter: selectedReporter,
    exitOnComplete: false,
  });

  const entries = normalizeModuleEntries(moduleRunners);
  if (entries.length === 0) {
    throw new Error("模块注册表为空：请检查 test/integration/modules/index.js");
  }

  const moduleHint =
    Array.isArray(canonicalModuleNames) && canonicalModuleNames.length > 0
      ? ` [${canonicalModuleNames.join(", ")}]`
      : "";

  runner.banner(`ZNL 集成测试（模块化版）${moduleHint}`);

  for (const entry of entries) {
    await entry.run(runner);
  }

  return runner.summary({ format: selectedReporter, exitProcess: false });
}

async function main() {
  installGlobalFatalHandlers({ source: "integration" });

  try {
    const report = await runIntegrationTests();
    const hasFailure =
      report?.totals?.testsFailed > 0 || report?.totals?.assertionsFailed > 0;
    process.exitCode = hasFailure ? 1 : 0;
  } catch (error) {
    if (!handleFatalError(error, { source: "integration" })) {
      process.exitCode = 0;
    }
  }
}

await main();

if (process.exitCode == null) {
  process.exitCode = 0;
}
setImmediate(() => process.exit(process.exitCode));
