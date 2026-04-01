# ZNL 使用示例与实践指南

本文档专注于 **“怎么用”**：

- 如何快速启动 `master / slave`
- 如何使用双向 RPC
- 如何使用广播、订阅、推送
- 如何在安全模式下工作
- 如何启用并使用内建 `fs` 文件服务
- 如何组织实际项目代码

如果你想看：

- API 参考：`docs/README.api.md`
- 底层协议：`docs/README.protocol.md`

---

## 1. 最小可运行示例

下面是一个最基础的 `master / slave` 通信示例。

### 1.1 Master

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
  console.log(`[MASTER] 收到 ${identityText} 的请求：${text}`);
  return `master reply: ${text}`;
});

master.on("slave_connected", (slaveId) => {
  console.log(`[MASTER] slave 上线：${slaveId}`);
});

master.on("slave_disconnected", (slaveId) => {
  console.log(`[MASTER] slave 下线：${slaveId}`);
});

await master.start();
console.log("[MASTER] started");
```

### 1.2 Slave

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
console.log("[SLAVE] started");

if (slave.isMasterOnline()) {
  const reply = await slave.DEALER("hello from slave");
  console.log("[SLAVE] reply =", reply.toString("utf8"));
}
```

---

## 2. 推荐的启动方式

虽然 `await slave.start()` 返回后连接通常已经开始建立，但在生产代码中，更推荐先等待链路可用，再发送首个业务请求。

```js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitMasterOnline(slave, timeoutMs = 5000) {
  const start = Date.now();

  while (!slave.isMasterOnline()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("master 未在预期时间内上线");
    }
    await sleep(100);
  }
}

await slave.start();
await waitMasterOnline(slave);

const reply = await slave.DEALER("hello");
console.log(reply.toString("utf8"));
```

适用场景：

- 程序启动后立刻发送第一条 RPC
- 安全模式下首次握手
- 对首条消息可靠性要求较高的场景

---

## 3. 双向 RPC 示例

ZNL 的 RPC 是双向的：

- `slave -> master`：`slave.DEALER(payload)`
- `master -> slave`：`master.ROUTER(slaveId, payload)`

同时，两边都可以注册“自动回复处理器”。

---

## 4. Slave 主动请求 Master

这是最常见的模式。

### 4.1 Master 注册处理器

```js
import { ZNL } from "@lyrify/znl";

const master = new ZNL({
  role: "master",
  id: "master-1",
});

master.ROUTER(async ({ identityText, payload }) => {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);

  if (text === "ping") {
    return "pong";
  }

  return `echo from master to ${identityText}: ${text}`;
});

await master.start();
```

### 4.2 Slave 发起请求

```js
import { ZNL } from "@lyrify/znl";

const slave = new ZNL({
  role: "slave",
  id: "slave-001",
});

await slave.start();

const reply1 = await slave.DEALER("ping");
console.log(reply1.toString("utf8")); // pong

const reply2 = await slave.DEALER("hello master", {
  timeoutMs: 4000,
});
console.log(reply2.toString("utf8"));
```

---

## 5. Master 主动请求 Slave

如果你希望 `master` 主动把某项工作下发到指定节点，可以让 `slave` 注册自己的处理器。

### 5.1 Slave 注册处理器

```js
import { ZNL } from "@lyrify/znl";

const slave = new ZNL({
  role: "slave",
  id: "slave-001",
});

slave.DEALER(async ({ payload }) => {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);

  if (text === "who-are-you") {
    return JSON.stringify({
      id: "slave-001",
      role: "worker",
      time: Date.now(),
    });
  }

  return `slave handled: ${text}`;
});

await slave.start();
```

### 5.2 Master 发起请求

```js
import { ZNL } from "@lyrify/znl";

const master = new ZNL({
  role: "master",
  id: "master-1",
});

await master.start();

const reply = await master.ROUTER("slave-001", "who-are-you", {
  timeoutMs: 5000,
});

console.log(reply.toString("utf8"));
```

适用场景：

- 主控调度任务到某个 slave
- 获取某个节点状态
- 远程执行命令型操作

---

## 6. 传输 JSON 的推荐方式

ZNL 传输的底层是帧，业务层最简单稳定的方式仍然是自行 `JSON.stringify()` / `JSON.parse()`。

### 6.1 发送 JSON

```js
const payload = JSON.stringify({
  action: "create-job",
  jobId: "job-1001",
  params: {
    retry: 3,
    priority: "high",
  },
});

const reply = await slave.DEALER(payload);
```

### 6.2 接收 JSON

```js
master.ROUTER(async ({ payload }) => {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
  const data = JSON.parse(text);

  if (data.action === "create-job") {
    return JSON.stringify({
      ok: true,
      accepted: true,
      jobId: data.jobId,
    });
  }

  return JSON.stringify({
    ok: false,
    message: "unknown action",
  });
});
```

---

## 7. 传输二进制数据

如果你要传输的是文件片段、图片、压缩包、签名块等二进制内容，可以直接发送 `Buffer`。

### 7.1 Slave 发送 Buffer

```js
import fs from "node:fs/promises";

const imageBuffer = await fs.readFile("./avatar.png");
const reply = await slave.DEALER(imageBuffer);
```

### 7.2 Master 处理 Buffer

```js
master.ROUTER(async ({ payload }) => {
  if (Buffer.isBuffer(payload)) {
    console.log("收到二进制数据，长度 =", payload.length);
    return Buffer.from("ok");
  }

  return Buffer.from("unsupported");
});
```

---

## 8. 多帧 payload 示例

ZNL 支持单帧和多帧 payload。多帧适合：

- 元信息 + 二进制正文
- 多段数据分开发送
- 降低你自己手动拼包的复杂度

### 8.1 Slave 发送多帧

```js
const reply = await slave.DEALER([
  Buffer.from(JSON.stringify({ filename: "hello.txt" }), "utf8"),
  Buffer.from("file-body-content", "utf8"),
]);
```

### 8.2 Master 处理多帧

```js
master.ROUTER(async ({ payload }) => {
  const frames = Array.isArray(payload) ? payload : [payload];
  const meta = JSON.parse(frames[0].toString("utf8"));
  const body = frames[1];

  console.log("filename =", meta.filename);
  console.log("body size =", body.length);

  return Buffer.from("received");
});
```

---

## 9. 广播 `PUBLISH`

广播适合：

- 配置刷新
- 系统通知
- 全局状态同步
- 主控下发公告类消息

### 9.1 Master 广播

```js
master.PUBLISH("news", "breaking news!");
master.PUBLISH("system", JSON.stringify({
  type: "maintenance",
  startAt: Date.now() + 60000,
}));
```

### 9.2 Slave 订阅指定 topic

```js
slave.SUBSCRIBE("news", ({ topic, payload }) => {
  console.log(`[SUBSCRIBE] topic=${topic} payload=${payload.toString("utf8")}`);
});
```

### 9.3 监听所有广播

```js
slave.on("publish", ({ topic, payload }) => {
  console.log(`[PUBLISH EVENT] topic=${topic} payload=${payload.toString("utf8")}`);
});
```

### 9.4 链式订阅

```js
slave
  .SUBSCRIBE("news", ({ payload }) => {
    console.log("news =", payload.toString("utf8"));
  })
  .SUBSCRIBE("metrics", ({ payload }) => {
    console.log("metrics =", payload.toString("utf8"));
  });
```

### 9.5 取消订阅

```js
slave.UNSUBSCRIBE("news");
```

---

## 10. Slave 单向推送 `PUSH`

`PUSH` 适合从 slave 向 master 上报事件，不需要等待结果：

- 指标
- 告警
- 状态变化
- 日志摘要

### 10.1 Slave 推送

```js
slave.PUSH("metrics", JSON.stringify({
  cpu: 0.42,
  memory: 0.73,
  time: Date.now(),
}));
```

### 10.2 Master 监听推送

```js
master.on("push", ({ identityText, topic, payload }) => {
  console.log(`[PUSH] from=${identityText} topic=${topic}`);
  console.log(payload.toString("utf8"));
});
```

---

## 11. 在线状态与节点列表

### 11.1 Master 查看在线节点

```js
console.log(master.slaves);
```

你也可以监听节点上线下线事件：

```js
master.on("slave_connected", (slaveId) => {
  console.log("上线：", slaveId);
});

master.on("slave_disconnected", (slaveId) => {
  console.log("下线：", slaveId);
});
```

### 11.2 Slave 判断主节点是否在线

```js
console.log(slave.masterOnline);

if (slave.isMasterOnline()) {
  console.log("master 当前可用");
}
```

注意：

- 这是最近一次链路确认结果
- 它适合作为业务判断依据
- 它不是一次即时网络探测

---

## 12. 超时控制示例

无论是 `slave -> master` 还是 `master -> slave` 的 RPC，都建议显式设置超时。

### 12.1 Slave 侧超时

```js
const reply = await slave.DEALER("heavy-task", {
  timeoutMs: 8000,
});
```

### 12.2 Master 侧超时

```js
const reply = await master.ROUTER("slave-001", "collect-status", {
  timeoutMs: 8000,
});
```

建议：

- 普通控制类命令：`3000 ~ 5000ms`
- 轻量业务 RPC：`5000 ~ 10000ms`
- 复杂远程计算：根据任务长度单独设计

---

## 13. 安全模式示例

当你需要：

- 身份校验
- 防重放
- 透明加密
- payload 完整性保护

可以启用 `encrypted: true`。

### 13.1 使用共享密钥

#### Master

```js
const master = new ZNL({
  role: "master",
  id: "master-1",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: true,
});
```

#### Slave

```js
const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: true,
});
```

### 13.2 Master 按 slaveId 配置不同密钥

```js
const master = new ZNL({
  role: "master",
  id: "master-1",
  encrypted: true,
  authKeyMap: {
    "slave-001": "key-001",
    "slave-002": "key-002",
  },
});
```

```js
const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  encrypted: true,
  authKey: "key-001",
});
```

### 13.3 动态更新密钥

```js
master.addAuthKey("slave-003", "key-003");
master.removeAuthKey("slave-003");
```

建议：

- `master` 与 `slave` 的 `encrypted` 配置保持一致
- `master` 与 `slave` 的 `enablePayloadDigest` 配置保持一致
- 高吞吐场景建议优先使用默认值 `enablePayloadDigest: false`
- 只有在你明确需要额外 payload 摘要校验时，再显式开启 `enablePayloadDigest: true`
- 不要把真实密钥直接提交到公开仓库

---

## 14. 内建文件服务 `fs`

ZNL 内建了独立的文件服务通道：

- 走内部 `service` 通道
- 不占用业务 `req / res`
- 在 `encrypted=true` 下也能工作
- 支持 `CRUD + upload/download`

---

## 15. 启用文件服务

文件服务只需要在 `slave` 上设置一个根目录。

### 15.1 Slave 启用 `fs`

```js
import { ZNL } from "@lyrify/znl";

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
  allowedPaths: [
    "public/**",
    "configs/**",
  ],
  denyGlobs: [
    "**/*.secret.txt",
    "private/**",
  ],
});

await slave.start();
```

说明：

- `setRoot(rootPath, policy?)` 的第一个参数仍然是根目录
- `policy` 为可选策略对象，用于限制远程文件能力
- 所有远程路径都只能落在这个根目录下面
- 任何包含符号链接 / junction 的访问路径都会被拒绝
- 越权路径会被拒绝
- `allowedPaths` 与 `denyGlobs` 都按 `/` 风格路径匹配
- `allowedPaths` 为空时表示不额外限制路径范围
- `denyGlobs` 命中后会直接拒绝访问

常用策略字段：

- `readOnly: true`
  - 进入只读模式
  - 会拒绝 `patch / rename / delete / upload`
- `allowDelete: false`
  - 禁止远端删除
- `allowPatch: false`
  - 禁止远端 patch 文本文件
- `allowUpload: false`
  - 禁止远端上传
- `allowedPaths: [...]`
  - 路径白名单
- `denyGlobs: [...]`
  - 路径黑名单

一个更保守的只读示例：

```js
slave.fs.setRoot("./storage", {
  readOnly: true,
  allowedPaths: [
    "public/**",
    "docs/**",
  ],
  denyGlobs: [
    "**/*.key",
    "**/*.pem",
    "**/*.secret.*",
  ],
});
```

---

## 16. 列出远端目录

```js
const list = await master.fs.list("slave-001", ".");
console.log(list);
```

常见返回结构：

```js
{
  ok: true,
  op: "file/list",
  path: ".",
  entries: [
    {
      name: "hello.txt",
      type: "file",
      size: 12,
      mtime: 1700000000000,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    },
  ],
}
```

### 16.1 列子目录

```js
const list = await master.fs.list("slave-001", "logs");
console.log(list.entries.map((item) => item.name));
```

---

## 17. 读取远端文件

```js
const result = await master.fs.get("slave-001", "hello.txt");
const body = result.body?.[0];

if (Buffer.isBuffer(body)) {
  console.log(body.toString("utf8"));
}
```

适用场景：

- 小文本文件
- 小型配置文件
- 模板、JSON、状态快照

不建议：

- 直接用 `get()` 拉很大的文件  
- 大文件请使用 `download()`

---

## 18. 获取远端文件状态

```js
const stat = await master.fs.stat("slave-001", "hello.txt");

console.log({
  size: stat.size,
  mtime: stat.mtime,
  isFile: stat.isFile,
  isDirectory: stat.isDirectory,
});
```

适用场景：

- 下载前做文件检查
- 判断路径是文件还是目录
- 构建同步逻辑

---

## 19. 删除远端文件或目录

```js
await master.fs.delete("slave-001", "old.txt");
await master.fs.delete("slave-001", "old-dir");
```

说明：

- 文件、目录使用同一接口
- 目录支持递归删除
- 删除前建议先 `stat()`

---

## 20. 重命名或移动远端文件

```js
await master.fs.rename(
  "slave-001",
  "logs/app.log",
  "archive/app-2025-01.log",
);
```

说明：

- `from` 和 `to` 都必须位于 `root` 范围内
- 目标父目录不存在时会自动创建

---

## 21. 对远端文本文件做 patch

`patch()` 适合修改文本文件，而不是整个覆盖。

### 21.1 生成 patch

```js
import { createTwoFilesPatch } from "diff";

const original = "hello\nworld\n";
const updated = "hello\nznl\n";

const patch = createTwoFilesPatch(
  "hello.txt",
  "hello.txt",
  original,
  updated,
);
```

### 21.2 应用 patch

```js
const result = await master.fs.patch(
  "slave-001",
  "hello.txt",
  patch,
);

console.log(result.applied);
```

适用场景：

- 远程修改配置文件
- 热修复小型文本内容
- 以差异形式审计变更

注意：

- 仅适合文本文件
- patch 不能正确应用时，结果会返回 `applied: false`

---

## 22. 上传文件到远端

### 22.1 最简单上传

```js
await master.fs.upload(
  "slave-001",
  "./local/upload.txt",
  "remote/upload.txt",
);
```

### 22.2 指定分片大小和超时

```js
await master.fs.upload(
  "slave-001",
  "./local/big-file.zip",
  "packages/big-file.zip",
  {
    chunkSize: 1024 * 1024,
    timeoutMs: 5000,
  },
);
```

说明：

- 默认分片大小为 `5MB`
- 传输过程中带 ACK
- 支持断点续传
- 适合大文件

推荐：

- 小文件可以 `get()/patch()`
- 大文件统一用 `upload()`

---

## 23. 从远端下载文件

### 23.1 最简单下载

```js
await master.fs.download(
  "slave-001",
  "remote/upload.txt",
  "./local/download.txt",
);
```

### 23.2 指定参数

```js
await master.fs.download(
  "slave-001",
  "packages/big-file.zip",
  "./downloads/big-file.zip",
  {
    chunkSize: 1024 * 1024,
    timeoutMs: 5000,
  },
);
```

说明：

- 支持分片传输
- 支持断点续传
- 本地先写 `.tmp` 文件
- 完整后再重命名到目标文件

这可以降低下载中断时目标文件损坏的风险。

---

## 24. 一个完整的文件服务场景

下面演示一个常见流程：

1. `slave` 暴露 `./storage`
2. `master` 列目录
3. 读取配置
4. patch 修改
5. 上传新文件
6. 下载备份

### 24.1 Slave

```js
import { ZNL } from "@lyrify/znl";

const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
});

slave.fs.setRoot("./storage", {
  allowDelete: false,
  allowPatch: true,
  allowUpload: true,
  allowedPaths: [
    "config/**",
    "assets/**",
    "logs/**",
  ],
  denyGlobs: [
    "**/*.bak",
    "**/*.secret.txt",
  ],
});

await slave.start();

console.log("slave fs ready");
```

### 24.2 Master

```js
import { ZNL } from "@lyrify/znl";
import { createTwoFilesPatch } from "diff";

const master = new ZNL({
  role: "master",
  id: "master-1",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
});

await master.start();

const slaveId = "slave-001";

// 1. 列目录
const list = await master.fs.list(slaveId, ".");
console.log("entries =", list.entries.map((item) => item.name));

// 2. 读配置
const configFile = await master.fs.get(slaveId, "config/app.conf");
const configText = configFile.body?.[0]?.toString("utf8") ?? "";
console.log("before =", configText);

// 3. patch 修改
const nextConfigText = configText.replace("port=3000", "port=3001");
const diffText = createTwoFilesPatch(
  "config/app.conf",
  "config/app.conf",
  configText,
  nextConfigText,
);

const patchResult = await master.fs.patch(
  slaveId,
  "config/app.conf",
  diffText,
);

console.log("patch applied =", patchResult.applied);

// 4. 上传新资源
await master.fs.upload(
  slaveId,
  "./local/banner.txt",
  "assets/banner.txt",
);

// 5. 下载日志备份
await master.fs.download(
  slaveId,
  "logs/app.log",
  "./backup/app.log",
);
```

---

## 25. 安全模式下使用 `fs`

`fs` 服务与普通业务通道一样，也能跑在安全模式中。

### 25.1 Master

```js
const master = new ZNL({
  role: "master",
  id: "master-1",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: true,
});
```

### 25.2 Slave

```js
const slave = new ZNL({
  role: "slave",
  id: "slave-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: true,
});

slave.fs.setRoot("./storage", {
  readOnly: true,
  allowedPaths: [
    "public/**",
    "release/**",
  ],
  denyGlobs: [
    "**/*.pem",
    "**/*.key",
    "**/*.secret.*",
    "private/**",
  ],
});

await slave.start();
```

### 25.3 访问 `fs`

```js
const textFile = await master.fs.get("slave-001", "hello.txt");
console.log(textFile.body?.[0]?.toString("utf8"));

await master.fs.upload(
  "slave-001",
  "./local/data.txt",
  "data/data.txt",
);

await master.fs.download(
  "slave-001",
  "data/data.txt",
  "./downloaded/data.txt",
);
```

---

## 26. 事件监听示例

你可以用事件来做调试、审计和日志记录。

### 26.1 通用错误监听

```js
master.on("error", (err) => {
  console.error("[MASTER ERROR]", err);
});

slave.on("error", (err) => {
  console.error("[SLAVE ERROR]", err);
});
```

### 26.2 认证失败监听

```js
master.on("auth_failed", (info) => {
  console.warn("[MASTER AUTH FAILED]", info);
});

slave.on("auth_failed", (info) => {
  console.warn("[SLAVE AUTH FAILED]", info);
});
```

### 26.3 原始收包事件

```js
master.on("router", (frames) => {
  console.log("[MASTER ROUTER RAW]", frames);
});

slave.on("dealer", (frames) => {
  console.log("[SLAVE DEALER RAW]", frames);
});
```

适用场景：

- 排查帧结构问题
- 调试协议
- 观察加密前后行为差异

---

## 27. 实战中的推荐组织方式

如果你的项目中既有业务 RPC，又有文件服务，建议按职责拆分代码。

### 27.1 `master.js`

```js
import { ZNL } from "@lyrify/znl";

export async function createMaster() {
  const master = new ZNL({
    role: "master",
    id: "master-1",
    endpoints: {
      router: "tcp://127.0.0.1:6003",
    },
    encrypted: true,
    authKey: "your-shared-key",
  });

  master.on("slave_connected", (slaveId) => {
    console.log("slave connected:", slaveId);
  });

  master.on("push", ({ identityText, topic, payload }) => {
    console.log("push:", identityText, topic, payload.toString("utf8"));
  });

  master.ROUTER(async ({ identityText, payload }) => {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
    return `master handled for ${identityText}: ${text}`;
  });

  await master.start();
  return master;
}
```

### 27.2 `slave.js`

```js
import { ZNL } from "@lyrify/znl";

export async function createSlave(id) {
  const slave = new ZNL({
    role: "slave",
    id,
    endpoints: {
      router: "tcp://127.0.0.1:6003",
    },
    encrypted: true,
    authKey: "your-shared-key",
  });

  slave.fs.setRoot("./storage");

  slave.DEALER(async ({ payload }) => {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
    return `slave ${id} handled: ${text}`;
  });

  await slave.start();
  return slave;
}
```

这样组织的好处：

- 业务通信逻辑清晰
- 文件服务配置集中
- 测试和上线都更容易维护

---

## 28. 常见使用建议

### 28.1 什么时候用 RPC？

适合：

- 请求-响应模型
- 需要得到明确返回值
- 需要超时控制

例如：

- 下发任务并等待结果
- 远程查询状态
- 获取配置快照

### 28.2 什么时候用 `PUBLISH`？

适合：

- `master` 面向全部在线 `slave` 发送同一类通知
- 不关心逐个返回值
- 更偏“广播”语义

例如：

- 配置刷新通知
- 全局模式切换
- 系统公告

### 28.3 什么时候用 `PUSH`？

适合：

- `slave` 向 `master` 上报事件
- 不需要等待返回值
- 更偏“告警/遥测”语义

例如：

- 监控指标
- 日志摘要
- 健康检查结果

### 28.4 什么时候用 `fs.get()` 与 `fs.download()`？

- `fs.get()`：小文件、文本文件、配置文件
- `fs.download()`：大文件、需要断点续传的文件、归档/日志包

### 28.5 什么时候用 `fs.patch()`？

适合：

- 文本配置的局部更新
- 需要保留 diff 语义的变更

不适合：

- 二进制文件
- 大规模内容整体替换

---

## 29. 本地示例命令

如果你想直接跑仓库内置示例，可以使用：

```bash
# 终端 1：启动 Master
pnpm example:master

# 终端 2：启动 Slave
pnpm example:slave
```

如果示例支持手动传参，也可以启动指定 `slaveId`：

```bash
node test/slave/index.js slave-001
```

---

## 30. 测试与压测

### 30.1 运行测试

```bash
pnpm test
```

### 30.2 明文模式压测

```bash
# 终端 1
pnpm test:echo

# 终端 2
pnpm test:100 -- 100 10000 slave-001
```

### 30.3 安全模式压测

```bash
# 终端 1
ZNL_AUTH_KEY=my-secret ZNL_ENCRYPTED=true pnpm test:echo

# 终端 2
pnpm test:100 -- 100 10000 slave-001 my-secret true
```

---

## 31. 排障建议

### 31.1 首条请求失败

建议先等待：

```js
slave.isMasterOnline() === true
```

再发送首条请求。

### 31.2 安全模式通信失败

重点检查：

- 两边 `encrypted` 是否一致
- `authKey` 是否一致
- `authKeyMap` 是否正确命中对应 `slaveId`
- 两边系统时间是否偏差过大

### 31.3 `fs` 路径访问失败

重点检查：

- `slave.fs.setRoot()` 是否已调用
- 目标路径是否超出 `root`
- `slaveId` 是否正确
- 路径是否使用了错误的相对层级
- 路径是否命中了 `allowedPaths` / `denyGlobs` 策略
- 是否处于 `readOnly=true` 或 `allowDelete=false` / `allowPatch=false` / `allowUpload=false`
- 目标路径链路中是否包含符号链接 / junction

### 31.4 大文件读写问题

建议：

- 大文件上传使用 `upload()`
- 大文件下载使用 `download()`
- 不要用 `get()` 直接处理超大文件
- 合理设置 `chunkSize` 与 `timeoutMs`

---

## 32. 推荐阅读顺序

如果你是第一次接触 ZNL，建议按下面顺序阅读：

1. 主 README：项目总览
2. 本文档：理解如何实际使用
3. `docs/README.api.md`：查看完整 API 签名与参数
4. `docs/README.protocol.md`：理解底层帧与协议细节

---

## 33. 小结

ZNL 适合构建：

- `master / slave` 控制架构
- 节点调度系统
- 远程执行系统
- 广播通知系统
- 带安全能力的内部通信链路
- 带远程文件能力的分布式控制场景

如果你只记住最重要的几点，可以先记住这些：

- 双向 RPC：`DEALER()` / `ROUTER()`
- 广播：`PUBLISH()` / `SUBSCRIBE()`
- 推送：`PUSH()`
- 在线状态：`masterOnline` / `isMasterOnline()`
- 文件服务：`slave.fs.setRoot()` + `master.fs.*`
- 安全模式：`encrypted: true` + `authKey/authKeyMap`

这样你就可以很快把 ZNL 接入到自己的项目里。