# 更新日志

## v0.7.3

### 修复
- `master.fs.download()` 增加空分片保护：收到 `chunk.length === 0` 且未到 EOF 时直接报错，避免下载死循环卡住。
- `slave.fs` 下载分片读取增加安全校验：当 `bytesRead=0` 且未到 EOF 时直接报错，避免异常读导致卡住。

### 变更
- 集成测试默认输出更精简：仅显示模块级成功/失败；详细用例与断言日志仅在 `ZNL_TEST_VERBOSE=1` 时输出。

### 测试
- 新增 `runner 输出` 集成测试：覆盖 compact 与 verbose 两种输出模式。

### 文档
- `README.md` 补充 `ZNL_TEST_VERBOSE=1` 用于开启详细测试日志的说明。

## v0.7.2

### 修复

- 安全模块 `verifyTextSignature()` 加固签名比对流程：在固定长度缓冲区上执行 `timingSafeEqual`，减少长度差异导致的时序差异暴露。
- `master.fs` 会话 ID 生成方式改为 `crypto.randomUUID()`，替代 `Math.random()`，提升随机性与不可预测性。
- `SendQueue.clear()` 行为增强：会主动 `reject` 已入队但尚未执行的任务，避免任务悬挂与旧连接残留发送风险。

### 测试

- 新增安全用例：覆盖 `verifyTextSignature` 的合法签名通过、畸形/非法签名失败场景。
- 新增队列用例：覆盖 `SendQueue.clear()` 会取消未执行任务并触发 `reject` 的行为。

### 文档
- `README.md` 事件章节补充 `error` 事件最佳实践：建议业务侧始终显式监听并接入日志/告警。


## v0.7.1

### 新增
- 新增 `kdfSalt` 构造参数（支持 `string` / `Buffer` / `Uint8Array`），用于自定义 HKDF 派生盐值。
- `deriveKeys(authKey, { salt })` 支持传入自定义盐值；未传或为空时回退到内置默认盐。

### 变更
- `ZNL` 实例在以下密钥派生路径统一接入 `kdfSalt`：
  - 构造阶段主密钥派生
  - `addAuthKey()` 动态加钥派生
  - `authKeyMap` 命中后的按节点派生
- 保持向后兼容：不配置 `kdfSalt` 时行为与历史版本一致。

### 文档
- `README.md` 构造示例新增 `kdfSalt` 配置示例。
- `docs/README.api.md` 新增 `kdfSalt` 参数说明、默认行为与双端一致性注意事项。

### 测试
- `security` 集成测试新增覆盖：
  - `deriveKeys` 在相同 `authKey + salt` 下派生结果一致
  - `deriveKeys` 在相同 `authKey + 不同 salt` 下派生结果不同
  - `encrypted=true` 时，`kdfSalt` 不一致触发认证失败（`auth_failed`）
  - `encrypted=true` 时，`kdfSalt` 一致通信正常

## v0.7.0

### 新增
- `slave.fs.setRoot(rootPath, policy?)` 新增 `get` 读取限制策略：
  - `getAllowedExtensions: string[]`：限制 `master.fs.get()` 仅允许读取指定扩展名（默认常见文本类型，如 `js`、`txt`、`toml` 等）。
  - `maxGetFileMb: number`：限制 `master.fs.get()` 单文件最大读取体积（默认 `4MB`）。

### 变更
- `master.fs.get()` 现在会执行文本类型与大小双重校验：
  - 当文件扩展名不在 `getAllowedExtensions` 白名单时拒绝读取。
  - 当文件大小超过 `maxGetFileMb` 时拒绝读取。
- `get` 被限制时会返回明确错误信息，并提示使用 `master.fs.download()` 获取文件。
- `master.fs.download()` 保持可用，用于获取超限或非文本文件。

### 文档
- `README.md` 补充 `getAllowedExtensions` 与 `maxGetFileMb` 配置说明及默认行为。
- `docs/README.api.md` 补充策略字段、行为说明、失败原因与示例配置。

### 测试
- `fs` 集成测试新增用例：`plain 模式：get 限制扩展名与大小，超限应通过 download`。
- 覆盖点包括：
  - 允许文本扩展名文件 `get` 成功
  - 非白名单扩展名 `get` 被拒绝
  - 超大小文件 `get` 被拒绝
  - 上述受限文件可通过 `download` 成功获取且内容一致
- 自动执行 `pnpm test` 与 `pnpm test:integration:fs`，测试通过。

## v0.6.9

### 新增
- `master.fs.upload()` 与 `master.fs.download()` 新增可选进度回调：`options.onProgress(event)`。
- 进度事件支持分阶段上报：`init`、`chunk`、`complete`。
- 进度事件字段包含：
  - `direction`（`upload` / `download`）
  - `phase`
  - `slaveId`、`sessionId`
  - `localPath`、`remotePath`
  - `transferred`、`total`、`percent`
  - `speedBps`（字节/秒）
  - `etaSeconds`（预计剩余秒数，无法估算时为 `null`）
  - `chunkId`、`totalChunks`、`size`
  - `meta`（完成阶段）

### 变更
- `test/master/index.js` 交互式 CLI 增强上传/下载可视化进度展示：
  - 普通终端模式实时显示百分比与已传/总量
  - 新增传输速度（`MB/s`）与 ETA（剩余时间）显示
  - TTY 场景下使用单行刷新，完成后自动换行
- `--json` 模式下的 `fs.progress` 事件新增：
  - `speedBps`
  - `etaSeconds`
- 进度输出增加节流与平滑处理，减少刷屏并提升观感。

### 文档
- `README.md` 补充 `onProgress(event)` 的字段说明，明确包含 `speedBps` 与 `etaSeconds`。
- `docs/README.api.md` 在 `master.fs.upload()` / `master.fs.download()` 的 `onProgress` 字段表中补充 `speedBps` 与 `etaSeconds`。
- `docs/README.examples.md` 新增上传/下载进度示例代码，演示如何消费 `onProgress` 并输出速度与 ETA。

### 测试
- 自动执行 `pnpm test`：
  - 用例通过：`76/76`
  - 断言通过：`238/238`
  - 失败：`0`

## v0.6.8

### 变更
- 修复 `master.fs.upload()` 在特定路径下可能导致目录被文件覆盖的问题：
  - 上传完成阶段不再允许将“已存在目录”删除并替换为文件
  - 当目标是目录时会直接拒绝该写入
- 优化 `upload(remotePath)` 路径语义，新增目录兜底解析：
  - `remotePath` 以 `/` 或 `\` 结尾时，按目录处理并自动拼接 `basename(localPath)`
  - `remotePath` 为 `.` / `./` / `.\` 时，按 `fs root` 目录处理并自动拼接 `basename(localPath)`
  - `remotePath` 不带结尾斜杠但远端已存在目录时，按目录处理并自动拼接 `basename(localPath)`
  - 其他情况保持为“明确文件路径”语义
- 修复 root 目录写入场景下的父路径解析边界问题，避免 `upload(..., ".")` 出现异常。

### 文档
- README 与 API 文档补充 `upload(remotePath)` 目录语义与安全行为说明。
- 示例文档保留“显式文件路径”为最佳实践，同时说明目录语义仅作兜底能力。

### 测试
- 自动执行 `node test/integration/run-module.js fs`，当前 `fs` 模块集成测试共 `65` 项全部通过。
- 新增上传语义相关覆盖：
  - `assets/`（结尾斜杠目录）
  - `.`（root 目录）
  - 已存在目录且不带结尾斜杠
  - 明确文件路径上传兼容性验证

## v0.6.7

### 新增
- 内建 `fs` 命名空间新增：
  - `master.fs.create(slaveId, path, options?)`
  - `master.fs.mkdir(slaveId, path, options?)`
- `create()` 支持创建远端空文件：
  - 支持 `recursive` 自动创建缺失父目录
  - 支持 `overwrite` 控制是否覆盖已有文件
- `mkdir()` 支持创建远端目录：
  - 支持 `recursive` 自动创建多级目录
  - 支持 `existOk` 控制目录已存在时是否视为成功
- 集成测试新增 `fs.create()` / `fs.mkdir()` 覆盖：
  - 正常创建文件与目录
  - `readOnly=true` 下拒绝创建
  - `allowUpload=false` 下拒绝创建

### 变更
- `fs` 策略说明扩展到 `create / mkdir`：
  - `readOnly=true` 时会拒绝 `create / mkdir / patch / delete / rename / upload`
  - `allowUpload=false` 时会拒绝 `create()`、`mkdir()` 与 `upload()`
- `fs` 路径解析逻辑调整为支持创建场景下缺失的父目录链，同时仍保留 root 边界与符号链接防逃逸检查。
- README、API 文档与示例文档同步补充 `create()` / `mkdir()` 的参数、返回值、策略约束与使用示例。

### 测试
- 自动执行 `node test/integration/run-module.js fs`，当前 `fs` 模块集成测试共 `57` 项全部通过。

## v0.6.6

### 新增
- `slave.fs.setRoot()` 新增策略配置参数 `policy`，支持：
  - `readOnly`
  - `allowDelete`
  - `allowPatch`
  - `allowUpload`
  - `allowedPaths`
  - `denyGlobs`
- `slave.fs` 新增策略读取能力：`slave.fs.getPolicy()`。
- 集成测试新增 `fs` 安全加固覆盖：
  - root 内部 `symlink / junction` 越界访问拒绝
  - `readOnly=true` 写操作拒绝
  - `allowedPaths / denyGlobs / allowDelete / allowPatch / allowUpload` 策略生效校验

### 变更
- 加固内建 `fs` 服务的路径解析流程，不再只校验字符串层面的 `../` 越界。
- `fs` 服务现在会拒绝访问路径链路中包含的符号链接（Linux/macOS symlink）或目录联接（Windows junction），防止通过 root 内部链接跳出 `slave.fs.setRoot()` 指定目录。
- `list / stat / get / delete / rename / patch / upload / download` 全部接入更严格的安全路径校验与策略校验。
- `list()` 在目录项中仍会保留 `symlink` 类型信息，但后续访问该链接目标会被拒绝。
- README、API 文档与示例文档补全 `slave.fs.setRoot(rootPath, policy?)` 的真实行为说明、策略字段说明、符号链接限制与使用建议。

### 测试
- 自动执行 `pnpm test`，当前集成测试共 `207` 项全部通过。

## v0.6.5

### 新增
- 重写 `test/master/index.js`，提供交互式命令行测试，可直接选择目标 `slave` 并执行远端 `fs` 文件管理操作。
- 重写 `test/slave/index.js`，启用 `slave.fs.setRoot(...)`，默认暴露测试目录供 `master.fs` 访问。
- `master` / `slave` 测试脚本新增启动参数：
  - `--encrypted` / `--no-encrypted`
  - `--json`
- 新增 `test/README.cli.md`，补充两套测试脚本的命令行使用教程、参数说明、JSON 输出说明与推荐演示流程。

### 变更
- `master` 测试从定时广播/定时 ping 示例调整为更贴近实际使用的交互式文件管理 CLI。
- `slave` 测试从通用通信演示调整为面向内建 `fs` 服务的文件管理测试节点。
- 测试示例默认启用加密，但允许通过参数显式关闭，便于同时验证 plain / encrypted 两种模式。
- 测试输出增加结构化 JSON 模式，便于后续接入脚本化调用与自动化验证。

### 测试
- 自动执行 `pnpm test`，当前集成测试共 `193` 项全部通过。
- 自动执行 `pnpm check`，语法检查通过。

## v0.6.4

### 新增
- 内建独立 `service` 通道，新增 `svc_req` / `svc_res` 底层控制帧，与业务 `req` / `res` 分流。
- 内建 `fs` 命名空间：
  - `master.fs.list/get/patch/delete/rename/stat`
  - `master.fs.upload/download`
  - `slave.fs.setRoot("./")`
- 新增通用内部服务管理层，用于承载 `fs` 等不应与业务 RPC 串流的系统能力。
- 新增独立底层协议文档 `docs/README.protocol.md`，详细说明真实外层控制帧、明文/加密差异、service 通道与 `fs` payload 语义。
- 集成测试新增 `fs` 内建服务覆盖，包括 plain / encrypted 模式下的 CRUD、patch、upload/download 与 root 越权校验。

### 变更
- `fs` 文件服务不再复用业务 `ROUTER()` / `DEALER()` 自动处理器，改走内部 service 通道。
- `fs` 通道在 `encrypted=true` 下复用现有签名、防重放与透明加密链路。
- README 精简底层协议章节，主 README 仅保留概览并跳转到独立协议文档。
- `patch` 功能引入 `diff` 依赖并采用原子写入方式覆盖目标文件。
- upload/download 增加分片传输、ACK 确认、断点续传、临时文件落盘与 session 过期清理。

### 测试
- 自动执行完整集成测试，当前模块化测试共 176 项全部通过。

## v0.6.3

### 新增
- 集成测试重构为模块化结构，支持按 `constructor`、`rpc`、`lifecycle`、`pubsub`、`security`、`fs` 分模块执行。
- 增加集成测试模块运行入口与对应脚本，便于按能力域单独验证。
- 补充 API 角色限制、默认状态、`request/response` 事件、`null/undefined` payload、`publish` 事件隔离、未设置 `fs root` 等测试覆盖。
- 将 `PendingManager`、`SendQueue`、安全辅助方法相关的小粒度测试并入统一集成测试体系。

### 变更
- `test/run.js` 调整为模块化集成测试薄入口。
- `package.json` 测试脚本统一到集成测试入口，移除独立 `test:unit` 与 `test:all`。
- 删除 `test/unit` 目录，统一测试组织方式。
- 优化安全模式下的防重放缓存清理策略，避免高并发场景中按消息频率全量扫描 nonce 表。
- 移除安全签名热路径中的无效计算，减少加密模式下的额外 CPU 开销。
- 优化签名校验过程中的中间数据转换，降低 HMAC 校验时的对象分配与编码往返成本。
- 优化安全信封版本帧的复用与比较逻辑，减少不必要的 `Buffer` 分配与字符串转换。
- 将 `enablePayloadDigest` 默认值从 `true` 调整为 `false`，提升加密模式下的吞吐表现。
- README 与 API 文档同步更新，补充 `enablePayloadDigest` 的默认行为、性能建议与配置一致性说明。

### 性能
- 在 `10000` 并发请求压测中，关闭 `payloadDigest` 的加密模式吞吐从约 `3091 ok/s` 提升至约 `3748 ok/s`，提升约 `21%`。
- 第一轮安全热路径优化后，加密模式压测吞吐从约 `2771 ok/s` 提升至约 `3258 ok/s`。

### 测试
- 自动执行完整测试流程，当前集成测试共 176 项全部通过。
- 已执行一轮默认配置下的加密压测验证，`10000/10000` 请求成功，吞吐约 `3455 ok/s`。

## v0.6.2

### 新增
- README 快速开始增加 Master 侧 `push` 监听示例。
- 增加 `encrypted` 模式下 PUSH 的集成测试覆盖。

### 变更
- 优化 `CONTROL_PUB` 注释，避免与 PUSH 概念混淆。

## v0.6.1

### 新增
- 新增 `PUSH(topic, payload)`（slave -> master，fire-and-forget），支持签名与透明加密。
- 协议层新增 `push` 控制帧，包含构建与解析支持。
- Master 侧新增 `push` 事件，回调携带 `{ identityText, topic, payload }`。

### 变更
- 公共 API 方法改为大写：`PUBLISH`、`SUBSCRIBE`、`UNSUBSCRIBE`。
- README、示例与测试同步更新以匹配新 API 与 PUSH 特性。

### 测试
- 集成测试新增 PUSH 流程覆盖。