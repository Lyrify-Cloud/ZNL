const toText = (value) =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : value?.message
        ? String(value.message)
        : String(value);

const includesAny = (text, patterns = []) => {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  return patterns.some((part) => text.includes(String(part)));
};

export async function captureRejection(action) {
  if (typeof action !== "function") {
    throw new TypeError("captureRejection(action) 要求 action 为函数");
  }

  try {
    const value = await action();
    return {
      rejected: false,
      resolved: true,
      value,
      error: null,
      message: "",
    };
  } catch (error) {
    return {
      rejected: true,
      resolved: false,
      value: undefined,
      error,
      message: toText(error),
    };
  }
}

/**
 * 断言一个异步动作会被 reject，并且错误消息可选地包含指定片段。
 * 返回统一结构，便于在 runner.assert(...) 中复用。
 */
export async function expectRejected(action, messageIncludes = []) {
  const result = await captureRejection(action);
  const message = result.message;

  return {
    ...result,
    matched: result.rejected && includesAny(message, messageIncludes),
    expected: {
      rejected: true,
      messageIncludes: Array.isArray(messageIncludes) ? messageIncludes : [],
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询等待条件成立。
 * - predicate 可以是同步或异步函数
 * - resolveOnThrow=false 时，predicate 抛错会被吞掉并继续重试
 */
export async function expectEventually(predicate, options = {}) {
  if (typeof predicate !== "function") {
    throw new TypeError("expectEventually(predicate) 要求 predicate 为函数");
  }

  const {
    timeoutMs = 2000,
    intervalMs = 50,
    resolveOnThrow = false,
  } = options;

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);

  let attempts = 0;
  let lastError = null;
  let lastValue = false;

  while (Date.now() <= deadline) {
    attempts += 1;

    try {
      lastValue = await predicate();
      if (lastValue) {
        const endedAt = Date.now();
        return {
          ok: true,
          timedOut: false,
          attempts,
          elapsedMs: endedAt - startedAt,
          lastValue,
          lastError: null,
          message: "",
        };
      }
    } catch (error) {
      lastError = error;

      if (resolveOnThrow) {
        const endedAt = Date.now();
        return {
          ok: true,
          timedOut: false,
          attempts,
          elapsedMs: endedAt - startedAt,
          lastValue: undefined,
          lastError: error,
          message: toText(error),
        };
      }
    }

    await sleep(Math.max(0, Number(intervalMs) || 0));
  }

  const endedAt = Date.now();
  return {
    ok: false,
    timedOut: true,
    attempts,
    elapsedMs: endedAt - startedAt,
    lastValue,
    lastError,
    message: lastError ? toText(lastError) : "条件在超时时间内未满足",
  };
}
