# ZNL

基于 ZeroMQ `ROUTER / DEALER` 模式的 Node.js 通信库，提供：

- 双向 RPC
- 广播 / 订阅
- `Slave -> Master` 单向推送
- 在线状态感知
- 心跳保活
- 可选签名认证与透明加密
- 内建独立 `fs` 文件服务

## 文档导航

为了让文档结构更清晰，详细内容已经拆分到独立文件：

- API 参考：[docs/README.api.md](docs/README.api.md)
- 使用示例与实践：[docs/README.examples.md](docs/README.examples.md)
- 底层帧协议：[docs/README.protocol.md](docs/README.protocol.md)

建议阅读顺序：

1. 本文档：快速了解项目
2. [docs/README.examples.md](docs/README.examples.md)：先看怎么用
3. [docs/README.api.md](docs/README.api.md)：再查完整 API
4. [docs/README.protocol.md](docs/README.protocol.md)：最后看底层协议细节

---

## 特性

- 基于单连接实现双向 RPC 与广播
- 支持 `Master -> Slave` 与 `Slave -> Master` 双向主动请求
- 支持 `Slave -> Master` 单向推送（`PUSH`）
- `Slave` 自动注册 / 注销，`Master` 实时维护在线节点列表
- 支持请求超时控制与最大并发限制
- 心跳采用 `heartbeat -> heartbeat_ack` 应答机制
- `Slave` 提供主节点在线状态查询 API：`masterOnline` / `isMasterOnline()`
- 内建 `fs` 文件服务命名空间：
  - `master.fs.list/get/patch/delete/rename/stat`
  - `master.fs.upload/download`
  - `slave.fs.setRoot("./")`
- `fs` 走独立 service 通道，不占用业务 `request/response`
- 支持安全模式：
  - HMAC 签名
  - 时间戳校验
  - nonce 防重放
  - AES-256-GCM 透明加密
  - 可选 payload 摘要校验
- 支持 `authKeyMap`，允许 `Master` 按 `slaveId` 使用不同密钥
- Payload 支持 `string`、`Buffer`、`Uint8Array` 及其数组（多帧）

---

## 安装

```bash
pnpm add @lyrify/znl
```

本地开发：

```bash
pnpm install
```

---

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
});

master.ROUTER(async ({ identityText, payload }) => {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
  return `已收到来自 ${identityText} 的消息：${text}`;
});

master.on("slave_connected", (id) => {
  console.log(`${id} 上线，当前在线：${master.slaves.join(", ")}`);
});

await master.start();
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
});

await slave.start();

if (slave.isMasterOnline()) {
  const reply = await slave.DEALER("hello master", { timeoutMs: 4000 });
  console.log(reply.toString());
}
```

如果你想直接看更多完整示例，请阅读：

- [docs/README.examples.md](docs/README.examples.md)

---

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
  enablePayloadDigest: false,
  maxTimeSkewMs: 30000,
  replayWindowMs: 120000,
});
```

完整参数说明请查看：

- [docs/README.api.md](docs/README.api.md)

性能建议：

- 安全模式默认关闭 `enablePayloadDigest`
- 如需额外的 payload 摘要一致性校验，可显式设置 `enablePayloadDigest: true`
- 在高并发短消息场景下，关闭 `enablePayloadDigest` 通常可以获得更高吞吐

---

## 核心能力概览

### 双向 RPC

- `slave -> master`：`slave.DEALER(payload, options?)`
- `master -> slave`：`master.ROUTER(slaveId, payload, options?)`

同时两边都支持注册自动回复处理器：

- `master.ROUTER(handler)`
- `slave.DEALER(handler)`

### 广播 / 订阅 / 推送

- 广播：`master.PUBLISH(topic, payload)`
- 订阅：`slave.SUBSCRIBE(topic, handler)`
- 取消订阅：`slave.UNSUBSCRIBE(topic)`
- 单向推送：`slave.PUSH(topic, payload)`

### 在线状态

- `master.slaves`
- `slave.masterOnline`
- `slave.isMasterOnline()`

### 安全能力

当 `encrypted=true` 时，ZNL 启用：

- HMAC 签名
- 时间戳校验
- nonce 防重放
- AES-256-GCM 透明加密
- 可选 payload 摘要校验

---

## 内建文件服务（fs）

ZNL 内建了一个独立于业务 RPC 的文件服务通道：

- `master.fs.*` 通过内部 `service` 通道与指定 `slave` 通信
- 不会占用或污染现有 `DEALER()` / `ROUTER()` 业务请求流
- `encrypted=true` 时，`fs` 通道同样复用签名、防重放与透明加密机制

### 启用方式

`slave` 侧只需要设置根目录：

```js
const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
});

slave.fs.setRoot("./storage");
await slave.start();
```

### 主要 API

- `slave.fs.setRoot(rootPath)`
- `master.fs.list(slaveId, path, options?)`
- `master.fs.get(slaveId, path, options?)`
- `master.fs.patch(slaveId, path, unifiedDiff, options?)`
- `master.fs.delete(slaveId, path, options?)`
- `master.fs.rename(slaveId, from, to, options?)`
- `master.fs.stat(slaveId, path, options?)`
- `master.fs.upload(slaveId, localPath, remotePath, options?)`
- `master.fs.download(slaveId, remotePath, localPath, options?)`

详细 API 和完整示例请分别查看：

- API：[docs/README.api.md](docs/README.api.md)
- 示例：[docs/README.examples.md](docs/README.examples.md)

---

## 文档拆分说明

当前文档只保留：

- 项目简介
- 快速开始
- 核心能力概览
- 文档入口导航

详细内容已拆分为独立文档：

### 1. API 参考

[docs/README.api.md](docs/README.api.md)

适合查阅：

- 构造参数
- 生命周期 API
- 双向 RPC API
- 广播 / 订阅 / 推送 API
- 在线状态与密钥管理 API
- 完整 `fs` API
- 事件列表
- 返回值与使用建议

### 2. 使用示例与实践

[docs/README.examples.md](docs/README.examples.md)

适合查阅：

- 最小可运行示例
- Master / Slave 启动方式
- 双向 RPC 示例
- 广播、订阅、推送示例
- 安全模式示例
- `fs` 的 CRUD / patch / upload / download 示例
- 实战组织建议与排障建议

### 3. 底层协议说明

[docs/README.protocol.md](docs/README.protocol.md)

适合查阅：

- 真实 ZeroMQ 外层控制帧
- `req/res` 与 `svc_req/svc_res` 的区别
- 明文模式与安全模式的差异
- `fs` service 的底层承载方式
- 抓包、协议对接、排障参考

---

## 事件

通过 `node.on(eventName, handler)` 监听：

| 事件 | 触发方 | 说明 |
|------|--------|------|
| `router` | Master | ROUTER socket 收到原始帧（所有类型） |
| `dealer` | Slave | DEALER socket 收到原始帧（所有类型） |
| `request` | 两者 | 解析出 RPC 请求帧（认证通过后） |
| `response` | 两者 | 解析出 RPC 响应帧 |
| `message` | 两者 | 所有解析消息的统一事件 |
| `publish` | Slave | 收到 `master` 广播，携带 `{ topic, payload }` |
| `push` | Master | 收到 `slave` 推送，携带 `{ identityText, topic, payload }` |
| `slave_connected` | Master | `slave` 注册成功上线，携带 `slaveId` |
| `slave_disconnected` | Master | `slave` 注销或发送失败下线，携带 `slaveId` |
| `auth_failed` | Master / Slave | 认证失败（签名校验失败、重放检测失败、解密失败等），请求已被丢弃 |
| `error` | 两者 | 内部错误 |

完整事件说明请查看：

- `docs/README.api.md`

---

## 本地示例

```bash
# 终端 1：启动 Master
pnpm example:master

# 终端 2：启动 Slave（可指定 ID）
pnpm example:slave
node test/slave/index.js slave-001
```

如需查看更多实践示例，请阅读：

- `docs/README.examples.md`

---

## 集成测试

在同一进程内启动 `Master / Slave`，自动验证：

- RPC
- 并发
- 认证
- 超时
- PUB/SUB
- 心跳恢复
- 在线状态 API
- 内建 `fs` 文件服务

```bash
pnpm test
```

---

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

---

## 常见问题

### 为什么 `slave.start()` 后立刻发送第一条请求可能失败？

当前版本对 `Dealer` 的发送策略更严格。建议先等待 `slave.isMasterOnline() === true`，再发送首个业务请求。

更完整的启动建议请查看：

- `docs/README.examples.md`

### 为什么会出现“令牌已过期或时间戳异常”？

常见原因：

- 主从机器时间差过大
- 节点时间被手动修改
- 历史旧消息在较晚时间才被投递

协议与安全细节请查看：

- `docs/README.protocol.md`

### `masterOnline=true` 是否表示此刻网络一定可用？

不是。该值表示最近一次链路确认成功，适合作为业务层在线状态参考，但不是一次即时网络探针。

---

## 总结

如果你只想快速记住 ZNL 的核心入口，可以先记住这些：

- 双向 RPC：`DEALER()` / `ROUTER()`
- 广播：`PUBLISH()` / `SUBSCRIBE()`
- 推送：`PUSH()`
- 在线状态：`masterOnline` / `isMasterOnline()`
- 文件服务：`slave.fs.setRoot()` + `master.fs.*`
- 安全模式：`encrypted: true` + `authKey/authKeyMap`

详细内容请继续阅读：

- [docs/README.api.md](docs/README.api.md)
- [docs/README.examples.md](docs/README.examples.md)
- [docs/README.protocol.md](docs/README.protocol.md)
