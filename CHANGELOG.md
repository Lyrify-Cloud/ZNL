# 更新日志

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