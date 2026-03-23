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

/** 认证 Key 帧标识符（位于 req 帧中） */
export const CONTROL_AUTH = "__znl_v1_auth__";

/** slave 保活心跳帧标识符（slave → master，定时发送） */
export const CONTROL_HEARTBEAT = "heartbeat";

/** slave 上线注册帧标识符（slave → master，start 时自动发送） */
export const CONTROL_REGISTER = "register";

/** slave 下线注销帧标识符（slave → master，stop 时自动发送） */
export const CONTROL_UNREGISTER = "unregister";

/** 广播推送帧标识符（master → slave，publish 时发送） */
export const CONTROL_PUB = "pub";

/** 空 Buffer（全局复用，避免重复分配） */
export const EMPTY_BUFFER = Buffer.alloc(0);

/** 默认请求超时时间（毫秒） */
export const DEFAULT_TIMEOUT_MS = 5000;

/** 默认心跳间隔（毫秒），0 表示禁用心跳 */
export const DEFAULT_HEARTBEAT_INTERVAL = 3000;

/** 默认端点配置 */
export const DEFAULT_ENDPOINTS = {
  router: "tcp://127.0.0.1:6003",
};
