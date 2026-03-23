# ZNL

基于 ZeroMQ `ROUTER/DEALER` 模式的 Node.js 通信库，提供开箱即用的双向 RPC 与 PUB/SUB 广播能力。

## 特性

- 基于 `ROUTER/DEALER` 同时实现 RPC 请求-响应与 PUB/SUB 广播，一套连接两种模式
- 内置请求 ID 匹配、超时控制、最大并发限制
- 支持 Master → Slave 主动发起请求（双向 RPC）
- 基于 ROUTER 实现 PUB/SUB 广播，无需额外 socket 或端口
- Slave 自动注册/注销，Master 实时感知在线节点
- 可选的认证 Key 校验（注册与 RPC 请求均校验）
- Payload 支持 `string`、`Buffer`、`Uint8Array` 及其数组（多帧）

## 安装

```bash
pnpm add znl
```

本地开发克隆仓库后：

```bash
pnpm install
```

## 快速开始

### Master 节点

```js
import { ZNL } from "znl";

const master = new ZNL({
  role: "master",
  id: "master-1",
  endpoints: { router: "tcp://127.0.0.1:6003" },
  authKey: "your-shared-key",
});

// RPC：自动回复 slave 的请求
master.ROUTER(async ({ identityText, payload }) => {
  const text = Buffer.isBuffer(payload) ? payload.toString() : String(payload);
  return `已收到来自 ${identityText} 的消息：${text}`;
});

// PUB/SUB：感知节点上下线
master.on("slave_connected",    (id) => console.log(`${id} 上线，在线：${master.slaves}`));
master.on("slave_disconnected", (id) => console.log(`${id} 下线，在线：${master.slaves}`));

await master.start();

// PUB/SUB：广播消息（fire-and-forget）
master.publish("news", "今日头条：ZNL 正式发布");
master.publish("system", JSON.stringify({ status: "ok", time: Date.now() }));
```

### Slave 节点

```js
import { ZNL } from "znl";

const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  endpoints: { router: "tcp://127.0.0.1:6003" },
  authKey: "your-shared-key",
});

// PUB/SUB：精确订阅（可在 start 前调用）
slave.subscribe("news", ({ payload }) => {
  console.log("收到新闻：", payload.toString());
});

// PUB/SUB：兜底监听所有 topic
slave.on("publish", ({ topic, payload }) => {
  console.log(`[${topic}]`, payload.toString());
});

await slave.start();

// RPC：向 master 发请求并等待响应
const reply = await slave.DEALER("hello master", { timeoutMs: 4000 });
console.log(reply.toString());
```

## 构造函数

```js
new ZNL({
  role: "master" | "slave",
  id: "node-id",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  maxPending: 0,
  authKey: "",
});
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `role` | ✓ | 节点角色，`"master"` 或 `"slave"` |
| `id` | ✓ | 节点唯一标识；slave 端同时作为 ZMQ `routingId` |
| `endpoints.router` | | ROUTER 端点，默认 `tcp://127.0.0.1:6003` |
| `maxPending` | | 最大并发 RPC 请求数，`0` 表示不限制 |
| `authKey` | | 可选共享认证 Key；master 开启后校验注册帧与 RPC 请求 |

## API

### `start()`

启动节点：

- `master`：绑定（bind）ROUTER socket
- `slave`：连接（connect）DEALER socket，并自动向 master 发送注册帧

重复调用安全，若正在启动中则等待同一个 Promise。

### `stop()`

停止节点：

- `slave`：先向 master 发送注销帧，再关闭 socket
- `master`：清空在线节点表，关闭 socket，立即 reject 所有 pending RPC 请求

### `DEALER(payloadOrHandler, options?)`

**Slave 侧调用：**

- `payloadOrHandler` 为 payload 时：向 Master 发送 RPC 请求并等待响应，返回 `Promise<Buffer | Array>`
- `payloadOrHandler` 为函数时：注册 slave 侧自动回复处理器（Master 主动发来 RPC 请求时触发）

### `ROUTER(identityOrHandler, payload?, options?)`

**Master 侧调用：**

- `identityOrHandler` 为函数时：注册 master 侧自动回复处理器（Slave 发来 RPC 请求时触发）
- `identityOrHandler` 为 identity（slave ID）时：Master 主动向指定 Slave 发送 RPC 请求并等待响应，返回 `Promise<Buffer | Array>`

### `options.timeoutMs`

单次 RPC 请求超时时间，默认 `5000` ms。

### `publish(topic, payload)`

**Master 侧调用**，向所有当前在线的 slave 广播消息（fire-and-forget，无需 await）。

- `topic`：消息主题字符串，slave 侧可按 topic 精确过滤
- `payload`：同 RPC，支持 `string`、`Buffer`、`Uint8Array` 或其数组
- 若某个 slave 发送失败，自动将其从在线列表移除并触发 `slave_disconnected`

```js
master.publish("news", "breaking news!");
master.publish("metrics", JSON.stringify({ cpu: 0.42 }));
```

### `subscribe(topic, handler)`

**Slave 侧调用**，订阅指定 topic，master 广播时触发 handler。

- 可在 `start()` 前后任意时刻调用，订阅信息跨 stop/start 周期保留
- 同一 topic 重复订阅会覆盖旧 handler
- 支持链式调用（返回 `this`）

```js
slave
  .subscribe("news",    ({ topic, payload }) => { /* ... */ })
  .subscribe("metrics", ({ topic, payload }) => { /* ... */ });
```

### `unsubscribe(topic)`

**Slave 侧调用**，取消订阅指定 topic，支持链式调用。

```js
slave.unsubscribe("news");
```

### `slaves`

**Master 侧只读属性**，返回当前所有在线 slave ID 的快照数组。

```js
console.log(master.slaves); // ["slave-001", "slave-002"]
```

## 事件

通过 `node.on(eventName, handler)` 监听：

| 事件 | 触发方 | 说明 |
|------|--------|------|
| `router` | Master | Router socket 收到原始帧（所有类型） |
| `dealer` | Slave | Dealer socket 收到原始帧（所有类型） |
| `request` | 两者 | 解析出 RPC 请求帧（认证通过后） |
| `response` | 两者 | 解析出 RPC 响应帧 |
| `message` | 两者 | 所有解析消息的统一事件 |
| `publish` | Slave | 收到 master 广播，携带 `{ topic, payload }` |
| `slave_connected` | Master | slave 注册成功上线，携带 `slaveId` |
| `slave_disconnected` | Master | slave 注销或发送失败下线，携带 `slaveId` |
| `auth_failed` | Master | 认证失败（注册或 RPC），请求已被丢弃 |
| `error` | 两者 | 内部错误 |

## 本地示例

```bash
# 终端 1：启动 Master
pnpm example:master

# 终端 2：启动 Slave（可指定 ID）
pnpm example:slave
node test/slave/index.js slave-001
```

## 集成测试

在同一进程内启动 Master / Slave，自动验证 RPC、并发、认证、超时、PUB/SUB 等全部功能：

```bash
pnpm test
```

## 并发压测

```bash
# 终端 1：启动 Echo 服务端
pnpm test:echo

# 终端 2：发起并发压测
pnpm test:100 -- 100 10000 slave-001
```

参数说明：

- 总请求数
- 超时时间（毫秒）
- Slave 节点 ID

## 发布前检查

1. 更新 `package.json` 中的 `name`、`version`、`author`、`repository`
2. 确认 README 中的包名与 import 路径
3. 按需更新 `LICENSE` 中的版权信息