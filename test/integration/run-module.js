import { TestRunner } from "./runner.js";
import { TEST_CONFIG, VERBOSE } from "./helpers/common.js";
import {
  handleFatalError,
  installGlobalFatalHandlers,
} from "./helpers/errors.js";
import {
  aliasHints,
  canonicalModuleNames,
  modules,
  resolveCanonicalModuleName,
} from "./modules/index.js";

const normalizeReporter = (value) => {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "json" ? "json" : "human";
};

function parseCli(argv = process.argv.slice(2)) {
  let moduleInput = "";
  let reporter = normalizeReporter(process.env.ZNL_TEST_REPORTER);
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] ?? "").trim();

    if (!token) continue;

    if (token === "--help" || token === "-h" || token === "help") {
      help = true;
      continue;
    }

    if (token === "--json") {
      reporter = "json";
      continue;
    }

    if (token === "--reporter" || token === "-r") {
      reporter = normalizeReporter(argv[i + 1]);
      i++;
      continue;
    }

    if (token.startsWith("--reporter=")) {
      reporter = normalizeReporter(token.slice("--reporter=".length));
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!moduleInput) {
      moduleInput = token.toLowerCase();
    }
  }

  return { moduleInput, reporter, help };
}

function printUsage() {
  console.log("用法:");
  console.log("  node test/integration/run-module.js <module> [--json]");
  console.log(
    "  node test/integration/run-module.js <module> --reporter <human|json>",
  );
  console.log("");

  console.log("可选模块:");
  for (const name of canonicalModuleNames) {
    console.log(`  - ${name}`);
  }

  console.log("");
  console.log("别名:");
  for (const [alias, target] of aliasHints) {
    console.log(`  ${alias} -> ${target}`);
  }

  console.log("");
  console.log("报告参数:");
  console.log("  --json                      等价于 --reporter json");
  console.log("  --reporter <human|json>");
  console.log("  -r <human|json>");
  console.log("");
  console.log("环境变量:");
  console.log("  ZNL_TEST_REPORTER=human|json");
}

async function runSingleModule({ moduleInput, reporter }) {
  const canonicalName = resolveCanonicalModuleName(moduleInput);
  const runModule = modules.get(moduleInput) || modules.get(canonicalName);

  if (!runModule) {
    console.error(`未知集成测试模块: ${moduleInput || "(empty)"}`);
    console.error("");
    printUsage();
    process.exitCode = 1;
    return;
  }

  const runner = new TestRunner({
    verbose: VERBOSE || TEST_CONFIG.verbose,
    reporter,
    exitOnComplete: false,
  });

  const displayName =
    canonicalName && canonicalName !== moduleInput
      ? `${moduleInput} -> ${canonicalName}`
      : moduleInput;

  runner.banner(`ZNL 集成测试（模块: ${displayName}）`);
  await runModule(runner);

  const report = runner.summary({ format: reporter, exitProcess: false });
  const hasFailure =
    report?.totals?.testsFailed > 0 || report?.totals?.assertionsFailed > 0;
  process.exitCode = hasFailure ? 1 : 0;
}

async function main() {
  installGlobalFatalHandlers({ source: "run-module" });

  const { moduleInput, reporter, help } = parseCli();

  if (help || !moduleInput) {
    printUsage();
    process.exitCode = help ? 0 : 1;
    return;
  }

  try {
    await runSingleModule({ moduleInput, reporter });
  } catch (error) {
    if (!handleFatalError(error, { source: "run-module" })) {
      process.exitCode = 0;
    }
  }
}

await main();
