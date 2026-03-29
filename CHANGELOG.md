# 更新日志

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