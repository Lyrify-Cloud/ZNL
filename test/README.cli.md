# ZNL 测试命令行使用指南

本文档说明以下两个测试脚本的用法：

- `test/master/index.js`
- `test/slave/index.js`

它们配合使用，可实现：

- 启动 `master` 节点
- 启动一个或多个 `slave` 节点
- 通过 `master` 的交互式命令行管理 `slave` 暴露的文件目录
- 支持加密通信开关
- 支持 JSON 输出模式

---

## 1. 文件说明

### `test/master/index.js`

`master` 测试节点，提供交互式命令行，支持：

- 查看在线 `slave`
- 选择目标 `slave`
- 发送普通 RPC
- 使用内建 `fs` 服务管理远端文件

### `test/slave/index.js`

`slave` 测试节点，启动后会：

- 连接到 `master`
- 启用 `slave.fs.setRoot(...)`
- 暴露一个根目录给 `master.fs`
- 保留简单的 RPC 自动回复
- 输出文件服务访问日志

---

## 2. 启动前说明

默认通信地址：

- `tcp://127.0.0.1:6003`

默认认证 Key：

- `znl-demo-fixed-key`

默认行为：

- `encrypted = true`
- `json = false`

也就是说，如果你不传参数：

- 默认启用加密
- 默认使用普通控制台输出

---

## 3. Master 用法

### 基本命令

```bash
node test/master/index.js
```

### 带参数启动

```bash
node test/master/index.js --encrypted
node test/master/index.js --no-encrypted
node test/master/index.js --json
node test/master/index.js --encrypted --json
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `--encrypted` | 启用加密通信，默认开启 |
| `--no-encrypted` | 禁用加密通信 |
| `--json` | 使用 JSON 输出 |
| `-h`, `--help` | 显示帮助 |

---

## 4. Slave 用法

### 基本命令

```bash
node test/slave/index.js
```

### 指定 slaveId

```bash
node test/slave/index.js slave-001
```

### 指定 slaveId 和 rootPath

```bash
node test/slave/index.js slave-001 ./sandbox/slave-001
```

### 带参数启动

```bash
node test/slave/index.js slave-001 ./sandbox/slave-001 --encrypted
node test/slave/index.js slave-001 ./sandbox/slave-001 --no-encrypted
node test/slave/index.js slave-001 ./sandbox/slave-001 --json
node test/slave/index.js slave-001 ./sandbox/slave-001 --encrypted --json
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `slaveId` | slave 节点 ID，默认 `slave-001` |
| `rootPath` | 暴露给 `master.fs` 的目录，默认 `test/slave/data/<slaveId>` |
| `--encrypted` | 启用加密通信，默认开启 |
| `--no-encrypted` | 禁用加密通信 |
| `--json` | 使用 JSON 日志输出 |
| `-h`, `--help` | 显示帮助 |

---

## 5. 推荐启动顺序

建议先启动 `master`，再启动 `slave`。

### 终端 1：启动 master

```bash
node test/master/index.js
```

### 终端 2：启动 slave

```bash
node test/slave/index.js slave-001
```

### 终端 3：再启动一个 slave（可选）

```bash
node test/slave/index.js slave-002 ./sandbox/slave-002
```

---

## 6. Master 交互式命令

启动 `master` 后，可在命令行中输入以下命令。

### 6.1 查看帮助

```text
help
```

### 6.2 查看在线 slave 列表

```text
slaves
```

### 6.3 选择当前操作目标 slave

```text
use <slaveId>
```

示例：

```text
use slave-001
```

### 6.4 向当前 slave 发起普通 RPC

```text
ping
ping <text>
```

示例：

```text
ping
ping whoami
ping hello slave
```

---

## 7. FS 文件管理命令

这些命令通过 `master.fs.*` 调用远端 `slave` 的内建文件服务。

> 注意：所有远端路径都受 `slave.fs.setRoot(...)` 限制，无法越出该根目录。

### 7.1 查看当前远端工作目录

```text
fs pwd
```

### 7.2 切换远端工作目录

```text
fs cd <dir>
```

示例：

```text
fs cd notes
fs cd /
fs cd ../
```

说明：

- 这里的 `cwd` 是 `master` 本地维护的“远端工作目录”
- 不会修改 `slave` 进程自己的工作目录

### 7.3 列出目录内容

```text
fs ls
fs ls <dir>
```

示例：

```text
fs ls
fs ls notes
fs ls /
```

### 7.4 查看文件或目录信息

```text
fs stat <path>
```

示例：

```text
fs stat README.txt
fs stat notes/sample.json
```

### 7.5 读取远端文件内容

```text
fs cat <file>
```

示例：

```text
fs cat README.txt
fs cat hello.txt
fs cat notes/sample.json
```

说明：

- 文本文件会直接打印内容
- 二进制文件会输出前 64 字节的十六进制预览
- 在 `--json` 模式下：
  - 文本输出为 `utf8`
  - 二进制输出为 `base64`

### 7.6 删除远端文件或目录

```text
fs rm <path>
```

示例：

```text
fs rm hello.txt
fs rm notes
```

说明：

- 支持删除文件
- 支持递归删除目录

### 7.7 重命名或移动远端文件

```text
fs mv <from> <to>
```

示例：

```text
fs mv hello.txt hello.backup.txt
fs mv notes/sample.json sample.json
```

### 7.8 上传本地文件到远端

```text
fs upload <localPath> <remotePath>
```

示例：

```text
fs upload ./package.json package.json.copy
fs upload ./README.md docs/README.copy.md
```

说明：

- `localPath` 是 `master` 本地路径
- `remotePath` 是当前 `slave` 根目录下的相对路径

### 7.9 从远端下载文件到本地

```text
fs download <remotePath> <localPath>
```

示例：

```text
fs download README.txt ./tmp/README.txt
fs download notes/sample.json ./tmp/sample.json
```

说明：

- `remotePath` 是 `slave` 上的文件
- `localPath` 是 `master` 本地保存路径

### 7.10 清屏

```text
clear
```

### 7.11 退出

```text
exit
quit
```

---

## 8. 路径规则说明

### 远端路径默认相对当前 `fs cwd`

例如当前 `cwd = notes`：

```text
fs cat sample.json
```

等价于：

```text
fs cat notes/sample.json
```

### 以 `/` 开头的路径表示从 slave root 开始

例如：

```text
fs cat /README.txt
```

表示读取 `slave` 根目录下的 `README.txt`。

---

## 9. JSON 输出说明

## 9.1 Master 的 `--json`

`master` 加上 `--json` 后，事件和命令结果会输出为 JSON。

示例：

```bash
node test/master/index.js --json
```

可能输出：

```json
{
  "type": "startup",
  "time": "2025-01-01T00:00:00.000Z",
  "ok": true,
  "router": "tcp://127.0.0.1:6003",
  "encrypted": true,
  "json": true,
  "role": "master",
  "id": "master-demo"
}
```

常见输出类型：

- `startup`
- `slaves`
- `slave_connected`
- `slave_disconnected`
- `rpc.incoming`
- `push`
- `ping`
- `fs.pwd`
- `fs.cd`
- `fs.list`
- `fs.stat`
- `fs.cat`
- `fs.rm`
- `fs.mv`
- `fs.upload`
- `fs.download`
- `command_error`
- `shutdown`
- `fatal`

### 9.2 Slave 的 `--json`

`slave` 加上 `--json` 后，会把日志改为 JSON 行输出。

示例：

```bash
node test/slave/index.js slave-001 ./sandbox/slave-001 --json
```

常见事件：

- `started`
- `waiting_master_online`
- `master_online`
- `rpc_request_received`
- `fs_access`
- `fs_error`
- `fs_upload_chunk`
- `fs_download_chunk`
- `push_sent`
- `status`
- `stopping`
- `stopped`

---

## 10. 加密参数说明

### 启用加密

```bash
node test/master/index.js --encrypted
node test/slave/index.js slave-001 ./sandbox/slave-001 --encrypted
```

### 关闭加密

```bash
node test/master/index.js --no-encrypted
node test/slave/index.js slave-001 ./sandbox/slave-001 --no-encrypted
```

### 重要说明

`master` 和 `slave` 两端的加密配置必须一致：

- 两边都启用加密：可以通信
- 两边都关闭加密：可以通信
- 一边启用、一边关闭：通常无法正常通信

---

## 11. 推荐演示流程

下面是一套完整演示流程。

### 第一步：启动 master

```bash
node test/master/index.js
```

### 第二步：启动 slave

```bash
node test/slave/index.js slave-001
```

### 第三步：在 master 中查看在线节点

```text
slaves
```

### 第四步：选择目标 slave

```text
use slave-001
```

### 第五步：查看根目录文件

```text
fs ls
```

### 第六步：读取默认示例文件

```text
fs cat README.txt
fs cat hello.txt
fs cat notes/sample.json
```

### 第七步：发送普通 RPC

```text
ping whoami
```

### 第八步：上传文件

```text
fs upload ./package.json package.json.copy
```

### 第九步：确认文件已上传

```text
fs ls
fs stat package.json.copy
```

### 第十步：下载文件

```text
fs download package.json.copy ./tmp/package.json.copy
```

### 第十一步：重命名文件

```text
fs mv package.json.copy package.json.bak
```

### 第十二步：删除文件

```text
fs rm package.json.bak
```

---

## 12. 默认测试目录

如果你这样启动：

```bash
node test/slave/index.js slave-001
```

默认根目录会是：

```text
test/slave/data/slave-001
```

脚本会自动准备一些示例文件，例如：

- `README.txt`
- `hello.txt`
- `notes/sample.json`

这样你可以直接用 `master` 测试文件管理功能。

---

## 13. 常见问题

### 13.1 为什么看不到 slave 在线？

请检查：

1. `master` 是否已启动
2. `slave` 是否连接到了同一个 `router` 地址
3. 两端 `encrypted` 配置是否一致
4. 两端 `authKey` 是否一致

### 13.2 为什么 fs 操作失败？

请检查：

1. `slave.fs.setRoot(...)` 是否已启用
2. 目标路径是否存在
3. 目标是否是正确类型（文件/目录）
4. 路径是否超出了 `slave root` 的限制

### 13.3 为什么 `fs cat` 显示的是 base64 或二进制信息？

因为目标文件不是纯文本文件，程序会避免直接把二进制内容当文本输出。

### 13.4 为什么 `master` 的 `cwd` 改了，但 `slave` 的工作目录没变？

因为 `fs cd` 只是 `master` CLI 的远端路径辅助功能，不会影响 `slave` 进程自身的运行目录。

---

## 14. 快速命令参考

### 启动

```bash
node test/master/index.js
node test/slave/index.js slave-001
```

### 查看和选择节点

```text
slaves
use slave-001
```

### 文件操作

```text
fs ls
fs pwd
fs cd notes
fs stat sample.json
fs cat sample.json
fs upload ./a.txt a.txt
fs download a.txt ./tmp/a.txt
fs mv a.txt b.txt
fs rm b.txt
```

### RPC

```text
ping
ping whoami
```

### 退出

```text
exit
```

---

## 15. 建议

如果你后续还想扩展这个测试 CLI，推荐优先增加：

- `fs mkdir`
- `fs tree`
- `fs write`
- `--auth-key`
- 单命令执行模式，如：
  - `--json-once "fs ls"`

这样可以更方便集成到自动化测试或脚本中。