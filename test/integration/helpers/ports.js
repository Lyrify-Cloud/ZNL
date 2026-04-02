const DEFAULT_PROTOCOL = String(process.env.ZNL_TEST_PROTOCOL ?? "tcp").trim() || "tcp";
const DEFAULT_HOST = String(process.env.ZNL_TEST_HOST ?? "127.0.0.1").trim() || "127.0.0.1";

function toInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function normalizePositiveInt(value, fallback, { min = 1 } = {}) {
  const parsed = toInt(value, fallback);
  return parsed >= min ? parsed : fallback;
}

const DEFAULT_BASE_PORT = normalizePositiveInt(
  process.env.ZNL_TEST_PORT_BASE,
  16000,
  { min: 1 },
);

const DEFAULT_STEP = normalizePositiveInt(process.env.ZNL_TEST_PORT_STEP, 1, {
  min: 1,
});

const DEFAULT_OFFSET = normalizePositiveInt(
  process.env.ZNL_TEST_PORT_OFFSET,
  0,
  { min: 0 },
);

/**
 * Build a ZeroMQ endpoint from protocol/host/port.
 */
export function endpointFromPort(port, { protocol = DEFAULT_PROTOCOL, host = DEFAULT_HOST } = {}) {
  const safePort = normalizePositiveInt(port, DEFAULT_BASE_PORT, { min: 1 });
  const safeProtocol = String(protocol || DEFAULT_PROTOCOL).trim() || DEFAULT_PROTOCOL;
  const safeHost = String(host || DEFAULT_HOST).trim() || DEFAULT_HOST;
  return `${safeProtocol}://${safeHost}:${safePort}`;
}

/**
 * Create a monotonic endpoint allocator to reduce hardcoded port coupling.
 *
 * Example:
 * const ports = createPortAllocator({ basePort: 17000 });
 * const ep1 = ports.nextEndpoint(); // tcp://127.0.0.1:17000
 * const ep2 = ports.nextEndpoint(); // tcp://127.0.0.1:17001
 */
export function createPortAllocator({
  basePort = DEFAULT_BASE_PORT,
  step = DEFAULT_STEP,
  offset = DEFAULT_OFFSET,
  protocol = DEFAULT_PROTOCOL,
  host = DEFAULT_HOST,
} = {}) {
  const safeBasePort = normalizePositiveInt(basePort, DEFAULT_BASE_PORT, { min: 1 });
  const safeStep = normalizePositiveInt(step, DEFAULT_STEP, { min: 1 });
  const safeOffset = normalizePositiveInt(offset, DEFAULT_OFFSET, { min: 0 });

  let cursor = safeBasePort + safeOffset;

  function nextPort() {
    const port = cursor;
    cursor += safeStep;
    return port;
  }

  function nextEndpoint() {
    return endpointFromPort(nextPort(), { protocol, host });
  }

  function allocate(count = 1) {
    const size = normalizePositiveInt(count, 1, { min: 1 });
    const ports = [];
    for (let i = 0; i < size; i += 1) {
      ports.push(nextPort());
    }
    return ports;
  }

  function allocateEndpoints(count = 1) {
    return allocate(count).map((port) => endpointFromPort(port, { protocol, host }));
  }

  function peekPort() {
    return cursor;
  }

  function peekEndpoint() {
    return endpointFromPort(peekPort(), { protocol, host });
  }

  function reset(nextBasePort = safeBasePort, nextOffset = safeOffset) {
    const resetBase = normalizePositiveInt(nextBasePort, safeBasePort, { min: 1 });
    const resetOffset = normalizePositiveInt(nextOffset, safeOffset, { min: 0 });
    cursor = resetBase + resetOffset;
    return cursor;
  }

  return {
    protocol,
    host,
    basePort: safeBasePort,
    step: safeStep,
    offset: safeOffset,
    nextPort,
    nextEndpoint,
    allocate,
    allocateEndpoints,
    peekPort,
    peekEndpoint,
    reset,
  };
}

/**
 * Shared allocator for integration tests.
 * You can override behavior via env:
 * - ZNL_TEST_PORT_BASE
 * - ZNL_TEST_PORT_STEP
 * - ZNL_TEST_PORT_OFFSET
 * - ZNL_TEST_PROTOCOL
 * - ZNL_TEST_HOST
 */
export const integrationPorts = createPortAllocator();

export default integrationPorts;
