# V2 架构与一致性

完整入口为 manifest.v2.json，发布源码根 manifest 同样使用它。V1 和 0.2.0 preview 只作历史实现/测试，不是发布包上传入口。

## 采集信任边界

ISOLATED relay 在 document_start 请求后台初始化。后台将随机文档密钥和 channel 通过 scripting 注入 MAIN 闭包；收到签名载荷时验证 sender.documentId/tabId、HMAC 与递增序号。通道状态在可信 storage.session，支持 Worker 唤醒恢复。旧未签名载荷直接拒绝。

注入发生在异步初始化后，可能错过已经完成的早期请求；不能保证每次首屏都采到。刷新和后续自然响应可补录。MAIN 环境本身被攻陷时签名也不能证明网络真实性，见安全说明。

## 精确时间

source-time.parseExact 在 JSON 语法验证后遍历受限深度 token，提取 messages 数组对应时间数字文本，拒绝重复 JSON key。解析结果保留数值与原始数字文本。

toIso 使用整数秒与小数分开转换，不进行浮点乘 1000。无效/缺失时间不借用其他时间，消息移入 missing_time 状态；后续有效元数据到达可重新入队。update_time 保留本地。服务端回读差异单独标记，不覆盖旧 V1 时间。

## 持久队列与上传

messages/outbox/revisions/conversations/meta 使用原子事务；外部 hash 在事务外完成。100 MiB 为估算预算，超限回滚，不丢弃未发消息。目的地身份 hash 决定 scope。

Worker 同实例串行 flush，每次最多处理 8 个会话，每会话最多 100 条；剩余由每分钟 alarm 或后续采集恢复。popup 定时仅更新小状态，不扫描聊天正文。

每批先读取 Session 水位、当前及归档 JSONL，再次读水位；数量不符视为不稳定快照，不发送。候选与来源/角色/兼容规范化正文匹配后排除已存在记录。只有缺少的候选才持久化 pending 并 POST，之后再回读确认，不按固定数量增长判成功。

已检测重复记录计数但不反复写；正文冲突隔离单条；未知来源阻止该 Session 身份迁移。HTTP 结果不确定保留 pending，重启后不新建替代 Session，先读原 Session 恢复。不存在跨设备原子锁，也不能保证日志回读之后没有其他写入。

## 升级与配置

同扩展身份且目的地匹配时读取旧 Session 映射；不同扩展依赖确定性命名和来源对账，不能读取彼此设置或自动禁用旧实例。自定义映射需同身份升级或人工核对。

配置变更隔离旧队列，原只读 preview 空间不导入。默认上传关闭，设置必须确认页面边界和旧实例已停止。同一扩展旧 V1 配置会被关闭，远端记录不被自动重写/删除。

OpenVikingClient 复用现有官方接口适配；不显式 commit，自动整理策略由服务端执行。策略更新失败单独提示。
