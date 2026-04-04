import { TestRunner } from "../runner.js";

function captureConsole() {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];

  const push = (args) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };

  console.log = (...args) => push(args);
  console.error = (...args) => push(args);

  return {
    logs,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function includesAny(text, parts) {
  return parts.some((part) => text.includes(part));
}

export async function runRunnerOutputTests(runner) {
  runner.section("runner 输出");

  await runner.test("compact 输出仅模块级成功", async () => {
    const { logs, restore } = captureConsole();
    try {
      const inner = new TestRunner({
        verbose: false,
        reporter: "human",
        exitOnComplete: false,
        testTimeoutMs: 2000,
      });

      inner.section("runner output compact");
      await inner.test("case ok", async () => {
        inner.assert(true, "assert ok");
      });

      inner.summary({ format: "human", exitProcess: false });
    } finally {
      restore();
    }

    const text = logs.join("\n");

    runner.assert(
      text.includes("✓ runner output compact"),
      `compact 模式应输出模块成功行 → "${text}"`,
    );

    runner.assert(
      !includesAny(text, ["▶ [01] case ok", "✓ assert ok", "⏱", "【runner output compact】"]),
      `compact 模式不应输出细分项 → "${text}"`,
    );
  });

  await runner.test("verbose 输出包含细分项", async () => {
    const { logs, restore } = captureConsole();
    try {
      const inner = new TestRunner({
        verbose: true,
        reporter: "human",
        exitOnComplete: false,
        testTimeoutMs: 2000,
      });

      inner.section("runner output verbose");
      await inner.test("case ok", async () => {
        inner.assert(true, "assert ok");
      });

      inner.summary({ format: "human", exitProcess: false });
    } finally {
      restore();
    }

    const text = logs.join("\n");

    runner.assert(
      includesAny(text, ["【runner output verbose】", "▶ [01] case ok", "✓ assert ok"]),
      `verbose 模式应输出细分项 → "${text}"`,
    );
  });
}
