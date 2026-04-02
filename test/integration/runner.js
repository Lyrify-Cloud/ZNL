export class TestRunner {
  constructor({
    verbose = false,
    reporter = process.env.ZNL_TEST_REPORTER || "human",
    exitOnComplete = true,
    testTimeoutMs = Number(process.env.ZNL_TEST_CASE_TIMEOUT_MS ?? 20000),
  } = {}) {
    this.verbose = Boolean(verbose);
    this.reporter = reporter === "json" ? "json" : "human";
    this.exitOnComplete = Boolean(exitOnComplete);

    const parsedTimeoutMs = Number(testTimeoutMs);
    this.testTimeoutMs =
      Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
        ? Math.trunc(parsedTimeoutMs)
        : 0;

    this.passed = 0; // assertion-level
    this.failed = 0; // assertion-level
    this.index = 0; // test index

    this.startAt = Date.now();
    this.endAt = null;
    this.completed = false;

    this.currentModule = null;
    this.currentTest = null;

    this.modules = [];
    this.moduleByName = new Map();
    this.cases = [];
    this.failures = [];
  }

  banner(title) {
    if (this.reporter === "json") return;

    console.log("=".repeat(64));
    console.log(`  ${title}`);
    console.log("=".repeat(64));
    console.log(`  verbose=${this.verbose ? "on" : "off"}`);
    console.log(`  reporter=${this.reporter}`);
    console.log(
      `  caseTimeoutMs=${this.testTimeoutMs > 0 ? this.testTimeoutMs : "off"}`,
    );
  }

  beginModule(name) {
    if (!name) return null;
    this.endModule();

    const moduleName = String(name);
    let mod = this.moduleByName.get(moduleName);

    if (!mod) {
      mod = {
        name: moduleName,
        startedAt: Date.now(),
        endedAt: null,
        durationMs: 0,
        testsTotal: 0,
        testsPassed: 0,
        testsFailed: 0,
        assertionsPassed: 0,
        assertionsFailed: 0,
      };
      this.modules.push(mod);
      this.moduleByName.set(moduleName, mod);
    } else {
      mod.startedAt = Date.now();
      mod.endedAt = null;
      mod.durationMs = 0;
    }

    this.currentModule = mod;
    return mod;
  }

  endModule() {
    if (!this.currentModule) return;
    if (!this.currentModule.endedAt) {
      this.currentModule.endedAt = Date.now();
      this.currentModule.durationMs =
        this.currentModule.endedAt - this.currentModule.startedAt;
    }
    this.currentModule = null;
  }

  section(title) {
    this.beginModule(title);
    if (this.reporter === "json") return;
    console.log(`\n【${title}】`);
  }

  log(...args) {
    if (this.verbose && this.reporter === "human") {
      console.log(...args);
    }
  }

  pass(label) {
    if (this.reporter === "human") {
      console.log(`    ✓ ${label}`);
    }

    this.passed++;

    if (this.currentModule) {
      this.currentModule.assertionsPassed++;
    }
  }

  fail(label, error = null) {
    if (this.reporter === "human") {
      console.error(`    ✗ ${label}`);
    }

    this.failed++;

    if (this.currentModule) {
      this.currentModule.assertionsFailed++;
    }

    const failure = {
      testIndex: this.currentTest?.index ?? null,
      testLabel: this.currentTest?.label ?? null,
      module: this.currentTest?.module ?? this.currentModule?.name ?? null,
      assertionLabel: String(label ?? ""),
      message: error?.message ? String(error.message) : String(label ?? ""),
      stack: error?.stack ? String(error.stack) : null,
      timestamp: new Date().toISOString(),
    };

    this.failures.push(failure);

    if (this.currentTest) {
      this.currentTest.failedAssertions += 1;
      this.currentTest.failures.push(failure);
    }
  }

  assert(condition, label) {
    if (condition) {
      this.pass(label);
      return true;
    }

    this.fail(label);
    return false;
  }

  async test(label, fn) {
    this.index++;
    const idx = String(this.index).padStart(2, "0");
    const startedAt = Date.now();
    const moduleName = this.currentModule?.name ?? null;

    if (this.reporter === "human") {
      console.log(`\n  ▶ [${idx}] ${label}`);
    }

    const testCtx = {
      index: this.index,
      label: String(label),
      module: moduleName,
      startedAt,
      endedAt: null,
      durationMs: 0,
      failedAssertions: 0,
      failures: [],
      status: "passed",
      timedOut: false,
    };

    this.currentTest = testCtx;

    let timeoutId = null;

    try {
      if (this.testTimeoutMs > 0) {
        const timeoutMs = this.testTimeoutMs;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`测试用例超时（>${timeoutMs}ms）`));
          }, timeoutMs);
        });

        await Promise.race([
          Promise.resolve().then(() => fn()),
          timeoutPromise,
        ]);
      } else {
        await fn();
      }
    } catch (error) {
      const message = String(error?.message ?? error ?? "");
      const isTimeout = message.includes("测试用例超时");
      testCtx.timedOut = isTimeout;
      this.fail(`${isTimeout ? "用例超时" : "未预期异常"}：${message}`, error);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      testCtx.endedAt = Date.now();
      testCtx.durationMs = testCtx.endedAt - testCtx.startedAt;
      testCtx.status = testCtx.failedAssertions > 0 ? "failed" : "passed";

      this.cases.push({
        index: testCtx.index,
        label: testCtx.label,
        module: testCtx.module,
        status: testCtx.status,
        timedOut: testCtx.timedOut,
        durationMs: testCtx.durationMs,
        startedAt: new Date(testCtx.startedAt).toISOString(),
        endedAt: new Date(testCtx.endedAt).toISOString(),
      });

      if (this.currentModule) {
        this.currentModule.testsTotal++;
        if (testCtx.status === "passed") {
          this.currentModule.testsPassed++;
        } else {
          this.currentModule.testsFailed++;
        }
      }

      if (this.reporter === "human") {
        console.log(`    ⏱ ${testCtx.durationMs}ms`);
      }

      this.currentTest = null;
    }
  }

  buildReport() {
    const now = this.endAt ?? Date.now();
    const durationMs = now - this.startAt;

    const testsTotal = this.cases.length;
    const testsPassed = this.cases.filter((c) => c.status === "passed").length;
    const testsFailed = testsTotal - testsPassed;

    const modules = this.modules.map((m) => ({
      name: m.name,
      durationMs: m.durationMs,
      testsTotal: m.testsTotal,
      testsPassed: m.testsPassed,
      testsFailed: m.testsFailed,
      assertionsPassed: m.assertionsPassed,
      assertionsFailed: m.assertionsFailed,
    }));

    return {
      reporter: this.reporter,
      verbose: this.verbose,
      startedAt: new Date(this.startAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationMs,
      totals: {
        testsTotal,
        testsPassed,
        testsFailed,
        assertionsPassed: this.passed,
        assertionsFailed: this.failed,
      },
      modules,
      cases: this.cases,
      failures: this.failures,
    };
  }

  printHumanSummary(report) {
    console.log(`\n${"=".repeat(64)}`);
    console.log(
      `  断言通过: ${report.totals.assertionsPassed}   断言失败: ${report.totals.assertionsFailed}`,
    );
    console.log(
      `  用例通过: ${report.totals.testsPassed}   用例失败: ${report.totals.testsFailed}`,
    );
    console.log(`  总耗时: ${report.durationMs}ms`);
    console.log("=".repeat(64));

    if (report.modules.length > 0) {
      console.log("\n  模块统计:");
      for (const mod of report.modules) {
        console.log(
          `  - ${mod.name}: tests ${mod.testsPassed}/${mod.testsTotal}, assertions ${mod.assertionsPassed}/${mod.assertionsPassed + mod.assertionsFailed}, ${mod.durationMs}ms`,
        );
      }
    }

    if (report.failures.length > 0) {
      console.log("\n  失败详情:");
      report.failures.forEach((f, i) => {
        console.log(
          `\n  [${i + 1}] module=${f.module ?? "-"} test=#${String(
            f.testIndex ?? "-",
          )} ${f.testLabel ?? "-"}`,
        );
        console.log(`      assertion: ${f.assertionLabel}`);
        if (f.message) console.log(`      message: ${f.message}`);
        if (f.stack) {
          const stack = f.stack.split("\n").slice(0, 8).join("\n");
          console.log(`      stack:\n${stack}`);
        }
      });
    }

    if (report.totals.testsFailed > 0 || report.totals.assertionsFailed > 0) {
      console.log("\n  ✗ 测试存在失败\n");
    } else {
      console.log("\n  ✓ 全部测试通过\n");
    }
  }

  summary({ format, exitProcess } = {}) {
    if (this.completed) {
      return this.buildReport();
    }

    this.endModule();
    this.endAt = Date.now();
    this.completed = true;

    const selectedFormat = format
      ? format === "json"
        ? "json"
        : "human"
      : this.reporter;

    const shouldExit =
      typeof exitProcess === "boolean" ? exitProcess : this.exitOnComplete;

    const report = this.buildReport();

    if (selectedFormat === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      this.printHumanSummary(report);
    }

    if (shouldExit) {
      const code =
        report.totals.testsFailed > 0 || report.totals.assertionsFailed > 0
          ? 1
          : 0;
      process.exit(code);
    }

    return report;
  }
}

export function createRunner(options) {
  return new TestRunner(options);
}
