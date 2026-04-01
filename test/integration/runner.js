export class TestRunner {
  constructor({ verbose = false } = {}) {
    this.verbose = Boolean(verbose);
    this.passed = 0;
    this.failed = 0;
    this.index = 0;
  }

  banner(title) {
    console.log("=".repeat(64));
    console.log(`  ${title}`);
    console.log("=".repeat(64));
    console.log(`  verbose=${this.verbose ? "on" : "off"}`);
  }

  section(title) {
    console.log(`\n【${title}】`);
  }

  log(...args) {
    if (this.verbose) {
      console.log(...args);
    }
  }

  pass(label) {
    console.log(`    ✓ ${label}`);
    this.passed++;
  }

  fail(label) {
    console.error(`    ✗ ${label}`);
    this.failed++;
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
    console.log(`\n  ▶ [${idx}] ${label}`);

    try {
      await fn();
    } catch (error) {
      this.fail(`未预期异常：${error?.message ?? error}`);
    }
  }

  summary() {
    console.log(`\n${"=".repeat(64)}`);
    console.log(`  通过: ${this.passed}   失败: ${this.failed}`);
    console.log("=".repeat(64));

    if (this.failed > 0) {
      process.exit(1);
    }

    console.log("\n  ✓ 全部测试通过\n");
    process.exit(0);
  }
}

export function createRunner(options) {
  return new TestRunner(options);
}
