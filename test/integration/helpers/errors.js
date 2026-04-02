const STOP_CANCEL_PATTERNS = [
  "节点已停止，所有待处理请求已取消",
  "已停止，所有待处理请求已取消",
  "all pending requests have been cancelled",
  "all pending requests canceled",
  "node has stopped",
];

export function isIgnorableStopCancelError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return STOP_CANCEL_PATTERNS.some((pattern) =>
    message.includes(String(pattern).toLowerCase()),
  );
}

export function formatErrorDetail(error) {
  return String(error?.stack ?? error?.message ?? error ?? "Unknown error");
}

let installed = false;

export function installGlobalFatalHandlers({
  source = "integration",
  onFatal = null,
  setExitCode = true,
} = {}) {
  if (installed) return;
  installed = true;

  const handleFatal = (kind, error) => {
    if (isIgnorableStopCancelError(error)) return;

    const detail = formatErrorDetail(error);
    console.error(`\n[${source}] ${kind}:\n${detail}`);

    if (typeof onFatal === "function") {
      onFatal({ kind, error, detail, source });
    }

    if (setExitCode) {
      process.exitCode = 1;
    }
  };

  process.on("unhandledRejection", (reason) => {
    handleFatal("unhandledRejection", reason);
  });

  process.on("uncaughtException", (error) => {
    handleFatal("uncaughtException", error);
  });
}

export function handleFatalError(error, { source = "integration" } = {}) {
  if (isIgnorableStopCancelError(error)) return false;
  console.error(`\n[${source}] fatal:\n${formatErrorDetail(error)}`);
  process.exitCode = 1;
  return true;
}
