(function initializePopup() {
  "use strict";

  const core = globalThis.OpenVikingSyncCore;
  const extensionApi = globalThis.browser || globalThis.chrome;
  const usesPromiseApi = Boolean(globalThis.browser);
  let conversationId = null;

  function sendMessage(message) {
    if (usesPromiseApi) return extensionApi.runtime.sendMessage(message);
    return new Promise((resolve, reject) => {
      extensionApi.runtime.sendMessage(message, (response) => {
        const error = extensionApi.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function queryActiveTab() {
    if (usesPromiseApi) return extensionApi.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
    return new Promise((resolve) => extensionApi.tabs.query(
      { active: true, currentWindow: true },
      (tabs) => resolve(tabs[0])
    ));
  }

  function openOptions() {
    if (usesPromiseApi) return extensionApi.runtime.openOptionsPage();
    return new Promise((resolve) => extensionApi.runtime.openOptionsPage(resolve));
  }

  const labels = {
    [core.STATUS.NOT_CONFIGURED]: ["未配置", "请先填写 OpenViking 连接信息。"],
    [core.STATUS.DISABLED]: ["自动同步已关闭", "可在设置中重新开启。"],
    [core.STATUS.IDLE]: ["等待会话", "打开一个 ChatGPT Conversation 后开始同步。"],
    [core.STATUS.QUEUED]: ["等待同步", "消息已进入本地持久队列。"],
    [core.STATUS.SYNCING]: ["同步中", "正在写入 OpenViking Session。"],
    [core.STATUS.WAITING_HISTORY]: ["等待完整历史", "较早消息尚未稳定显示，后续消息不会越过它上传。"],
    [core.STATUS.PENDING_ARCHIVE]: ["已同步，待服务端触发", "原始消息已写入，等待 OpenViking 自动整理策略触发。"],
    [core.STATUS.ARCHIVING]: ["正在归档", "OpenViking 后台任务正在执行。"],
    [core.STATUS.PHASE1_ARCHIVED]: ["Phase 1 已归档", "原始消息已归档，等待摘要与长期记忆处理。"],
    [core.STATUS.MEMORY_PROCESSING]: ["记忆处理中", "Phase 2 正在生成摘要与长期记忆。"],
    [core.STATUS.MEMORY_COMPLETE]: ["记忆提取完成", "本轮归档、摘要与长期记忆处理已完成。"],
    [core.STATUS.POLICY_DISABLED]: ["自动整理未启用", "Session 返回的自动整理策略为空或与插件设置不一致。"],
    [core.STATUS.SYNCED]: ["已同步", "当前没有待同步或待整理内容。"],
    [core.STATUS.ERROR]: ["同步失败", "消息仍保留在本地，将自动重试。"],
    [core.STATUS.CONFLICT]: ["发现历史冲突", "已暂停自动追加，避免继续污染 OpenViking Session。"]
  };

  const waitingDetails = {
    history_start_missing: "尚未确认从第一条 ChatGPT 消息开始，请滚动到会话顶部。",
    known_anchor_not_visible: "最后一条已知消息暂未显示，请等待页面完成渲染。",
    stable_id_missing: "较早消息尚未获得稳定的 ChatGPT 消息 ID。",
    turn_order_invalid: "ChatGPT 可见消息顺序异常，正在等待页面重新渲染。",
    history_timestamp_missing: "历史日期分组尚未显示或无法解析。",
    earlier_message_unstable: "较早消息仍在生成或正文尚未稳定。",
    turn_incomplete: "尾部逻辑 Turn 尚未形成完整的 User + Assistant 回复。"
  };

  function formatTime(timestamp) {
    if (!timestamp) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(new Date(timestamp));
  }

  function formatPolicy(conversation) {
    if (!conversation) return "—";
    const status = conversation.autoCommitPolicyStatus || "unknown";
    const policy = conversation.effectiveAutoCommitPolicy;
    if (!policy) return status === "disabled" ? "已关闭" : "未启用";
    const compact = `${policy.pending_token_threshold}/${policy.message_count_threshold}/${policy.idle_timeout_seconds}/${policy.keep_recent_count}/${policy.min_commit_interval_seconds}`;
    return status === "enabled" ? `已生效 · ${compact}` : `${status} · ${compact}`;
  }

  function formatMemoryCounts(conversation) {
    const counts = conversation && conversation.memoryCounts || {};
    const entries = Object.entries(counts).filter(([, count]) => Number(count) > 0);
    if (!entries.length) return String(conversation && conversation.memoriesExtracted || 0);
    return entries.map(([kind, count]) => `${kind}:${count}`).join(" · ");
  }

  function render(response) {
    const status = response.status || core.STATUS.IDLE;
    const conversation = response.conversation;
    const [label, defaultDetail] = labels[status] || labels[core.STATUS.IDLE];
    const detail = status === core.STATUS.WAITING_HISTORY && conversation
      ? waitingDetails[conversation.waitingReason] || defaultDetail
      : defaultDetail;
    document.querySelector("#status-label").textContent = label;
    document.querySelector("#status-detail").textContent = conversationId ? detail : labels[core.STATUS.IDLE][1];
    const dot = document.querySelector("#status-dot");
    dot.className = `dot ${status}`;
    document.querySelector("#session-id").textContent = conversation && conversation.sessionId || "—";
    document.querySelector("#peer-id").textContent = "未启用";
    document.querySelector("#queue-count").textContent = String(response.queuedCount || 0);
    document.querySelector("#last-synced").textContent = formatTime(conversation && conversation.lastSyncedAt);
    document.querySelector("#last-archived").textContent = formatTime(conversation && conversation.lastArchivedAt);
    document.querySelector("#message-counts").textContent = `${conversation && conversation.liveMessageCount || 0} / ${conversation && conversation.totalMessageCount || 0}`;
    document.querySelector("#pending-tokens").textContent = String(conversation && conversation.pendingTokens || 0);
    document.querySelector("#commit-count").textContent = String(conversation && conversation.commitCount || 0);
    document.querySelector("#last-commit").textContent = formatTime(conversation && conversation.lastCommitAt);
    document.querySelector("#policy-status").textContent = formatPolicy(conversation);
    document.querySelector("#policy-status").title = conversation && conversation.autoCommitPolicyError || "";
    document.querySelector("#task-status").textContent = conversation && (
      [conversation.latestTaskStatus, conversation.latestTaskStage].filter(Boolean).join(" · ")
      || conversation.latestTaskId
    ) || "—";
    document.querySelector("#archive-uri").textContent = conversation && conversation.latestArchiveUri || "—";
    document.querySelector("#archive-uri").title = conversation && conversation.latestArchiveUri || "";
    document.querySelector("#memory-diff-uri").textContent = conversation && conversation.memoryDiffUri || "—";
    document.querySelector("#memory-diff-uri").title = conversation && conversation.memoryDiffUri || "";
    document.querySelector("#memory-counts").textContent = formatMemoryCounts(conversation);
    const errorBox = document.querySelector("#error-text");
    errorBox.hidden = !(conversation && conversation.lastError);
    errorBox.textContent = conversation && conversation.lastError || "";
    document.querySelector("#retry-button").disabled = !response.queuedCount
      && status !== core.STATUS.ERROR
      && status !== core.STATUS.CONFLICT;
  }

  async function refresh() {
    try {
      const tab = await queryActiveTab();
      conversationId = core.getConversationId(tab && tab.url);
      const response = await sendMessage({ type: "GET_STATUS", payload: { conversationId } });
      if (!response || !response.ok) throw new Error(response && response.error || "无法读取状态");
      render(response);
    } catch (error) {
      render({ status: core.STATUS.ERROR, queuedCount: 0, conversation: { lastError: core.safeErrorMessage(error) } });
    }
  }

  document.querySelector("#settings-button").addEventListener("click", () => void openOptions());
  document.querySelector("#retry-button").addEventListener("click", async () => {
    const button = document.querySelector("#retry-button");
    button.disabled = true;
    await sendMessage({ type: "RETRY_NOW", payload: { conversationId } });
    setTimeout(() => void refresh(), 400);
  });

  void refresh();
  setInterval(() => void refresh(), 1500);
})();
