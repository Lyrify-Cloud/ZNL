# ZNL API 参考文档

本文件专门说明 `ZNL` 的公开 API，包括：

- 构造参数
- 生命周期
- 双向 RPC
- 广播 / 订阅 / 推送
- 在线状态
- 安全相关方法
- 内建 `fs` 文件服务
- 事件列表
- 返回值与数据约定
- 使用建议

相关文档：

- 主说明：[README.md](../README.md)
- 底层协议：[README.protocol.md](./README.protocol.md)

## 文档导航

本文档按两条主线组织：

1. 通用 API
2. `fs` API

如果你只是想快速查接口，建议优先看下面两个导航区。

### 通用 API 导航

通用 API 主要覆盖 ZNL 的基础通信能力与运行时能力：

- [`2. 构造函数`](#2-构造函数)
- [`3. 生命周期 API`](#3-生命周期-api)
- [`4. 双向 RPC API`](#4-双向-rpc-api)
- [`5. 广播 / 订阅 / 推送 API`](#5-广播--订阅--推送-api)
- [`6. 在线状态与节点管理 API`](#6-在线状态与节点管理-api)
- [`8. 事件 API`](#8-事件-api)
- [`9. Payload 与返回值约定`](#9-payload-与返回值约定)
- [`10. 使用建议与最佳实践`](#10-使用建议与最佳实践)
- [`11. 典型 API 选择建议`](#11-典型-api-选择建议)

适合查阅：

- `new ZNL(options)` 怎么配
- `DEALER()` / `ROUTER()` 返回什么
- `PUBLISH()` / `SUBSCRIBE()` / `PUSH()` 怎么用
- `master.slaves` / `slave.masterOnline` 是什么
- 事件怎么监听
- 通用 payload 和返回值长什么样

### `fs` API 导航

`fs` API 专门覆盖内建文件服务：

- [`7. 内建文件服务 fs API`](#7-内建文件服务-fs-api)
  - [`7.1 slave.fs.setRoot(rootPath)`](#71-slavefssetrootrootpath)
  - [`7.2 master.fs.list(slaveId, path, options?)`](#72-masterfslistslaveid-path-options)
  - [`7.3 master.fs.get(slaveId, path, options?)`](#73-masterfsgetslaveid-path-options)
  - [`7.3.1 master.fs.create(slaveId, path, options?)`](#731-masterfscreateslaveid-path-options)
  - [`7.3.2 master.fs.mkdir(slaveId, path, options?)`](#732-masterfsmkdirslaveid-path-options)
  - [`7.4 master.fs.patch(slaveId, path, unifiedDiff, options?)`](#74-masterfspatchslaveid-path-unifieddiff-options)
  - [`7.5 master.fs.delete(slaveId, path, options?)`](#75-masterfsdeleteslaveid-path-options)
  - [`7.6 master.fs.rename(slaveId, from, to, options?)`](#76-masterfsrenameslaveid-from-to-options)
  - [`7.7 master.fs.stat(slaveId, path, options?)`](#77-masterfsstatslaveid-path-options)
  - [`7.8 master.fs.upload(slaveId, localPath, remotePath, options?)`](#78-masterfsuploadslaveid-localpath-remotepath-options)
  - [`7.9 master.fs.download(slaveId, remotePath, localPath, options?)`](#79-masterfsdownloadslaveid-remotepath-localpath-options)
  - [`7.10 fs 使用建议`](#710-fs-使用建议)

适合查阅：

- `slave.fs.setRoot()` 怎么启用
- `master.fs.*` 每个接口的真实返回值
- `get()` 为什么返回 `{ meta, body }`
- `upload()` / `download()` 的最终返回结构
- 目录浏览、文本 patch、大文件传输怎么选

---

## 1. 总览

`ZNL` 是一个基于 ZeroMQ `ROUTER / DEALER` 模式的 Node.js 通信库，支持：

- `Master -> Slave` 主动 RPC
- `Slave -> Master` 主动 RPC
- `Master -> Slave` 广播
- `Slave -> Master` 单向推送
- 在线状态维护
- 心跳保活
- 可选签名、防重放、透明加密
- 独立于业务 RPC 的内建 `fs` 文件服务

实例化入口：

- `new ZNL(options)`

---

## 2. 构造函数

### 2.1 调用方式

`new ZNL(options)`

### 2.2 参数列表

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `role` | `"master"` \| `"slave"` | 是 | - | 节点角色 |
| `id` | `string` | 是 | - | 节点唯一标识 |
| `endpoints` | `object` | 否 | `{}` | 连接配置 |
| `endpoints.router` | `string` | 否 | `tcp://127.0.0.1:6003` | ROUTER 端点 |
| `maxPending` | `number` | 否 | `1000` | 最大并发 RPC 数；`0` 表示不限制 |
| `authKey` | `string` | 否 | `""` | 共享认证密钥 |
| `authKeyMap` | `Record<string, string>` | 否 | `undefined` | `master` 侧按 `slaveId` 指定密钥 |
| `heartbeatInterval` | `number` | 否 | `3000` | 心跳间隔毫秒；`0` 表示禁用 |
| `heartbeatTimeoutMs` | `number` | 否 | `0` | 心跳超时；`0` 表示使用 `heartbeatInterval × 3` |
| `encrypted` | `boolean` | 否 | `false` | 是否启用安全模式 |
| `enablePayloadDigest` | `boolean` | 否 | `false` | 是否启用 payload 摘要校验 |
| `maxTimeSkewMs` | `number` | 否 | `30000` | 时间戳允许偏差 |
| `replayWindowMs` | `number` | 否 | `120000` | nonce 重放缓存窗口 |

### 2.3 参数说明

#### `role`

- `master`：主节点
- `slave`：从节点

不同角色下可用 API 不同，例如：

- `master` 可使用 `ROUTER(slaveId, payload, options?)`
- `slave` 可使用 `DEALER(payload, options?)`

#### `id`

节点唯一标识。

说明：

- 在 `master` 侧，用于标识主节点实例
- 在 `slave` 侧，同时作为 ZMQ `routingId`
- 建议全局唯一，避免路由混乱

#### `endpoints.router`

ZMQ 连接地址。

常见示例：

- `tcp://127.0.0.1:6003`
- `tcp://0.0.0.0:6003`

角色行为：

- `master`：绑定该地址
- `slave`：连接该地址

#### `maxPending`

最大并发中的请求数量限制。

说明：

- 默认 `1000`
- `0` 表示不限制
- 超出上限时，新请求会被拒绝或抛出错误

建议：

- 高并发场景中不要盲目设为 `0`
- 结合你的业务超时和吞吐要求调整

#### `authKey`

共享认证密钥。

适用于：

- 明文模式下的签名校验
- 安全模式下的签名与加密密钥派生

注意：

- 当 `encrypted=true` 时，必须保证双方密钥可用
- 不建议把真实密钥写入公开仓库

#### `authKeyMap`

仅 `master` 侧有意义。

用途：

- 按 `slaveId` 维护不同的认证密钥
- 适用于多节点、分节点授权场景

查找逻辑：

1. 优先命中 `authKeyMap[slaveId]`
2. 未命中时回退到 `authKey`

#### `heartbeatInterval`

心跳发送间隔。

说明：

- 仅 `slave` 主动发送 `heartbeat`
- `master` 收到后回 `heartbeat_ack`
- `0` 表示禁用心跳

#### `heartbeatTimeoutMs`

单次心跳等待应答超时时间。

说明：

- `0` 时自动按 `heartbeatInterval × 3` 计算
- 超时后 `slave` 会认为主链路失效

#### `encrypted`

是否启用安全模式。

- `false`：明文模式
- `true`：签名、防重放、透明加密模式

启用后：

- `req/res`
- `pub/push`
- `svc_req/svc_res`
- `fs` 文件服务

都会进入安全信封流程。

#### `enablePayloadDigest`

是否对 payload 做摘要保护。

作用：

- 为 payload 增加额外摘要校验
- 开启后会带来额外哈希计算开销
- 关闭后通常可显著提升加密模式下的吞吐

说明：

- 默认值为 `false`
- `encrypted=true` 时，ZNL 仍然保留签名、防重放与 AES-GCM 透明加密
- 由于 AES-GCM 已提供完整性校验，很多高吞吐场景下无需额外开启该选项

建议：

- 高吞吐、低延迟优先场景：保持 `false`
- 对 payload 额外摘要校验有明确需求时，再显式设为 `true`
- `master` 与 `slave` 两端应保持一致，否则认证会失败

#### `maxTimeSkewMs`

允许的消息时间戳漂移窗口。

用于：

- 检查消息是否过旧或时间异常

#### `replayWindowMs`

nonce 防重放窗口。

作用：

- 在窗口期内缓存已见过的 nonce
- 重复 nonce 会被视为重放攻击并丢弃

---

## 3. 生命周期 API

### 3.1 `start()`

启动当前节点。

返回：

- `Promise<void>`

#### `master.start()`

会执行：

- 创建并绑定 ROUTER socket
- 开始接收注册、心跳、业务帧、service 帧
- 维护在线节点列表

#### `slave.start()`

会执行：

- 创建并连接 DEALER socket
- 发送注册帧
- 启动心跳流程
- 接收主节点业务帧与广播帧
- 接收 service 响应帧

使用建议：

- 在调用前先完成处理器注册
- `slave.fs.setRoot()` 建议在 `start()` 前调用

### 3.2 `stop()`

停止当前节点。

返回：

- `Promise<void>`

#### `master.stop()`

会执行：

- 关闭 ROUTER socket
- 清空在线节点表
- reject 所有 pending 请求
- 停止相关内部定时器

#### `slave.stop()`

会执行：

- 停止心跳
- 尝试发送注销帧
- 关闭 DEALER socket
- 结束当前链路状态

注意：

- `stop()` 后如果要继续使用，应重新 `start()`
- 订阅关系通常可跨 `stop()/start()` 周期保留

---

## 4. 双向 RPC API

ZNL 的业务 RPC 由以下两个入口组成：

- `master.ROUTER(...)`
- `slave.DEALER(...)`

二者都同时承担两种角色：

1. 主动发起请求
2. 注册自动回复处理器

---

### 4.1 `DEALER(payloadOrHandler, options?)`

仅 `slave` 侧使用。

### 模式 A：主动发起请求

调用形式：

- `await slave.DEALER(payload, options?)`

含义：

- `slave -> master` 发起一次业务 RPC 请求

返回：

- `Promise<Buffer | Buffer[]>`

真实返回规则（按源码实现）：

- `slave.DEALER(payload, options?)` 最终直接返回 `response.payload`
- 如果对端响应是 **单帧**，返回值就是 `Buffer`
- 如果对端响应是 **多帧**，返回值就是 `Buffer[]`
- 不会额外包一层 `{ data, payload, meta }` 之类的对象

也就是说，业务 RPC 的返回值就是**对端 handler 返回内容对应的 payload 本体**。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `payload` | `string` \| `Buffer` \| `Uint8Array` \| 其数组 | 是 | 请求载荷 |
| `options` | `object` | 否 | 请求控制参数 |
| `options.timeoutMs` | `number` | 否 | 超时时间，默认 `5000` |

#### 使用建议

- 建议在 `slave.isMasterOnline()` 为 `true` 后再发送首个请求
- 大体积文件不要走业务 RPC，优先使用 `master.fs.*`

### 模式 B：注册自动回复处理器

调用形式：

- `slave.DEALER(handler)`

含义：

- 注册 `slave` 侧的 RPC 自动回复处理器
- 用于处理 `master -> slave` 的主动业务调用

#### `handler` 约定

处理器通常会收到解析后的上下文对象，常见可用字段包括：

- `payload`
- `requestId`
- 其他内部解析信息

返回值支持：

- `string`
- `Buffer`
- `Uint8Array`
- 帧数组
- `Promise<上述类型>`

建议：

- 处理器内自行做好输入格式校验
- 若返回 JSON，建议业务层自己 `JSON.stringify()`

---

### 4.2 `ROUTER(identityOrHandler, payload?, options?)`

仅 `master` 侧使用。

### 模式 A：主动发起请求

调用形式：

- `await master.ROUTER(slaveId, payload, options?)`

含义：

- `master -> slave` 发起一次业务 RPC 请求

返回：

- `Promise<Buffer | Buffer[]>`

真实返回规则（按源码实现）：

- `master.ROUTER(slaveId, payload, options?)` 最终直接返回 `response.payload`
- 如果对端响应是 **单帧**，返回值就是 `Buffer`
- 如果对端响应是 **多帧**，返回值就是 `Buffer[]`
- 不会额外包一层响应对象

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标 slave 节点 ID |
| `payload` | `string` \| `Buffer` \| `Uint8Array` \| 其数组 | 是 | 请求载荷 |
| `options` | `object` | 否 | 请求控制参数 |
| `options.timeoutMs` | `number` | 否 | 超时时间，默认 `5000` |

使用前提：

- 目标 `slaveId` 必须在线
- 对端应已注册 `DEALER(handler)` 自动回复处理器，或具备兼容的请求处理逻辑

### 模式 B：注册自动回复处理器

调用形式：

- `master.ROUTER(handler)`

含义：

- 注册 `master` 侧自动回复处理器
- 用于处理 `slave -> master` 的主动 RPC 请求

#### `handler` 约定

处理器通常会收到上下文对象，常见字段包括：

- `identity`
- `identityText`
- `payload`
- `requestId`

常见用途：

- 构建统一业务入口
- 做 RPC 路由分发
- 处理从节点上报后的同步请求

---

### 4.3 `options.timeoutMs`

适用于：

- `slave.DEALER(payload, options?)`
- `master.ROUTER(slaveId, payload, options?)`
- `master.fs.*` 大部分请求方法

默认值：

- `5000`

含义：

- 单次请求在超时时间内未拿到响应，则 reject

建议：

- 普通 RPC：`3000` 到 `5000`
- 大文件传输：按分片大小与网络情况适当增大

---

## 5. 广播 / 订阅 / 推送 API

---

### 5.1 `PUBLISH(topic, payload)`

仅 `master` 侧使用。

含义：

- 向所有在线 `slave` 广播消息
- fire-and-forget，不需要 `await`

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | `string` | 是 | 广播主题 |
| `payload` | `string` \| `Buffer` \| `Uint8Array` \| 其数组 | 是 | 广播内容 |

行为特点：

- 广播给当前在线的所有从节点
- 某个节点发送失败时，可能被移出在线列表
- 失败节点通常会触发 `slave_disconnected`

适用场景：

- 配置下发
- 通知广播
- 实时状态广播
- 多节点轻量消息发布

---

### 5.2 `SUBSCRIBE(topic, handler)`

仅 `slave` 侧使用。

含义：

- 订阅指定 topic
- 注册 topic 对应处理器

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | `string` | 是 | 主题名 |
| `handler` | `Function` | 是 | 收到该 topic 时的处理器 |

返回：

- `this`

特点：

- 可在 `start()` 前调用
- 可在 `start()` 后动态调用
- 同一 topic 重复订阅会覆盖旧处理器
- 支持链式调用

#### `handler` 常见参数

处理器通常接收对象：

- `topic`
- `payload`

建议：

- 如果 `payload` 是文本，使用 `payload.toString()`
- 如果是 JSON，先转字符串再解析

---

### 5.3 `UNSUBSCRIBE(topic)`

仅 `slave` 侧使用。

含义：

- 取消某个 topic 的订阅

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | `string` | 是 | 要取消的主题 |

返回：

- 通常为当前实例或无显式返回值，具体按实现使用即可

---

### 5.4 `PUSH(topic, payload)`

仅 `slave` 侧使用。

含义：

- 向 `master` 单向推送消息
- fire-and-forget，不需要 `await`

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | `string` | 是 | 推送主题 |
| `payload` | `string` \| `Buffer` \| `Uint8Array` \| 其数组 | 是 | 推送内容 |

适用场景：

- 指标上报
- 状态心跳扩展
- 日志汇报
- 告警通知

与 RPC 的区别：

- 不等待响应
- 不建立 requestId 响应链路
- 更适合一次性事件上报

---

## 6. 在线状态与节点管理 API

---

### 6.1 `slaves`

仅 `master` 侧只读属性。

类型：

- `string[]`

含义：

- 返回当前在线 `slaveId` 快照数组

特点：

- 是快照，不一定与下一时刻完全一致
- 适合做展示、遍历广播目标、控制台观测

---

### 6.2 `masterOnline`

仅 `slave` 侧只读属性。

类型：

- `boolean`

含义：

- 表示最近一次链路确认结果

为 `true` 的典型情况：

- 最近收到合法 `heartbeat_ack`
- 最近收到来自 `master` 的合法业务帧

为 `false` 的典型情况：

- 尚未成功完成链路确认
- 心跳超时
- 节点已停止
- 链路重建中

注意：

- 这不是实时网络探针结果
- 它表示“最近一次确认链路可用”

---

### 6.3 `isMasterOnline()`

仅 `slave` 侧方法。

返回：

- `boolean`

含义：

- 返回当前 `masterOnline` 状态

建议用途：

- 发送首条业务消息前的门禁判断
- UI 或控制台状态展示
- 业务层的简单链路可用性参考

---

### 6.4 `addAuthKey(slaveId, authKey)`

仅 `master` 侧使用。

含义：

- 为某个 `slaveId` 动态添加或更新认证密钥

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 ID |
| `authKey` | `string` | 是 | 新密钥 |

特点：

- 立即生效
- 适合运行时热更新密钥映射

适用场景：

- 新节点上线
- 节点密钥轮换
- 动态授权

---

### 6.5 `removeAuthKey(slaveId)`

仅 `master` 侧使用。

含义：

- 移除某个 `slaveId` 的认证密钥

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 ID |

行为：

- 密钥移除后，该节点后续认证将无法通过
- 通常会触发该节点下线处理
- 一般伴随 `slave_disconnected`

---

## 7. 内建文件服务 `fs` API

ZNL 内建一个独立于业务 `req/res` 的 service 通道。

关键点：

- `master.fs.*` 不复用业务 RPC
- 底层走 `svc_req / svc_res`
- `encrypted=true` 时同样进入安全信封
- 适合做远程文件管理和文件传输

---

### 7.1 `slave.fs.setRoot(rootPath, policy?)`

仅 `slave` 侧使用。

含义：

- 设置文件服务根目录
- 启用当前节点的内建 `fs` 服务
- 可选配置当前根目录对应的访问策略

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `rootPath` | `string` | 是 | 文件服务根目录 |
| `policy` | `object` | 否 | 文件服务策略配置 |

#### `policy` 可选字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `readOnly` | `boolean` | `false` | 是否开启只读模式；开启后会拒绝所有写操作 |
| `allowDelete` | `boolean` | `true` | 是否允许 `master.fs.delete()` |
| `allowPatch` | `boolean` | `true` | 是否允许 `master.fs.patch()` |
| `allowUpload` | `boolean` | `true` | 是否允许 `master.fs.upload()` |
| `allowedPaths` | `string[]` | `[]` | 路径白名单；非空时，只有命中的路径才允许访问 |
| `denyGlobs` | `string[]` | `[]` | 拒绝规则；命中后直接拒绝访问 |
| `getAllowedExtensions` | `string[]` | 常见文本扩展名集合 | 限制 `master.fs.get()` 允许读取的扩展名（仅文本类） |
| `maxGetFileMb` | `number` | `4` | 限制 `master.fs.get()` 单文件最大读取体积（MB） |

#### `policy` 的真实行为

1. `readOnly: true`

会拒绝所有写操作，包括：

- `master.fs.create()`
- `master.fs.mkdir()`
- `master.fs.patch()`
- `master.fs.delete()`
- `master.fs.rename()`
- `master.fs.upload()`

并且：

- `readOnly=true` 时，`allowDelete / allowPatch / allowUpload` 会被视为不可用
- `list()` / `stat()` / `download()` 仍允许执行
- `get()` 仍属于读操作，但会继续受 `getAllowedExtensions` 与 `maxGetFileMb` 限制

2. `allowDelete: false`

会拒绝：

- `master.fs.delete()`

3. `allowPatch: false`

会拒绝：

- `master.fs.patch()`

4. `allowUpload: false`

会拒绝：

- `master.fs.create()`
- `master.fs.mkdir()`
- `master.fs.upload()`

5. `allowedPaths`

用于限制允许访问的路径范围。

特点：

- 传空数组表示不额外限制
- 传非空数组后，只有命中的路径才允许访问
- 支持目录前缀写法，也兼容简单 glob 风格写法
- 例如 `public`、`public/**` 都可用于限制只允许访问 `public` 目录及其子路径

6. `denyGlobs`

用于配置显式拒绝规则。

特点：

- 命中后会直接拒绝访问
- 优先作为“黑名单”使用
- 支持常见 glob 形式，例如：
  - `**/*.secret.txt`
  - `private/**`

#### 行为说明

- `rootPath` 必须传入非空路径
- 内部会解析为绝对路径
- 所有远程访问都会限制在该目录下
- 越权路径会被拒绝
- 当前实现会拒绝通过符号链接访问目标
- 如果路径中任何已有层级是符号链接，访问会被拒绝
- `fs root` 自身也不能是符号链接
- `list()` 返回目录项时，仍可能显示 `type: "symlink"`，但后续访问该链接目标会被拒绝

#### 关于符号链接 / junction 的真实安全行为

当前实现会在服务端访问路径时做额外保护：

- 不仅检查路径字符串是否落在 `rootPath` 内
- 还会检查访问路径的已有层级中是否包含符号链接
- 因此会拒绝通过 root 内部的 symlink / junction 间接跳到 root 外部

这意味着以下场景会被拒绝：

- `root` 内某个目录项是符号链接
- 该符号链接指向 `root` 外的文件或目录
- 再通过 `master.fs.get()` / `stat()` / `download()` / `list()` 等尝试访问它

#### 失败时的典型错误原因

常见拒绝原因包括：

- 路径越权：目标不在 root 范围内
- 路径中包含符号链接
- 当前 fs root 为只读模式
- 路径不在 `allowedPaths` 范围内
- 路径命中 `denyGlobs`
- `allowDelete=false`
- `allowPatch=false`
- `allowUpload=false`
- `getAllowedExtensions` 未命中（例如 `.bin` 这类非文本扩展名）
- 文件大小超过 `maxGetFileMb`（需改用 `master.fs.download()`）

建议：

- 在 `start()` 前调用
- 为每个 `slave` 配置明确的隔离目录
- 生产环境建议优先配合 `encrypted=true`
- 如果暴露的是共享目录，建议显式设置策略而不是只依赖根目录隔离

#### 示例

```/dev/null/example.js#L1-18
const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
});

slave.fs.setRoot("./storage", {
  readOnly: false,
  allowDelete: false,
  allowPatch: true,
  allowUpload: true,
  allowedPaths: ["public/**", "configs"],
  denyGlobs: ["**/*.secret.txt", "private/**"],
  getAllowedExtensions: ["txt", "md", "json", "js", "ts", "toml", "yaml", "yml"],
  maxGetFileMb: 4,
});
```

---

### 7.2 `master.fs.list(slaveId, path, options?)`

列出远端目录内容。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `path` | `string` | 是 | 远端相对路径 |
| `options` | `object` | 否 | 附加参数 |
| `options.timeoutMs` | `number` | 否 | 请求超时 |

#### 返回值

`master.fs.list()` 成功时**直接返回远端 `meta` 对象本身**，真实结构为：

- `Promise<{
    ok: true,
    op: "file/list",
    path: string,
    entries: Array<{
      name: string,
      type: "file" | "dir" | "symlink",
      size: number,
      mtime: number,
      isFile: boolean,
      isDirectory: boolean,
      isSymbolicLink: boolean
    }>
  }>`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/list"` | 固定操作名 |
| `path` | `string` | 你传入的远端目录路径 |
| `entries` | `Array<object>` | 目录项列表 |

#### `entries[]` 真实字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 文件或目录名 |
| `type` | `"file" \| "dir" \| "symlink"` | 目录项类型；真实返回值只会是 `file`、`dir`、`symlink` 三者之一 |
| `size` | `number` | 字节大小 |
| `mtime` | `number` | `mtimeMs`，毫秒时间戳 |
| `isFile` | `boolean` | 是否文件 |
| `isDirectory` | `boolean` | 是否目录 |
| `isSymbolicLink` | `boolean` | 是否符号链接 |

失败时不会返回错误对象，而是直接抛错。

适用场景：

- 文件浏览器
- 远程目录遍历
- 管理界面展示

---

### 7.3 `master.fs.get(slaveId, path, options?)`

读取远端文件。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `path` | `string` | 是 | 远端文件路径 |
| `options` | `object` | 否 | 附加参数 |

#### 返回值

`master.fs.get()` 是 `master.fs.*` 里**唯一一个不直接返回 `meta`，而是返回完整解析结果对象**的方法。

真实返回结构为：

- `Promise<{
    meta: {
      ok: true,
      op: "file/get",
      path: string,
      size: number
    },
    body: Buffer[]
  }>`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `meta.ok` | `true` | 成功时固定为 `true` |
| `meta.op` | `"file/get"` | 固定操作名 |
| `meta.path` | `string` | 远端文件路径 |
| `meta.size` | `number` | 文件字节大小 |
| `body` | `Buffer[]` | 文件内容帧数组 |

当前服务端实现会把整个文件作为 **单个 body 帧** 返回，所以常见读取方式是：

- `result.body[0]`：文件内容 `Buffer`

也就是说，当前实际形态通常是：

- `result.meta`：文件元信息
- `result.body.length === 1`
- `result.body[0]`：完整文件内容

失败时不会返回 `{ ok: false }` 给调用方，而是直接抛错。

---

### 7.3.1 `master.fs.create(slaveId, path, options?)`

在远端创建空文件。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `path` | `string` | 是 | 远端文件路径 |
| `options` | `object` | 否 | 附加参数 |
| `options.overwrite` | `boolean` | 否 | 是否允许覆盖已存在的文件，默认 `false` |
| `options.recursive` | `boolean` | 否 | 是否自动创建缺失父目录，默认 `true` |
| `options.timeoutMs` | `number` | 否 | 请求超时 |

#### 返回值

`master.fs.create()` 成功时直接返回远端 `meta` 对象，真实结构为：

- `{
    ok: true,
    op: "file/create",
    path: string,
    created: true,
    overwritten: boolean
  }`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/create"` | 固定操作名 |
| `path` | `string` | 目标路径 |
| `created` | `true` | 当前实现成功时固定为 `true` |
| `overwritten` | `boolean` | 是否覆盖了已有文件 |

#### 行为说明

- 当前会创建空文件
- 默认 `recursive=true`，缺失的父目录会自动创建
- 默认 `overwrite=false`，目标已存在时会直接抛错
- 若目标已存在且是目录，会直接抛错
- 受 `slave.fs.setRoot()` 根目录限制
- 受 `readOnly`、`allowedPaths`、`denyGlobs` 影响
- 当前实现中，`create()` 也受 `allowUpload` 限制

#### 适用场景

- 远端预创建占位文件
- 先建空文件，再配合 `patch()` 写入文本内容
- 管理端初始化目录结构中的空文件

---

### 7.3.2 `master.fs.mkdir(slaveId, path, options?)`

在远端创建目录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `path` | `string` | 是 | 远端目录路径 |
| `options` | `object` | 否 | 附加参数 |
| `options.recursive` | `boolean` | 否 | 是否自动创建缺失父目录，默认 `true` |
| `options.existOk` | `boolean` | 否 | 目录已存在时是否视为成功，默认 `true` |
| `options.timeoutMs` | `number` | 否 | 请求超时 |

#### 返回值

`master.fs.mkdir()` 成功时直接返回远端 `meta` 对象，真实结构为：

- `{
    ok: true,
    op: "file/mkdir",
    path: string,
    created: true,
    existed: boolean
  }`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/mkdir"` | 固定操作名 |
| `path` | `string` | 目标路径 |
| `created` | `true` | 当前实现成功时固定为 `true` |
| `existed` | `boolean` | 目标目录在本次调用前是否已存在 |

#### 行为说明

- 当前会创建目录，而不是文件
- 默认 `recursive=true`，缺失的父目录会自动创建
- 默认 `existOk=true`，目标目录已存在时视为成功
- 若目标已存在且是文件，会直接抛错
- 受 `slave.fs.setRoot()` 根目录限制
- 受 `readOnly`、`allowedPaths`、`denyGlobs` 影响
- 当前实现中，`mkdir()` 也受 `allowUpload` 限制

#### 适用场景

- 远端预创建目录结构
- 上传前准备目标目录
- 初始化配置、日志、缓存目录

---

### 7.4 `master.fs.patch(slaveId, path, unifiedDiff, options?)`

对远端文本文件应用 unified diff。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `path` | `string` | 是 | 远端文本文件路径 |
| `unifiedDiff` | `string` | 是 | unified diff 文本 |
| `options` | `object` | 否 | 附加参数 |

#### 特点

- 基于文本内容做 patch
- 内部使用更稳妥的写入流程
- patch 失败时会返回未应用状态，而不是盲写覆盖

#### 返回值

`master.fs.patch()` 成功时直接返回远端 `meta` 对象，真实返回值有两种：

1. patch 应用成功

- `{
    ok: true,
    op: "file/patch",
    path: string,
    applied: true
  }`

2. patch 未能应用，但请求本身成功到达并被处理

- `{
    ok: true,
    op: "file/patch",
    path: string,
    applied: false,
    message: "patch 应用失败"
  }`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 请求成功到达并被处理 |
| `op` | `"file/patch"` | 固定操作名 |
| `path` | `string` | 目标路径 |
| `applied` | `boolean` | patch 是否成功应用 |
| `message` | `string` | 仅在 `applied: false` 时返回，当前实现固定为 `"patch 应用失败"` |

注意：

- 适合文本文件
- 不适合二进制文件
- diff 内容应与目标文件基线一致

---

### 7.5 `master.fs.delete(slaveId, path, options?)`

删除远端文件或目录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `path` | `string` | 是 | 远端路径 |
| `options` | `object` | 否 | 附加参数 |

#### 返回值

`master.fs.delete()` 成功时直接返回远端 `meta` 对象，真实结构为：

- `{
    ok: true,
    op: "file/delete",
    path: string
  }`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/delete"` | 固定操作名 |
| `path` | `string` | 被删除的远端路径 |

特点：

- 文件和目录统一入口
- 目录支持递归删除
- 受 `slave.fs.setRoot()` 根目录限制

建议：

- 管理后台调用前做好二次确认
- 如果是批量删除，业务层建议先 `list()` 再执行

---

### 7.6 `master.fs.rename(slaveId, from, to, options?)`

重命名或移动远端文件 / 目录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `from` | `string` | 是 | 原路径 |
| `to` | `string` | 是 | 目标路径 |
| `options` | `object` | 否 | 附加参数 |

#### 返回值

`master.fs.rename()` 成功时直接返回远端 `meta` 对象，真实结构为：

- `{
    ok: true,
    op: "file/rename",
    from: string,
    to: string
  }`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/rename"` | 固定操作名 |
| `from` | `string` | 原路径 |
| `to` | `string` | 新路径 |

特点：

- 可做同目录重命名
- 可做跨目录移动
- 目标父目录不存在时可自动创建
- 路径必须都位于根目录范围内

---

### 7.7 `master.fs.stat(slaveId, path, options?)`

获取远端文件或目录元信息。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `path` | `string` | 是 | 远端路径 |
| `options` | `object` | 否 | 附加参数 |

#### 返回值

`master.fs.stat()` 成功时直接返回远端 `meta` 对象，真实结构为：

- `{
    ok: true,
    op: "file/stat",
    path: string,
    size: number,
    mtime: number,
    isFile: boolean,
    isDirectory: boolean
  }`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/stat"` | 固定操作名 |
| `path` | `string` | 目标路径 |
| `size` | `number` | 文件或目录的 `stat.size` |
| `mtime` | `number` | `stat.mtimeMs` |
| `isFile` | `boolean` | 是否文件 |
| `isDirectory` | `boolean` | 是否目录 |

注意：

- 当前 `stat()` 的真实返回里**没有** `isSymbolicLink` 字段
- 如果你需要判断符号链接，请不要假设这个字段一定存在

适用场景：

- 文件详情查看
- 上传前覆盖判断
- UI 中展示文件属性

---

### 7.8 `master.fs.upload(slaveId, localPath, remotePath, options?)`

把本地文件上传到远端 `slave`。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `localPath` | `string` | 是 | 本地文件路径 |
| `remotePath` | `string` | 是 | 远端目标路径（支持目录语义） |
| `options` | `object` | 否 | 上传配置 |
| `options.chunkSize` | `number` | 否 | 分片大小 |
| `options.timeoutMs` | `number` | 否 | 单次 service 请求超时 |
| `options.onProgress` | `(event) => void` | 否 | 传输进度回调，按 `init/chunk/complete` 阶段触发 |

#### `remotePath` 路径语义

`upload()` 中的 `remotePath` 既可以表示“文件路径”，也可以表示“目录路径”：

1. 以 `/` 或 `\` 结尾时，按目录路径处理  
   最终目标会自动拼接 `basename(localPath)`。
   - 例如：`assets/` + `banner.txt` => `assets/banner.txt`

2. 为 `.` / `./` / `.\` 时，按 `fs root` 根目录处理  
   最终目标为 `basename(localPath)`。

3. 不带结尾斜杠，但远端该路径已存在且是目录时，仍按目录路径处理  
   最终目标会自动拼接 `basename(localPath)`。
   - 例如：`incoming` 已存在目录，上传 `upload.txt` => `incoming/upload.txt`

4. 其他情况按明确文件路径处理  
   可覆盖已有普通文件。

#### 返回值

`master.fs.upload()` 对外最终返回的是 **完成阶段** 的 `meta` 对象，不会把中间的 `resume/ack` 暴露给调用方作为最终返回值。

真实最终返回结构为：

- `{
    ok: true,
    op: "file/complete",
    sessionId: string,
    path: string
  }`

说明：

- 服务端在 `complete` 阶段内部还会构造一个对象，其中再次写入 `ok: true`
- 但因为对象展开顺序，最终对外可见结果仍然就是上面这个结构

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/complete"` | 固定操作名 |
| `sessionId` | `string` | 本次上传会话 ID |
| `path` | `string` | 远端目标路径 |

#### 传输过程中的内部返回（调用方通常拿不到）

1. 初始化阶段返回：

- `{
    ok: true,
    op: "file/resume",
    sessionId: string,
    path: string,
    offset: number,
    chunkSize: number
  }`

2. 每个分片的 ACK 返回：

- `{
    ok: true,
    op: "file/ack",
    sessionId: string,
    path: string,
    chunkId: number,
    offset: number,
    size: number
  }`

这些结构由 `upload()` 内部消费，用于断点续传和分片确认。

#### `onProgress(event)` 回调字段（upload）

`event` 常见字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `direction` | `"upload"` | 传输方向 |
| `phase` | `"init" \| "chunk" \| "complete"` | 进度阶段 |
| `slaveId` | `string` | 目标从节点 ID |
| `sessionId` | `string` | 会话 ID |
| `localPath` | `string` | 本地文件路径 |
| `remotePath` | `string` | 远端目标路径 |
| `transferred` | `number` | 已传输字节数 |
| `total` | `number` | 文件总字节数 |
| `percent` | `number` | 进度百分比（0~100） |
| `speedBps` | `number` | 当前估算传输速度（字节/秒） |
| `etaSeconds` | `number \| null` | 预计剩余秒数；无法估算时为 `null` |
| `totalChunks` | `number` | 总分片数 |
| `chunkId` | `number` | 当前分片 ID（`chunk` 阶段） |
| `size` | `number` | 当前分片字节数（`chunk` 阶段） |
| `meta` | `object` | 完成阶段返回元信息（`complete` 阶段） |

#### 特点

- 分片传输
- ACK 确认
- 支持断点续传
- 默认分片大小约为 `5MB`
- 内部有上下限保护
- 安全保护：不会把已有目录覆盖成文件（命中该情况会直接拒绝）

#### 适用场景

- 配置文件同步
- 远程分发资源
- 大文件上传

建议：

- 大文件可适度调大 `timeoutMs`
- 慢网络环境中可适度减小 `chunkSize`

---

### 7.9 `master.fs.download(slaveId, remotePath, localPath, options?)`

从远端 `slave` 下载文件到本地。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slaveId` | `string` | 是 | 目标从节点 |
| `remotePath` | `string` | 是 | 远端文件路径 |
| `localPath` | `string` | 是 | 本地目标路径 |
| `options` | `object` | 否 | 下载配置 |
| `options.chunkSize` | `number` | 否 | 分片大小 |
| `options.timeoutMs` | `number` | 否 | 单次 service 请求超时 |
| `options.onProgress` | `(event) => void` | 否 | 传输进度回调，按 `init/chunk/complete` 阶段触发 |

#### `onProgress(event)` 回调字段（download）

`event` 常见字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `direction` | `"download"` | 传输方向 |
| `phase` | `"init" \| "chunk" \| "complete"` | 进度阶段 |
| `slaveId` | `string` | 目标从节点 ID |
| `sessionId` | `string` | 会话 ID |
| `remotePath` | `string` | 远端源文件路径 |
| `localPath` | `string` | 本地目标路径 |
| `transferred` | `number` | 已传输字节数 |
| `total` | `number` | 文件总字节数 |
| `percent` | `number` | 进度百分比（0~100） |
| `speedBps` | `number` | 当前估算传输速度（字节/秒） |
| `etaSeconds` | `number \| null` | 预计剩余秒数；无法估算时为 `null` |
| `totalChunks` | `number` | 总分片数 |
| `chunkId` | `number` | 当前分片 ID（`chunk` 阶段） |
| `size` | `number` | 当前分片字节数（`chunk` 阶段） |
| `meta` | `object` | 完成阶段返回元信息（`complete` 阶段） |

#### 返回值

`master.fs.download()` 对外最终返回的是 **完成阶段** 的 `meta` 对象。

真实最终返回结构为：

- `{
    ok: true,
    op: "file/download_complete",
    sessionId: string,
    path: string
  }`

固定字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 成功时固定为 `true` |
| `op` | `"file/download_complete"` | 固定操作名 |
| `sessionId` | `string` | 本次下载会话 ID |
| `path` | `string` | 远端源文件路径 |

#### 传输过程中的内部返回（调用方通常拿不到）

1. 初始化阶段返回：

- `{
    ok: true,
    op: "file/download_init",
    sessionId: string,
    path: string,
    fileSize: number,
    offset: number,
    chunkSize: number
  }`

2. 每个分片返回：

- `{
    meta: {
      ok: true,
      op: "file/download_chunk",
      sessionId: string,
      path: string,
      chunkId: number,
      offset: number,
      size: number,
      eof: boolean
    },
    body: [Buffer]
  }`

其中：

- `body[0]` 就是当前分片内容
- 这些数据由 `download()` 内部写入本地 `.tmp` 文件
- 全部完成后再重命名为最终目标文件

#### 特点

- 分片传输
- 支持断点续传
- 本地先写入 `.tmp`
- 完成后再重命名为正式文件

建议：

- 大文件下载优先使用该方法，而不是 `get()`
- 下载完成前不要依赖目标正式文件存在

---

### 7.10 `fs` 使用建议

#### 小文件

优先：

- `get()`
- `stat()`
- `list()`

#### 文本修改

优先：

- `patch()`

#### 大文件

优先：

- `upload()`
- `download()`

#### 路径安全

务必注意：

- 所有远端路径都必须在 `slave.fs.setRoot()` 指定根目录内
- 任何试图越界的路径访问都应被视为非法请求
- 当前实现不仅拦截 `../` 形式的普通越界
- 也会拒绝通过 root 内部符号链接 / junction 间接访问 root 外部
- 因此如果目标路径的已有层级中包含符号链接，服务端会直接拒绝访问

#### 策略建议

如果你需要更严格的控制，建议显式配置 `policy`：

- 纯查看场景：`readOnly: true`
- 禁止远端删除：`allowDelete: false`
- 禁止远端 patch：`allowPatch: false`
- 禁止远端上传：`allowUpload: false`
- 只暴露指定目录：`allowedPaths: ["public/**"]`
- 屏蔽敏感文件：`denyGlobs: ["**/*.secret.txt", "private/**"]`

推荐思路：

- 根目录隔离负责“大范围边界”
- `allowedPaths` / `denyGlobs` 负责“细粒度收缩”
- 高风险场景优先启用 `readOnly`

#### 安全模式

当 `encrypted=true` 时：

- `fs` 同样要求双方密钥配置一致
- 与业务流一样受到签名、防重放和加密保护
- 但加密并不能替代路径策略与最小权限配置

---

## 8. 事件 API

通过 `node.on(eventName, handler)` 监听事件。

---

### 8.1 事件列表

| 事件名 | 触发方 | 说明 |
|--------|--------|------|
| `router` | `master` | ROUTER socket 收到原始帧 |
| `dealer` | `slave` | DEALER socket 收到原始帧 |
| `request` | 两者 | 解析出业务 RPC 请求 |
| `response` | 两者 | 解析出业务 RPC 响应 |
| `message` | 两者 | 所有解析后的统一消息事件 |
| `publish` | `slave` | 收到广播消息 |
| `push` | `master` | 收到从节点推送 |
| `slave_connected` | `master` | 从节点注册上线 |
| `slave_disconnected` | `master` | 从节点下线 |
| `auth_failed` | 两者 | 认证失败、解密失败、重放失败等 |
| `error` | 两者 | 内部错误 |

---

### 8.2 事件说明

#### `router`

仅 `master` 触发。

适用场景：

- 调试 ROUTER 收包
- 观察原始帧
- 协议对接排查

#### `dealer`

仅 `slave` 触发。

适用场景：

- 调试 DEALER 收包
- 排查主节点回包格式
- 安全模式联调

#### `request`

当收到合法业务 RPC 请求后触发。

注意：

- 这是业务 `req`
- 不等同于 `fs` 的 `svc_req`

#### `response`

当收到合法业务 RPC 响应后触发。

适用场景：

- 统一埋点
- 响应耗时统计
- 调试业务请求链路

#### `message`

统一消息事件。

适合：

- 做日志采集
- 做通用监控入口

#### `publish`

仅 `slave` 在收到主节点广播时触发。

常见字段：

- `topic`
- `payload`

#### `push`

仅 `master` 在收到从节点推送时触发。

常见字段：

- `identityText`
- `topic`
- `payload`

#### `slave_connected`

仅 `master`。

参数通常为：

- `slaveId`

触发时机：

- `slave` 注册成功
- 主节点确认其在线

#### `slave_disconnected`

仅 `master`。

触发场景：

- 收到注销
- 心跳/发送异常导致节点被判定下线
- 密钥移除导致节点失效

#### `auth_failed`

双方都可能触发。

常见原因：

- 签名错误
- 时间戳非法
- nonce 重放
- 解密失败
- payload 摘要校验失败

建议：

- 记录必要日志
- 不要把原始敏感密钥写入日志

#### `error`

内部异常事件。

建议：

- 始终监听
- 避免未处理错误导致进程崩溃

---

## 9. Payload 与返回值约定

### 9.1 支持的 payload 类型

ZNL 常见支持以下输入：

- `string`
- `Buffer`
- `Uint8Array`
- 以上类型的数组（多帧）

说明：

- `string` 通常会被编码为字节帧
- 多帧时会原样展开为多个 ZeroMQ 帧

### 9.2 返回值类型

#### 业务 RPC：`DEALER()` / `ROUTER()`

真实返回值就是对端响应 payload 本身：

- 单帧响应：`Buffer`
- 多帧响应：`Buffer[]`

不会额外包装为对象。

#### 内建文件服务：`master.fs.*`

真实返回值分两类：

1. **直接返回 `meta` 对象**
   - `master.fs.list()`
   - `master.fs.stat()`
   - `master.fs.delete()`
   - `master.fs.rename()`
   - `master.fs.patch()`
   - `master.fs.upload()`
   - `master.fs.download()`

2. **返回 `{ meta, body }`**
   - `master.fs.get()`

建议：

- 文本内容：使用 `toString("utf8")`
- JSON：手动 `JSON.parse(buffer.toString("utf8"))`
- 二进制：直接按 `Buffer` 处理

### 9.3 为什么有时是单帧，有时是多帧

因为底层就是多帧协议，公开 API 直接暴露了解析后的真实 payload 形态：

- 单帧 payload → 返回单个 `Buffer`
- 多帧 payload → 返回 `Buffer[]`
- `fs.get()` / `download` 分片场景则会显式区分 `meta` 与 `body`

如果你在业务层希望固定格式，建议你自己封装一层编解码器。

---

## 10. 使用建议与最佳实践

### 10.1 连接建立后再发首包

建议：

- `slave.start()` 后，不要立刻假设主链路可用
- 优先等待 `slave.isMasterOnline() === true`

### 10.2 业务 RPC 与文件服务分开使用

建议：

- 普通业务消息走 `DEALER/ROUTER`
- 文件类操作走 `master.fs.*`

不要：

- 用业务 RPC 传大文件
- 用 `get()` 拉超大文件全文

### 10.3 安全模式配置保持一致

当启用安全模式时：

- 双方 `encrypted` 必须一致
- 双方密钥配置必须可匹配
- `master` 与 `slave` 的 `enablePayloadDigest` 配置必须保持一致
- 高吞吐场景建议优先使用默认值 `false`
- 只有在你明确需要额外 payload 摘要校验时再开启 `true`

### 10.4 监听 `error` 和 `auth_failed`

生产环境建议至少监听：

- `error`
- `auth_failed`
- `slave_connected`
- `slave_disconnected`

### 10.5 为不同 slave 使用不同密钥

如果你是多租户或多节点场景，建议：

- 在 `master` 使用 `authKeyMap`
- 为不同 `slaveId` 分配不同密钥
- 做到最小权限隔离

---

## 11. 典型 API 选择建议

| 需求 | 推荐 API |
|------|----------|
| `slave -> master` 请求响应 | `slave.DEALER(payload, options?)` |
| `master -> slave` 请求响应 | `master.ROUTER(slaveId, payload, options?)` |
| `master` 处理从节点请求 | `master.ROUTER(handler)` |
| `slave` 处理主节点请求 | `slave.DEALER(handler)` |
| `master` 广播到所有从节点 | `master.PUBLISH(topic, payload)` |
| `slave` 订阅广播 | `slave.SUBSCRIBE(topic, handler)` |
| `slave` 取消订阅 | `slave.UNSUBSCRIBE(topic)` |
| `slave` 单向上报 | `slave.PUSH(topic, payload)` |
| 查看在线从节点 | `master.slaves` |
| 查看主节点在线状态 | `slave.masterOnline` / `slave.isMasterOnline()` |
| 远端目录列表 | `master.fs.list()` |
| 远端读小文件 | `master.fs.get()` |
| 远端文本 patch | `master.fs.patch()` |
| 远端删除 | `master.fs.delete()` |
| 远端重命名/移动 | `master.fs.rename()` |
| 远端查看元信息 | `master.fs.stat()` |
| 上传大文件 | `master.fs.upload()` |
| 下载大文件 | `master.fs.download()` |

---

## 12. 与协议文档的关系

本文件描述的是“你可以怎么用”。

如果你需要了解：

- ZeroMQ 实际帧结构
- `req/res` 与 `svc_req/svc_res` 的差异
- 明文模式与安全模式下的真实外层帧
- `fs` service payload 在协议上的承载方式

请继续阅读：

- `./README.protocol.md`

---

## 13. 文档导航

- 项目总览：`../README.md`
- 底层协议：`./README.protocol.md`

如果你希望快速看可运行写法，建议再配合示例文档一起阅读。