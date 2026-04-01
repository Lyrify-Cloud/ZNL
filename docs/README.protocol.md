# ZNL 底层帧协议说明

本文档单独说明 ZNL 在 ZeroMQ 之上定义的**真实底层控制帧协议**，用于：

- 协议对接
- 抓包分析
- 调试排障
- 自定义客户端/服务端实现参考

> 说明：
>
> 1. 本文档以当前代码实现为准。
> 2. 本文档优先描述**真实外层控制帧**。
> 3. `fs` 一节中的 JSON 结构，描述的是 **service payloadFrames 的语义内容**；在 `encrypted=true` 时，线上抓到的原始帧会先经过安全信封封装，不会直接看到明文 JSON。

---

## 1. 总体说明

### 1.1 ZeroMQ 收发外层

`master` 侧使用 `ROUTER`，实际收包形式为：

```text
[identity, ...controlFrames]
```

`slave` 侧使用 `DEALER`，实际收包形式为：

```text
[...controlFrames]
```

其中：

- `identity` 只存在于 `ROUTER` 侧
- `identity` 通常等于 `slave.id`
- 后续所有协议结构，默认描述的是 `controlFrames`

---

## 2. 协议常量

### 2.1 固定前缀

控制帧统一前缀：

```text
__znl_v1__
```

认证标记：

```text
__znl_v1_auth__
```

### 2.2 控制类型

| 常量 | 实际值 | 说明 |
|------|--------|------|
| `CONTROL_REGISTER` | `register` | slave 注册 |
| `CONTROL_UNREGISTER` | `unregister` | slave 注销 |
| `CONTROL_HEARTBEAT` | `heartbeat` | 心跳请求 |
| `CONTROL_HEARTBEAT_ACK` | `heartbeat_ack` | 心跳应答 |
| `CONTROL_REQ` | `req` | 业务 RPC 请求 |
| `CONTROL_RES` | `res` | 业务 RPC 响应 |
| `CONTROL_PUB` | `pub` | 广播 |
| `CONTROL_PUSH` | `push` | 单向推送 |
| `CONTROL_SVC_REQ` | `svc_req` | 内建 service 请求 |
| `CONTROL_SVC_RES` | `svc_res` | 内建 service 响应 |

---

## 3. 协议分类

ZNL 当前底层协议可以分为 4 类：

1. **生命周期控制**
   - `register`
   - `unregister`

2. **链路保活**
   - `heartbeat`
   - `heartbeat_ack`

3. **业务通信**
   - `req`
   - `res`
   - `pub`
   - `push`

4. **内建服务通道**
   - `svc_req`
   - `svc_res`

其中：

- 业务 RPC 走 `req/res`
- 内建 `fs` 不走业务 RPC，而走 `svc_req/svc_res`

---

## 4. 明文模式下的真实控制帧

以下是 **`encrypted=false`** 时的真实控制帧结构。

### 4.1 注册帧

方向：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "register"]
```

---

### 4.2 注销帧

方向：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "unregister"]
```

---

### 4.3 心跳帧

方向：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "heartbeat"]
```

---

### 4.4 心跳应答帧

方向：

```text
master -> slave
```

结构：

```text
[__znl_v1__, "heartbeat_ack"]
```

---

### 4.5 业务 RPC 请求帧

方向：

```text
slave -> master
```

或：

```text
master -> slave
```

结构：

```text
[__znl_v1__, "req", requestId, ...payloadFrames]
```

其中：

- `requestId` 是字符串 UUID
- `payloadFrames` 为 1 个或多个帧
- 单帧 payload 直接就是一个帧
- 多帧 payload 会被原样展开

---

### 4.6 业务 RPC 响应帧

方向：

```text
master -> slave
```

或：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "res", requestId, ...payloadFrames]
```

---

### 4.7 广播帧

方向：

```text
master -> slave
```

结构：

```text
[__znl_v1__, "pub", topic, ...payloadFrames]
```

其中：

- `topic` 为字符串
- `payloadFrames` 为广播数据帧

---

### 4.8 PUSH 帧

方向：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "push", topic, ...payloadFrames]
```

---

### 4.9 service 请求帧

方向：

```text
master -> slave
```

结构：

```text
[__znl_v1__, "svc_req", requestId, service, ...payloadFrames]
```

其中：

- `requestId` 是 service 通道自己的请求 ID
- `service` 当前主要为 `fs`

---

### 4.10 service 响应帧

方向：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "svc_res", requestId, service, ...payloadFrames]
```

---

## 5. 安全模式下的真实控制帧

以下是 **`encrypted=true`** 时的真实控制帧结构。

> 注意：
>
> - 安全模式包含签名校验、防重放、时间戳校验
> - `request/response/publish/push/service_request/service_response` 的 payload 在启用透明加密时，会变成**安全信封**
> - 某些代码内部参数命名沿用了 `authKey` 旧名，但语义上这里承载的是 `authProof`

---

### 5.1 注册帧

方向：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "register", __znl_v1_auth__, authProof]
```

---

### 5.2 心跳帧

方向：

```text
slave -> master
```

结构：

```text
[__znl_v1__, "heartbeat", __znl_v1_auth__, authProof]
```

---

### 5.3 心跳应答帧

方向：

```text
master -> slave
```

结构：

```text
[__znl_v1__, "heartbeat_ack", __znl_v1_auth__, authProof]
```

---

### 5.4 业务 RPC 请求帧

结构：

```text
[__znl_v1__, "req", requestId, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

### 5.5 业务 RPC 响应帧

结构：

```text
[__znl_v1__, "res", requestId, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

### 5.6 广播帧

结构：

```text
[__znl_v1__, "pub", topic, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

### 5.7 PUSH 帧

结构：

```text
[__znl_v1__, "push", topic, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

### 5.8 service 请求帧

结构：

```text
[__znl_v1__, "svc_req", requestId, service, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

### 5.9 service 响应帧

结构：

```text
[__znl_v1__, "svc_res", requestId, service, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

## 6. 安全信封（encrypted payload）

当启用透明加密后，`payloadFrames` 不再是原始业务帧，而是被包装成固定 4 帧结构：

```text
[SECURITY_ENVELOPE_VERSION, iv, tag, ciphertext]
```

当前版本标记：

```text
__znl_sec_v1__
```

也就是说，像下面这种业务请求：

```text
[__znl_v1__, "req", requestId, __znl_v1_auth__, authProof, ...payloadFrames]
```

在加密模式下，实际更接近：

```text
[
  __znl_v1__,
  "req",
  requestId,
  __znl_v1_auth__,
  authProof,
  "__znl_sec_v1__",
  iv,
  tag,
  ciphertext
]
```

service 通道同理。

---

## 7. ROUTER / DEALER 真实外层示意

### 7.1 master 侧 ROUTER 发起业务请求

```text
[identity, __znl_v1__, "req", requestId, ...payloadFrames]
```

安全模式：

```text
[identity, __znl_v1__, "req", requestId, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

### 7.2 master 侧 ROUTER 发起 service 请求

```text
[identity, __znl_v1__, "svc_req", requestId, service, ...payloadFrames]
```

安全模式：

```text
[identity, __znl_v1__, "svc_req", requestId, service, __znl_v1_auth__, authProof, ...payloadFrames]
```

---

### 7.3 slave 侧 DEALER 回复业务响应

```text
[__znl_v1__, "res", requestId, ...payloadFrames]
```

---

### 7.4 slave 侧 DEALER 回复 service 响应

```text
[__znl_v1__, "svc_res", requestId, service, ...payloadFrames]
```

---

## 8. 解析结果字段

`parseControlFrames()` 当前会提取这些字段：

- `kind`
- `requestId`
- `authKey`
- `authProof`
- `topic`
- `service`
- `payloadFrames`

### 8.1 `kind` 可能值

- `register`
- `unregister`
- `heartbeat`
- `heartbeat_ack`
- `publish`
- `push`
- `request`
- `response`
- `service_request`
- `service_response`
- `message`

### 8.2 注意事项

- `register` / `request` 的认证字段在部分历史代码路径里仍使用 `authKey` 字段名承载 proof
- `response` / `publish` / `push` / `service_*` 则使用 `authProof`
- 从协议语义上讲，这些都应理解为“认证证明”

---

## 9. payload 帧规范

### 9.1 普通业务 payload

对于普通业务 `DEALER()` / `ROUTER()` / `PUBLISH()` / `PUSH()`：

- 单帧 payload：
  - `string`
  - `Buffer`
  - `Uint8Array`
- 多帧 payload：
  - 上述类型组成的数组

### 9.2 空值规范

- `null`
- `undefined`

会被规范化为空 `Buffer`

---

## 10. service 通道说明

service 通道用于承载**不应与业务 RPC 串流的内部能力**。

当前内建：

- `fs`

设计目标：

- `svc_req/svc_res` 与业务 `req/res` 完全分流
- `master.fs.*` 不进入业务 `request/response` 自动处理器
- `slave.fs.setRoot()` 注册的是内部 service handler
- service 通道同样参与安全校验与透明加密

---

## 11. fs service 的 payload 语义

> 注意：
>
> 本节描述的是 **service payloadFrames 内部语义**，不是完整外层控制帧。
>
> 真实完整外层帧应为：
>
> - 明文模式：
>   - `[__znl_v1__, "svc_req", requestId, "fs", ...payloadFrames]`
> - 安全模式：
>   - `[__znl_v1__, "svc_req", requestId, "fs", __znl_v1_auth__, authProof, ...payloadFrames]`

### 11.1 payloadFrames 结构

`fs` service 的 payloadFrames 约定为：

- 第 1 帧：JSON meta
- 第 2+ 帧：可选二进制 body

也就是说：

```text
payloadFrames = [metaFrame, ...bodyFrames]
```

其中：

- `metaFrame = Buffer.from(JSON.stringify(meta), "utf8")`
- `bodyFrames` 常用于：
  - 上传 chunk 数据
  - 下载 chunk 数据
  - 文件内容返回

---

## 12. fs 常见操作类型

- `file/list`
- `file/get`
- `file/patch`
- `file/delete`
- `file/rename`
- `file/stat`
- `file/init`
- `file/resume`
- `file/chunk`
- `file/ack`
- `file/complete`
- `file/download_init`
- `file/download_chunk`
- `file/download_complete`

---

## 13. fs payload 示例（语义层）

以下示例仅表示 `payloadFrames` 解码后的语义，不包含外层 `svc_req/svc_res` 包装。

### 13.1 list

请求 meta：

```json
{
  "service": "fs",
  "op": "file/list",
  "path": "."
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/list",
  "path": ".",
  "entries": [
    {
      "name": "hello.txt",
      "type": "file",
      "size": 12,
      "mtime": 1700000000000,
      "isFile": true,
      "isDirectory": false,
      "isSymbolicLink": false
    }
  ]
}
```

---

### 13.2 get

请求 meta：

```json
{
  "service": "fs",
  "op": "file/get",
  "path": "hello.txt"
}
```

响应：

- `metaFrame`

```json
{
  "ok": true,
  "op": "file/get",
  "path": "hello.txt",
  "size": 12
}
```

- `bodyFrames[0]`

```text
<Buffer ...file content...>
```

---

### 13.3 patch

请求 meta：

```json
{
  "service": "fs",
  "op": "file/patch",
  "path": "hello.txt",
  "patch": "@@ -1,2 +1,2 @@ ..."
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/patch",
  "path": "hello.txt",
  "applied": true
}
```

---

### 13.4 rename

请求 meta：

```json
{
  "service": "fs",
  "op": "file/rename",
  "from": "a.txt",
  "to": "b.txt"
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/rename",
  "from": "a.txt",
  "to": "b.txt"
}
```

---

### 13.5 stat

请求 meta：

```json
{
  "service": "fs",
  "op": "file/stat",
  "path": "hello.txt"
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/stat",
  "path": "hello.txt",
  "size": 12,
  "mtime": 1700000000000,
  "isFile": true,
  "isDirectory": false
}
```

---

### 13.6 delete

请求 meta：

```json
{
  "service": "fs",
  "op": "file/delete",
  "path": "hello.txt"
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/delete",
  "path": "hello.txt"
}
```

---

### 13.7 upload 初始化

请求 meta：

```json
{
  "service": "fs",
  "op": "file/init",
  "sessionId": "s1",
  "path": "remote/upload.txt",
  "fileName": "upload.txt",
  "fileSize": 10485760,
  "chunkSize": 5242880
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/resume",
  "sessionId": "s1",
  "path": "remote/upload.txt",
  "offset": 0,
  "chunkSize": 5242880
}
```

---

### 13.8 upload 分片

请求：

- `metaFrame`

```json
{
  "service": "fs",
  "op": "file/chunk",
  "sessionId": "s1",
  "path": "remote/upload.txt",
  "chunkId": 0,
  "totalChunks": 2,
  "offset": 0,
  "size": 5242880
}
```

- `bodyFrames[0]`

```text
<Buffer ...chunk bytes...>
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/ack",
  "sessionId": "s1",
  "path": "remote/upload.txt",
  "chunkId": 0,
  "offset": 5242880,
  "size": 5242880
}
```

---

### 13.9 upload 完成

请求 meta：

```json
{
  "service": "fs",
  "op": "file/complete",
  "sessionId": "s1",
  "path": "remote/upload.txt",
  "fileName": "upload.txt",
  "fileSize": 10485760,
  "totalChunks": 2
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/complete",
  "sessionId": "s1",
  "path": "remote/upload.txt"
}
```

---

### 13.10 download 初始化

请求 meta：

```json
{
  "service": "fs",
  "op": "file/download_init",
  "sessionId": "d1",
  "path": "remote/upload.txt",
  "chunkSize": 5242880,
  "offset": 0
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/download_init",
  "sessionId": "d1",
  "path": "remote/upload.txt",
  "fileSize": 10485760,
  "offset": 0,
  "chunkSize": 5242880
}
```

---

### 13.11 download 分片

请求 meta：

```json
{
  "service": "fs",
  "op": "file/download_chunk",
  "sessionId": "d1",
  "path": "remote/upload.txt",
  "chunkId": 0,
  "offset": 0,
  "chunkSize": 5242880,
  "totalChunks": 2
}
```

响应：

- `metaFrame`

```json
{
  "ok": true,
  "op": "file/download_chunk",
  "sessionId": "d1",
  "path": "remote/upload.txt",
  "chunkId": 0,
  "offset": 0,
  "size": 5242880,
  "eof": false
}
```

- `bodyFrames[0]`

```text
<Buffer ...chunk bytes...>
```

---

### 13.12 download 完成

请求 meta：

```json
{
  "service": "fs",
  "op": "file/download_complete",
  "sessionId": "d1",
  "path": "remote/upload.txt",
  "fileSize": 10485760,
  "totalChunks": 2
}
```

响应 meta：

```json
{
  "ok": true,
  "op": "file/download_complete",
  "sessionId": "d1",
  "path": "remote/upload.txt"
}
```

---

## 14. 调试建议

如果你抓包或打印事件帧，建议先确认 3 层：

### 第一层：ZeroMQ 外层
看是否有 `identity`。

### 第二层：ZNL 控制帧
看是否是：

- `req/res`
- `pub/push`
- `svc_req/svc_res`

### 第三层：payload 内容
如果是明文模式，可以直接看 `payloadFrames`。  
如果是安全模式，需要先经过验签与解密，才能还原出业务层 payload。

---

## 15. 与主 README 的关系

主 README 只保留：

- API 使用
- 快速开始
- 文件服务概览

本文件专门负责：

- 底层协议
- 帧结构
- 明文/加密模式差异
- service / fs payload 语义

如果你要做联调、抓包或实现兼容端，请优先以本文件为准。