# ZNL

基于 ZeroMQ `ROUTER / DEALER` 模式的 Node.js 通信库，提供双向 RPC、广播、在线状态感知，以及可选的签名认证与透明加密能力。

## 特性

- 基于单连接实现双向 RPC 与广播
- 支持 `Master -> Slave` 与 `Slave -> Master` 双向主动请求
- `Slave` 自动注册 / 注销，`Master` 实时维护在线节点列表
- 支持请求超时控制与最大并发限制
- 心跳采用 `heartbeat -> heartbeat_ack` 应答机制
- `Slave` 提供主节点在线状态查询 API：`masterOnline` / `isMasterOnline()`
- 支持安全模式：
  - HMAC 签名
  - 时间戳校验
  - nonce 防重放
  - AES-256-GCM 透明加密
  - 可选 payload 摘要校验
- 支持 `authKeyMap`，允许 `Master` 按 `slaveId` 使用不同密钥
- Payload 支持 `string`、`Buffer`、`Uint8Array` 及其数组（多帧）

## 安装

```bash
pnpm add @lyrify/znl
```

本地开发：

```bash
pnpm install
```

## 快速开始

### Master

```js
import { ZNL } from "@lyrify/znl";

const master = new ZNL({
  role: "master",
  id: "master-1",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: true,
});

// 注册自动回复处理器
master.ROUTER(async ({ identityText, payload }) => {
  const text = Buffer.isBuffer(payload) ? payload.toString() : String(payload);
  return `已收到来自 ${identityText} 的消息：${text}`;
});

// 监听节点上下线
master.on("slave_connected", (id) => {
  console.log(`${id} 上线，当前在线：${master.slaves.join(", ")}`);
});

master.on("slave_disconnected", (id) => {
  console.log(`${id} 下线，当前在线：${master.slaves.join(", ")}`);
});

await master.start();

// 广播消息
master.publish("news", "今日头条：ZNL 正式发布");
master.publish("system", JSON.stringify({ status: "ok", time: Date.now() }));
```

### Slave

```js
import { ZNL } from "@lyrify/znl";

const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: true,
});

// 订阅指定 topic
slave.subscribe("news", ({ payload }) => {
  console.log("收到新闻：", payload.toString());
});

// 兜底监听所有广播
slave.on("publish", ({ topic, payload }) => {
  console.log(`[${topic}]`, payload.toString());
});

await slave.start();

if (slave.isMasterOnline()) {
  const reply = await slave.DEALER("hello master", { timeoutMs: 4000 });
  console.log(reply.toString());
}
```

## 构造函数

```js
new ZNL({
  role: "master" | "slave",
  id: "node-id",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  maxPending: 1000,
  authKey: "",
  authKeyMap: { "slave-001": "k1", "slave-002": "k2" },
  heartbeatInterval: 3000,
  heartbeatTimeoutMs: 0,
  encrypted: false,
  enablePayloadDigest: true,
  maxTimeSkewMs: 30000,
  replayWindowMs: 120000,
});
```

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `role` | ✓ | 节点角色，`"master"` 或 `"slave"` |
| `id` | ✓ | 节点唯一标识；`slave` 侧同时作为 ZMQ `routingId` |
| `endpoints.router` |  | ROUTER 端点，默认 `tcp://127.0.0.1:6003` |
| `maxPending` |  | 最大并发 RPC 请求数，默认 `1000`；`0` 表示不限制 |
| `authKey` |  | 共享认证 Key；与 `authKeyMap` 二选一（`encrypted=true` 时至少提供一个） |
| `authKeyMap` |  | `master` 侧 `slaveId -> authKey` 映射；未命中时回退到 `authKey` |
| `heartbeatInterval` |  | 心跳间隔（毫秒），默认 `3000`；`0` 表示禁用心跳 |
| `heartbeatTimeoutMs` |  | 心跳超时时间（毫秒），默认 `0` 表示使用 `heartbeatInterval × 3` |
| `encrypted` |  | 是否启用安全模式：`false`（默认，明文） / `true`（签名、防重放、透明加密） |
| `enablePayloadDigest` |  | 是否启用 payload 摘要校验，默认 `true`；关闭可提升性能 |
| `maxTimeSkewMs` |  | 时间戳最大允许偏移（毫秒），默认 `30000` |
| `replayWindowMs` |  | nonce 重放缓存窗口（毫秒），默认 `120000` |

## 使用建议

- `master` 与 `slave` 两端应保持一致的 `encrypted` 配置
- 若使用 `enablePayloadDigest=false`，两端也应保持一致
- `encrypted=true` 时必须提供非空 `authKey`，或在 `master` 侧提供 `authKeyMap`

## API

### 生命周期

#### `start()`

启动节点。

`master` 侧：

- 绑定 ROUTER socket
- 启动在线节点心跳检测

`slave` 侧：

- 连接 DEALER socket
- 自动尝试发送注册帧
- 启动心跳流程
- 发送 `heartbeat` 后等待 `heartbeat_ack`
- 收到 `heartbeat_ack` 后调度下一次心跳

#### `stop()`

停止节点。

`slave` 侧：

- 停止心跳
- 发送注销帧
- 关闭 socket

`master` 侧：

- 清空在线节点表
- 关闭 socket
- reject 所有 pending RPC 请求

### 双向 RPC

#### `DEALER(payloadOrHandler, options?)`

仅 `slave` 侧使用。

- 当 `payloadOrHandler` 为 payload 时，向 `Master` 发起 RPC 请求，返回 `Promise<Buffer | Array>`
- 当 `payloadOrHandler` 为函数时，注册 `slave` 侧自动回复处理器，用于处理 `Master` 主动发来的请求

#### `ROUTER(identityOrHandler, payload?, options?)`

仅 `master` 侧使用。

- 当 `identityOrHandler` 为函数时，注册 `master` 侧自动回复处理器，用于处理 `Slave` 发来的请求
- 当 `identityOrHandler` 为某个 `slaveId` 时，`Master` 主动向指定 `Slave` 发起 RPC 请求，返回 `Promise<Buffer | Array>`

#### `options.timeoutMs`

单次 RPC 请求超时时间，默认 `5000` 毫秒。

### 广播与订阅

#### `publish(topic, payload)`

仅 `master` 侧使用。

向所有当前在线的 `slave` 广播消息（fire-and-forget，无需 `await`）。

- `topic`：消息主题
- `payload`：支持 `string`、`Buffer`、`Uint8Array` 或其数组
- 若某个 `slave` 发送失败，会自动将其移出在线列表并触发 `slave_disconnected`

```js
master.publish("news", "breaking news!");
master.publish("metrics", JSON.stringify({ cpu: 0.42 }));
```

#### `subscribe(topic, handler)`

仅 `slave` 侧使用。

订阅指定 topic。

- 可在 `start()` 前后调用
- 订阅关系跨 `stop()/start()` 周期保留
- 同一 topic 重复订阅会覆盖旧 handler
- 返回 `this`，支持链式调用

```js
slave
  .subscribe("news", ({ topic, payload }) => {
    // ...
  })
  .subscribe("metrics", ({ topic, payload }) => {
    // ...
  });
```

#### `unsubscribe(topic)`

仅 `slave` 侧使用。

取消订阅指定 topic。

```js
slave.unsubscribe("news");
```

### 在线状态与节点管理

#### `slaves`

仅 `master` 侧只读属性。

返回当前所有在线 `slaveId` 的快照数组。

```js
console.log(master.slaves);
```

#### `masterOnline`

仅 `slave` 侧只读属性。

表示最近一次链路确认结果。

- `true`：最近收到合法的 `heartbeat_ack`，或收到来自 `master` 的合法业务帧
- `false`：尚未建立有效链路、心跳应答超时、或节点已停止

```js
console.log(slave.masterOnline);
```

#### `isMasterOnline()`

仅 `slave` 侧方法。

返回当前主节点在线状态。该值基于最近一次链路确认结果，不会主动发起实时网络探测。

```js
if (slave.isMasterOnline()) {
  console.log("master 在线");
}
```

#### `addAuthKey(slaveId, authKey)`

仅 `master` 侧使用。

动态添加或更新某个 `slave` 的 `authKey`，立即生效。

#### `removeAuthKey(slaveId)`

仅 `master` 侧使用。

移除某个 `slave` 的 `authKey`，立即生效，并触发 `slave_disconnected`。

## 心跳机制

ZNL 使用 `heartbeat -> heartbeat_ack` 进行链路确认。

流程如下：

1. `slave` 发送一条 `heartbeat`
2. `master` 收到并验证通过后，立即返回 `heartbeat_ack`
3. `slave` 收到 `heartbeat_ack` 后，调度下一次 heartbeat
4. 若超过应答超时时间仍未收到 `heartbeat_ack``
   - `slave` 将 `masterOnline` 置为 `false`
   - 主动重建 `Dealer`
   - 丢弃旧连接残留消息
   - 尝试恢复连接与注册

## 安全机制

当 `encrypted=true` 时，ZNL 启用安全模式：

- HMAC 签名
- 时间戳校验
- nonce 防重放
- AES-256-GCM 透明加密
- 可选 payload 摘要校验

### 安全建议

- `authKey` 不要硬编码到公开仓库
- `master` 与 `slave` 必须使用匹配的密钥配置
- 若使用 `authKeyMap`，建议按 `slaveId` 做最小权限配置
- 生产环境建议开启：
  - `encrypted: true`
  - `enablePayloadDigest: true`

## 底层帧协议

本节说明 ZNL 在 ZeroMQ 上层定义的控制帧结构，用于协议对接、调试与抓包分析。

### 总体说明

`master` 侧 ROUTER 收包结构：

```text
[identity, ...控制帧]
```

`slave` 侧 DEALER 收包结构：

```text
[...控制帧]
```

控制帧统一前缀：

```text
__znl_v1__
```

认证字段标记：

```text
__znl_v1_auth__
```

### 控制帧类型

| 类型 | 方向 | 作用 |
|------|------|------|
| `register` | `slave -> master` | 注册上线 |
| `unregister` | `slave -> master` | 主动下线 |
| `heartbeat` | `slave -> master` | 心跳请求 |
| `heartbeat_ack` | `master -> slave` | 心跳应答 |
| `req` | 双向 | RPC 请求 |
| `res` | 双向 | RPC 响应 |
| `pub` | `master -> slave` | 广播消息 |

### 各类帧结构

#### `register`

```text
[PREFIX, "register", (AUTH_MARKER, authProof)?]
```

示例：

```text
["__znl_v1__", "register"]
["__znl_v1__", "register", "__znl_v1_auth__", "<proof-token>"]
```

#### `unregister`

```text
[PREFIX, "unregister"]
```

示例：

```text
["__znl_v1__", "unregister"]
```

#### `heartbeat`

```text
[PREFIX, "heartbeat", (AUTH_MARKER, authProof)?]
```

示例：

```text
["__znl_v1__", "heartbeat"]
["__znl_v1__", "heartbeat", "__znl_v1_auth__", "<proof-token>"]
```

#### `heartbeat_ack`

```text
[PREFIX, "heartbeat_ack", (AUTH_MARKER, authProof)?]
```

示例：

```text
["__znl_v1__", "heartbeat_ack"]
["__znl_v1__", "heartbeat_ack", "__znl_v1_auth__", "<proof-token>"]
```

#### `req`

```text
[PREFIX, "req", requestId, (AUTH_MARKER, authProof)?, ...payloadFrames]
```

示例：

```text
["__znl_v1__", "req", "<requestId>", ...payloadFrames]
["__znl_v1__", "req", "<requestId>", "__znl_v1_auth__", "<proof-token>", ...payloadFrames]
```

#### `res`

```text
[PREFIX, "res", requestId, (AUTH_MARKER, authProof)?, ...payloadFrames]
```

示例：

```text
["__znl_v1__", "res", "<requestId>", ...payloadFrames]
["__znl_v1__", "res", "<requestId>", "__znl_v1_auth__", "<proof-token>", ...payloadFrames]
```

#### `pub`

```text
[PREFIX, "pub", topic, (AUTH_MARKER, authProof)?, ...payloadFrames]
```

示例：

```text
["__znl_v1__", "pub", "news", ...payloadFrames]
["__znl_v1__", "pub", "news", "__znl_v1_auth__", "<proof-token>", ...payloadFrames]
```

### 认证令牌字段

安全模式下，认证令牌内部包含以下字段：

- `kind`
- `nodeId`
- `requestId`
- `timestamp`
- `nonce`
- `payloadDigest`

校验时会验证：

- 帧类型是否匹配
- 节点 ID 是否匹配
- 请求 ID 是否匹配
- 时间戳是否在允许偏差内
- nonce 是否重复
- payload 摘要是否一致

### 明文模式与安全模式

#### 明文模式 `encrypted=false`

- 不签名
- 不加密
- 帧结构更轻量

#### 安全模式 `encrypted=true`

- 控制帧会附带认证证明
- 业务 payload 会被透明加密

## 事件

通过 `node.on(eventName, handler)` 监听：

| 事件 | 触发方 | 说明 |
|------|--------|------|
| `router` | Master | Router socket 收到原始帧（所有类型） |
| `dealer` | Slave | Dealer socket 收到原始帧（所有类型） |
| `request` | 两者 | 解析出 RPC 请求帧（认证通过后） |
| `response` | 两者 | 解析出 RPC 响应帧 |
| `message` | 两者 | 所有解析消息的统一事件 |
| `publish` | Slave | 收到 `master` 广播，携带 `{ topic, payload }` |
| `slave_connected` | Master | `slave` 注册成功上线，携带 `slaveId` |
| `slave_disconnected` | Master | `slave` 注销或发送失败下线，携带 `slaveId` |
| `auth_failed` | Master / Slave | 认证失败（签名校验失败、重放检测失败、解密失败等），请求已被丢弃 |
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

在同一进程内启动 `Master / Slave`，自动验证：

- RPC
- 并发
- 认证
- 超时
- PUB/SUB
- 心跳恢复
- 在线状态 API

```bash
pnpm test
```

## 并发压测

### 明文模式

```bash
# 终端 1：启动 Echo 服务端（plain）
pnpm test:echo

# 终端 2：发起并发压测（plain）
pnpm test:100 -- 100 10000 slave-001
```

### 安全模式

```bash
# 终端 1：加密模式启动 Echo 服务端
ZNL_AUTH_KEY=my-secret ZNL_ENCRYPTED=true pnpm test:echo

# 终端 2：加密模式压测
pnpm test:100 -- 100 10000 slave-001 my-secret true
```

### 参数说明

- 总请求数
- 超时时间（毫秒）
- `Slave` 节点 ID

## 常见问题

### 为什么 `slave.start()` 后立刻发送第一条请求可能失败？

当前版本对 `Dealer` 的发送策略更严格。建议先等待 `slave.isMasterOnline() === true`，再发送首个业务请求。

### 为什么会出现“令牌已过期或时间戳异常”？

常见原因：

- 主从机器时间差过大
- 节点时间被手动修改
- 历史旧消息在较晚时间才被投递

### `masterOnline=true` 是否表示此刻网络一定可用？

不是。该值表示最近一次链路确认成功，适合作为业务层在线状态参考，但不是一次即时网络探针。