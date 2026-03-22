# lmm-node

ZeroMQ 主从通信库（当前版本：`PUB/SUB + ROUTER/DEALER`）。

- `master`：`PUB + ROUTER`
- `slave`：`SUB + DEALER`
- 库文件：`master/lib/ZmqClusterNode.js`、`slave/lib/ZmqClusterNode.js`

## 安装

```bash
cd master && npm i
cd ../slave && npm i
```

## 运行

```bash
# 终端 1
cd master
npm start

# 终端 2
cd slave
npm start
# 或者自定义 id
node index.js slave-001
```

## 并发 100 条串包测试

```bash
# 终端 1：启动测试回显服务端
cd master
pnpm test:echo

# 终端 2：并发发送 100 条随机字符串并校验
cd slave
pnpm test:100
```

可选参数（客户端）：

```bash
# node test-100-concurrent.js <总条数> <超时ms> <客户端id>
node test-100-concurrent.js 100 10000 slave-001
```

## 构造参数

```js
new ZmqClusterNode({
  role: "master" | "slave",
  id: "节点唯一标识",
  endpoints: {
    pub: "tcp://127.0.0.1:6002",
    router: "tcp://127.0.0.1:6003",
  },
  subscribeTopics: ["hello"],
  maxPending: 0,
});
```

- `role`：节点角色，必填。
- `id`：节点唯一 id，必填（会作为 `DEALER` 的 routingId）。
- `endpoints`：地址配置，可覆盖默认值。
- `subscribeTopics`：`slave` 初始订阅主题列表。
- `maxPending`：最多允许多少个等待中的请求（`0` 表示不限，默认 `0`）。

## Payload 支持类型

所有发送函数都支持：

- `string`
- `Buffer`
- `Uint8Array`
- 上述类型组成的数组（多帧）

## 公开 API（精简版）

### 1) `start()`

启动节点并初始化 socket（master: `PUB+ROUTER`，slave: `SUB+DEALER`）。

### 2) `stop()`

停止节点，关闭 socket，并取消所有未完成请求。

### 3) `PUB(topic, payload)`

master 广播消息到某个 topic。

```js
await master.PUB("hello", "hello from master");
```

### 4) `SUB(topic)`

slave 运行时新增订阅 topic。

```js
slave.SUB("status");
```

### 5) `DEALER(payloadOrHandler, options)`

- 传 `payload`：slave 发起请求并等待 master 回包（自动 requestId，不串消息）
- 传 `handler`：注册 slave 自动回包处理器（处理 master -> slave 请求）

```js
// slave 主动请求 master
const res = await slave.DEALER("hello", { timeoutMs: 4000 });
console.log(res.toString());

// 处理 master 发给 slave 的请求
await slave.DEALER(async ({ payload }) => {
  return `slave reply: ${payload.toString()}`;
});
```

### 6) `ROUTER(identityOrHandler, payload, options)`

- 传 `handler`：注册 master 自动回包处理器（处理 slave -> master 请求）
- 传 `identity + payload`：master 定向请求指定 slave 并等待回包

```js
// 处理 slave 发给 master 的请求
master.ROUTER(async ({ identityText, payload }) => {
  return `master reply to ${identityText}: ${payload.toString()}`;
});

// master 主动请求指定 slave
const res = await master.ROUTER("slave-001", "ping", { timeoutMs: 4000 });
console.log(res.toString());
```

> 自动 `requestId` 匹配、回包和超时处理依然在库内完成，业务层不需要关心消息格式。

## 事件（on）

可通过 `node.on(eventName, handler)` 监听。

- `sub`：slave 收到订阅消息。
- `router`：master 收到 ROUTER 消息。
- `dealer`：slave 收到 DEALER 消息。
- `request`：收到请求帧（自动识别）。
- `response`：收到响应帧（自动识别）。
- `message`：所有消息的统一事件。
- `error`：内部异常。

## 用法示例

### master 示例

```js
import { ZmqClusterNode } from "./lib/ZmqClusterNode.js";

const master = new ZmqClusterNode({
  role: "master",
  id: "master-demo",
  endpoints: {
    pub: "tcp://127.0.0.1:6002",
    router: "tcp://127.0.0.1:6003",
  },
  maxPending: 5000,
});

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

// ROUTER(handler)：处理 slave -> master 请求
master.ROUTER(async ({ identityText, payload }) => {
  const text = toText(payload);
  console.log(`[MASTER][ROUTER<-DEALER] from=${identityText} payload=${text}`);
  return `master reply: ${text}`;
});

master.on("error", (err) => {
  console.error("[MASTER ERROR]", err.message);
});

await master.start();
console.log("[MASTER] started");

// PUB(topic, payload)
await master.PUB("hello", "hello from master");

// ROUTER(identity, payload, options)
const res = await master.ROUTER("slave-001", "ping from master", {
  timeoutMs: 4000,
});
console.log("[MASTER][ROUTER RESULT]", toText(res));

process.on("SIGINT", async () => {
  await master.stop(); // stop()
  process.exit(0);
});
```

### slave 示例

```js
import { ZmqClusterNode } from "./lib/ZmqClusterNode.js";

const id = "slave-001";
const slave = new ZmqClusterNode({
  role: "slave",
  id,
  endpoints: {
    pub: "tcp://127.0.0.1:6002",
    router: "tcp://127.0.0.1:6003",
  },
  subscribeTopics: ["hello"],
  maxPending: 2000,
});

const toText = (payload) =>
  Buffer.isBuffer(payload) ? payload.toString() : String(payload);

// DEALER(handler)：处理 master -> slave 请求
await slave.DEALER(async ({ payload }) => {
  return `reply from ${id}: ${toText(payload)}`;
});

slave.on("sub", ({ topic, payload }) => {
  console.log(`[SUB:${topic}]`, toText(payload));
});

await slave.start();
console.log(`${id} started`);

slave.SUB("system"); // SUB(topic)

// DEALER(payload, options)
const res = await slave.DEALER(`hello from ${id}`, { timeoutMs: 4000 });
console.log("[SLAVE DEALER RESULT]", toText(res));

process.on("SIGINT", async () => {
  await slave.stop(); // stop()
  process.exit(0);
});
```
