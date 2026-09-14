# 架构与一致性边界

## 两条入口

根目录 `manifest.json` 启动 V1；`manifest.v2-preview.json` 经构建成为 V2 独立 manifest。构建不是迁移，两者不自动共享配置或消息。

V1：DOM → 完整 Turn → storage.local 队列/写入意图 → 客户端 → 水位/JSONL 回读。前缀、顺序、正文不一致可能停写；不能将 P0 尽力去重原型视为已应用到 V1。

V2：MAIN fetch 观察 → ISOLATED relay → Worker parser → IndexedDB。无上传客户端、服务权限或 commit 调用。`preview-local-only` 不是生产账户命名空间。

## V2 数据结构

数据库 `openviking-sync-v2`：

| Store | 用途 |
| --- | --- |
| conversations | 计数、范围、未支持/冲突状态 |
| messages | scope/Conversation/message.id 唯一身份及正文元数据 |
| outbox | 首次观察 sequence 顺序的待发送索引，当前不上传 |
| revisions | 同 ID 正文变化的修订 |
| meta | 容量等状态 |

正文/角色 hash 与元数据 hash 分开；SHA-256 在事务外算，避免事务内等待非 IDB Promise 造成关闭。消息/outbox 在同一事务更新；容量超限整批回滚，不淘汰未发数据。100 MiB 是应用估算预算，不是物理配额保证。

重复正文不重新入队；仅元数据变化时更新元数据。正文不同保留修订并隔离该条。页内遵循数组顺序，跨页按首次观察，不按时间或 UUID 排序。

## 采集与性能

只观察 `chatgpt.com/backend-api/conversation(s)/<id>` 形状的自然 GET，这是非稳定页面协议，不是官方公开 ChatGPT API 契约。不主动分页或读取 SSE，保留原 fetch Promise/Response，不等待数据库才返回页面。

读取上限 2 MiB、最多 2 个 clone、15 秒超时，另限通知和积压。不能由此推出整个网页或 tee 缓冲绝对有界，仍需实测。

仅接纳经过过滤的 text User/最终 Assistant。隐私标志不明、未知类型或异常不能解释为完整成功。过滤不认证恶意页面，见 [安全说明](../../SECURITY.md)。

## 上传演进

V1 负责 Session/批量消息、Task 和当前/归档日志。插件写入自动整理策略，不显式 commit。

未来 V2 复用客户端及回读，但必须替换 V1 的完整前缀限制与固定消息数增长断言。物理累计数不等于唯一来源数，来源 ID 不能假定有唯一约束。

预读、写后确认和 pending 恢复仍有跨设备竞态；发现重复不等于删除重复或纠正记忆。迁移前核对旧身份、绑定账户/目标、保证上传器互斥。以上上传适配尚未接入 V2。
