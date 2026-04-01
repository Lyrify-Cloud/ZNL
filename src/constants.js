/**
 * 协议常量与默认配置
 * 集中管理所有魔法字符串和默认值，避免散落在业务代码中
 */

/** 控制帧版本前缀，用于区分控制帧与业务帧 */
export const CONTROL_PREFIX = "__znl_v1__";

/** 请求类型标识符 */
export const CONTROL_REQ = "req";

/** 响应类型标识符 */
export const CONTROL_RES = "res";

/** 内建服务请求类型标识符 */
export const CONTROL_SVC_REQ = "svc_req";

/** 内建服务响应类型标识符 */
export const CONTROL_SVC_RES = "svc_res";

/** 认证 Key 帧标识符（位于 req 帧中） */
export const CONTROL_AUTH = "__znl_v1_auth__";

/** slave 保活心跳帧标识符（slave → master，定时发送） */
export const CONTROL_HEARTBEAT = "heartbeat";

/** master 心跳应答帧标识符（master → slave，用于确认链路可达） */
export const CONTROL_HEARTBEAT_ACK = "heartbeat_ack";

/** slave 上线注册帧标识符（slave → master，start 时自动发送） */
export const CONTROL_REGISTER = "register";

/** slave 下线注销帧标识符（slave → master，stop 时自动发送） */
export const CONTROL_UNREGISTER = "unregister";

/** 广播帧标识符（master → slave，publish 时发送） */
export const CONTROL_PUB = "pub";

/** 单向推送帧标识符（slave → master，push 时发送） */
export const CONTROL_PUSH = "push";

/** 内建文件服务名 */
export const SERVICE_FS = "fs";

/** 文件服务默认分片大小（5MB） */
export const DEFAULT_FS_CHUNK_SIZE = 5 * 1024 * 1024;

/** 文件服务会话默认存活时间（毫秒） */
export const DEFAULT_FS_SESSION_TTL_MS = 30 * 60 * 1000;

/** 空 Buffer（全局复用，避免重复分配） */
export const EMPTY_BUFFER = Buffer.alloc(0);

/** 默认请求超时时间（毫秒） */
export const DEFAULT_TIMEOUT_MS = 5000;

/** 默认心跳间隔（毫秒），0 表示禁用心跳 */
export const DEFAULT_HEARTBEAT_INTERVAL = 3000;

/** 默认心跳超时时间（毫秒），0 表示采用 heartbeatInterval × 3 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 0;

/** 默认最大并发请求数（0 表示不限制） */
export const DEFAULT_MAX_PENDING = 1000;

/** 默认是否启用 payload 摘要（安全模式用） */
export const DEFAULT_ENABLE_PAYLOAD_DIGEST = true;

/** 默认端点配置 */
export const DEFAULT_ENDPOINTS = {
  router: "tcp://127.0.0.1:6003",
};

/** 安全信封版本标识（用于区分普通帧与带安全元数据的帧） */
export const SECURITY_ENVELOPE_VERSION = "__znl_sec_v1__";

/** 允许的最大时间偏移（毫秒），超过则视为可疑重放 */
export const MAX_TIME_SKEW_MS = 30_000;

/** Nonce 去重保留窗口（毫秒），用于重放检测 */
export const REPLAY_WINDOW_MS = 120_000;

/** AES-GCM 推荐 IV 长度（字节） */
export const ENCRYPT_IV_BYTES = 12;

/** AES-GCM 认证标签长度（字节） */
export const ENCRYPT_TAG_BYTES = 16;

/** 对称加密算法（基于 authKey 派生出的密钥） */
export const ENCRYPT_ALGORITHM = "aes-256-gcm";

/** 密钥派生用途标签：加密 */
export const KDF_INFO_ENCRYPT = "znl-kdf-encrypt-v1";

/** 密钥派生用途标签：签名 */
export const KDF_INFO_SIGN = "znl-kdf-sign-v1";
