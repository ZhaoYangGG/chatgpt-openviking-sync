"use strict";

importScripts("../shared/core.js", "openviking-client.js", "state-store.js");

const core = globalThis.OpenVikingSyncCore;
const { OpenVikingClient } = globalThis.OpenVikingClientModule;
const { StateStore, RECONCILIATION } = globalThis.OpenVikingStateStoreModule;
const extensionApi = globalThis.browser || globalThis.chrome;
const usesPromiseApi = Boolean(globalThis.browser);
const actionApi = extensionApi.action || extensionApi.browserAction;

function storageGet(key) {
  if (usesPromiseApi) return extensionApi.storage.local.get(key).then((result) => result[key]);
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(key, (result) => {
      const error = extensionApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result[key]);
    });
  });
}

function storageSet(key, value) {
  if (usesPromiseApi) return extensionApi.storage.local.set({ [key]: value });
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.set({ [key]: value }, () => {
      const error = extensionApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function callAction(method, ...args) {
  if (!actionApi || typeof actionApi[method] !== "function") return Promise.resolve();
  if (usesPromiseApi) return actionApi[method](...args).catch(() => undefined);
  return new Promise((resolve) => actionApi[method](...args, () => resolve()));
}

function totalMessageCount(meta, fallback) {
  const value = Number(meta && meta.total_message_count);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

const stateStore = new StateStore({ get: storageGet, set: storageSet });
let flushPromise = null;
let flushAgain = false;

async function getConfig() {
  const value = await storageGet(core.CONFIG_KEY);
  try {
    return core.normalizeConfig(value);
  } catch (_error) {
    return core.normalizeConfig({});
  }
}

async function updateBadge() {
  const [config, status] = await Promise.all([getConfig(), stateStore.getStatus(null)]);
  if (!core.isConfigured(config)) {
    await Promise.all([
      callAction("setBadgeText", { text: "?" }),
      callAction("setBadgeBackgroundColor", { color: "#6b7280" })
    ]);
    return;
  }
  if (!config.enabled) {
    await callAction("setBadgeText", { text: "" });
    return;
  }
  if (status.hasError) {
    await Promise.all([
      callAction("setBadgeText", { text: "!" }),
      callAction("setBadgeBackgroundColor", { color: "#dc2626" })
    ]);
    return;
  }
  if (status.totalQueuedCount > 0) {
    await Promise.all([
      callAction("setBadgeText", { text: String(Math.min(99, status.totalQueuedCount)) }),
      callAction("setBadgeBackgroundColor", { color: "#d97706" })
    ]);
    return;
  }
  await callAction("setBadgeText", { text: "" });
}

async function ensureSessionConfiguration(client, sessionId, config) {
  let meta = await client.ensureSession(sessionId);
  let policyError = "";
  if (config.autoCommitEnabled
    && !core.autoCommitPoliciesEqual(meta && meta.auto_commit_policy, config.autoCommitPolicy)) {
    try {
      await client.updateSessionConfig(sessionId, config.autoCommitPolicy);
      meta = await client.getSession(sessionId);
    } catch (error) {
      policyError = core.safeErrorMessage(error);
    }
  }
  const actualPolicy = meta && meta.auto_commit_policy;
  const policyStatus = !config.autoCommitEnabled
    ? "disabled"
    : !actualPolicy
      ? "missing"
      : core.autoCommitPoliciesEqual(actualPolicy, config.autoCommitPolicy)
        ? "enabled"
        : "mismatch";
  return {
    ...meta,
    auto_commit_policy_status: policyStatus,
    auto_commit_policy_error: policyError
  };
}

async function reconcileConversation(client, conversationId, knownMeta, config) {
  const conversation = await stateStore.getConversation(conversationId);
  if (!conversation || conversation.reconciliationStatus === RECONCILIATION.CONFLICT) return false;
  try {
    const meta = knownMeta || await ensureSessionConfiguration(client, conversation.sessionId, config);
    await stateStore.setInitialized(conversationId, true, meta);
    const reportedTotal = totalMessageCount(meta, null);
    const shouldReadLog = reportedTotal === null || reportedTotal > 0;
    const records = shouldReadLog
      ? await client.readSessionMessages(conversation.sessionId, conversationId, meta) : [];
    const total = reportedTotal === null ? records.length : reportedTotal;
    const result = await stateStore.applyReconciliation(conversationId, records, {
      ...meta,
      total_message_count: total
    });
    return Boolean(result && result.ok);
  } catch (error) {
    await stateStore.setError(conversationId, error);
    return false;
  }
}

async function ensureReconciled(client, conversationId, config) {
  let conversation = await stateStore.getConversation(conversationId);
  if (!conversation || conversation.reconciliationStatus === RECONCILIATION.CONFLICT) return false;
  try {
    const meta = await ensureSessionConfiguration(client, conversation.sessionId, config);
    await stateStore.setInitialized(conversationId, true, meta);
    conversation = await stateStore.getConversation(conversationId);
    const serverTotal = totalMessageCount(meta, null);
    if (conversation.reconciliationStatus === RECONCILIATION.CLEAN
      && serverTotal !== null
      && conversation.expectedTotalMessageCount === serverTotal) {
      await stateStore.updateServerMeta(conversationId, meta);
      return true;
    }
    await stateStore.markReconciliationRequired(conversationId, "watermark_mismatch");
    return reconcileConversation(client, conversationId, meta, config);
  } catch (error) {
    await stateStore.setError(conversationId, error);
    return false;
  }
}

async function recoverPendingBatches(client, config) {
  for (const pending of await stateStore.listPendingBatches()) {
    try {
      const meta = await ensureSessionConfiguration(client, pending.sessionId, config);
      const serverTotal = totalMessageCount(meta, null);
      if (serverTotal === pending.pendingBatch.baselineTotal) {
        await stateStore.resolvePendingNotWritten(pending.conversationId);
        await stateStore.updateServerMeta(pending.conversationId, meta);
        continue;
      }
      await stateStore.markReconciliationRequired(pending.conversationId, "pending_write_recovery");
      await reconcileConversation(client, pending.conversationId, meta, config);
    } catch (error) {
      await stateStore.setError(pending.conversationId, error);
    }
  }
}

async function uploadAvailableBatches(client, config) {
  for (let batchIndex = 0; batchIndex < 20; batchIndex += 1) {
    const batch = await stateStore.claimBatch(100);
    if (!batch.length) break;
    const first = batch[0];
    try {
      let conversation = await stateStore.getConversation(first.conversationId);
      const meta = await ensureSessionConfiguration(client, first.sessionId, config);
      let serverTotal = totalMessageCount(meta, null);
      if (serverTotal === null) {
        const records = await client.readSessionMessages(first.sessionId, first.conversationId, meta);
        serverTotal = records.length;
        const reconciled = await stateStore.applyReconciliation(first.conversationId, records, {
          ...meta,
          total_message_count: serverTotal
        });
        if (!reconciled || !reconciled.ok) continue;
        conversation = await stateStore.getConversation(first.conversationId);
      }
      if (!conversation || serverTotal !== conversation.expectedTotalMessageCount) {
        await stateStore.releaseClaim(batch);
        await stateStore.markReconciliationRequired(first.conversationId, "pre_append_watermark_mismatch");
        await reconcileConversation(client, first.conversationId, meta, config);
        continue;
      }

      await stateStore.beginPendingBatch(batch, serverTotal);
      const response = await client.addMessages(first.sessionId, first.conversationId, batch);
      const confirmedMeta = await ensureSessionConfiguration(client, first.sessionId, config);
      let confirmedTotal = totalMessageCount(confirmedMeta, null);
      if (confirmedTotal === null) {
        const records = await client.readSessionMessages(first.sessionId, first.conversationId, confirmedMeta);
        confirmedTotal = records.length;
        if (confirmedTotal === serverTotal + batch.length) {
          await stateStore.applyReconciliation(first.conversationId, records, {
            ...confirmedMeta,
            total_message_count: confirmedTotal
          });
          continue;
        }
      }
      if (confirmedTotal !== serverTotal + batch.length) {
        await stateStore.markReconciliationRequired(first.conversationId, "post_append_watermark_mismatch");
        await reconcileConversation(client, first.conversationId, confirmedMeta, config);
        continue;
      }
      await stateStore.confirmBatch(batch, { ...response, ...confirmedMeta });
    } catch (error) {
      await stateStore.fail(batch, error, {
        uncertain: Boolean(error && error.retryable !== false)
      });
      break;
    }
  }
}

async function refreshProcessingState(client, conversationId) {
  const conversation = await stateStore.getConversation(conversationId);
  if (!conversation || !conversation.initialized) return;
  let task = null;
  try {
    const tasks = await client.listSessionCommitTasks(conversation.sessionId, 20);
    task = tasks.slice().sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.created_at || "") || 0;
      const rightTime = Date.parse(right.updated_at || right.created_at || "") || 0;
      return rightTime - leftTime;
    })[0] || null;
  } catch (_error) {
    // Task 列表在部分部署中不可用；继续使用已保存 task_id 和 archive 标记恢复。
  }
  if (!task && conversation.latestTaskId) {
    try {
      task = await client.getTask(conversation.latestTaskId);
    } catch (_error) {
      // 任务已过期、404 或查询接口不可用时继续读取 archive 事实文件。
    }
  }
  let archiveState = {};
  try {
    archiveState = await client.readSessionArchiveState(conversation.sessionId, conversation);
  } catch (error) {
    if (!(error && [404, 405].includes(error.httpStatus))) throw error;
  }
  await stateStore.updateProcessingState(conversationId, task, archiveState);
}

async function flushQueue() {
  if (flushPromise) {
    flushAgain = true;
    return flushPromise;
  }
  flushPromise = (async () => {
    const config = await getConfig();
    if (!config.enabled || !core.isConfigured(config)) return;
    const client = new OpenVikingClient(config);

    await recoverPendingBatches(client, config);
    for (const conversationId of await stateStore.listConversationIds()) {
      const status = await stateStore.getStatus(conversationId);
      const conversation = status.conversation;
      const recentlyObserved = conversation && conversation.lastObservedAt
        && Date.now() - conversation.lastObservedAt < 2 * 60 * 1000;
      const needsServerCheck = conversation && (
        conversation.reconciliationStatus === RECONCILIATION.REQUIRED
        || conversation.pendingBatch
        || status.queuedCount > 0
        || recentlyObserved
        || conversation.initialized
      );
      if (needsServerCheck) await ensureReconciled(client, conversationId, config);
    }
    await uploadAvailableBatches(client, config);
    for (const conversationId of await stateStore.listConversationIds()) {
      try {
        await refreshProcessingState(client, conversationId);
      } catch (error) {
        await stateStore.setError(conversationId, error);
      }
    }
  })();

  try {
    await flushPromise;
  } finally {
    flushPromise = null;
    await updateBadge();
    if (flushAgain) {
      flushAgain = false;
      void flushQueue();
    }
  }
}

async function observeSnapshot(payload, sender) {
  const config = await getConfig();
  if (!core.isConfigured(config)) return { ok: true, status: core.STATUS.NOT_CONFIGURED, added: 0 };
  if (!config.enabled) return { ok: true, status: core.STATUS.DISABLED, added: 0 };

  const conversationId = String(payload.conversationId || "");
  const senderConversationId = sender && sender.tab && sender.tab.url
    ? core.getConversationId(sender.tab.url)
    : conversationId;
  if (!conversationId || senderConversationId && senderConversationId !== conversationId) {
    throw new TypeError("Conversation ID 与当前 ChatGPT 页面不匹配");
  }
  const messages = Array.isArray(payload.messages) ? payload.messages.slice(0, 500) : [];
  const result = await stateStore.observeSnapshot(conversationId, payload.title, {
    completeFromStart: payload.completeFromStart === true,
    messages
  });
  await updateBadge();
  void flushQueue();
  const conversation = await stateStore.getConversation(conversationId);
  return { ok: true, status: conversation && conversation.status || core.STATUS.IDLE, ...result };
}

async function observeLegacyMessages(payload, sender) {
  return observeSnapshot({
    ...payload,
    completeFromStart: true,
    messages: (Array.isArray(payload.messages) ? payload.messages : []).map((message, index) => ({
      ...message,
      turnIndex: Number.isInteger(message.turnIndex) ? message.turnIndex : index + 1,
      createdAt: message.createdAt || new Date().toISOString(),
      timestampPrecision: message.timestampPrecision || "observed",
      stable: message.stable !== false
    }))
  }, sender);
}

async function getStatus(payload) {
  const config = await getConfig();
  const conversationId = payload && payload.conversationId || null;
  const stateStatus = await stateStore.getStatus(conversationId);
  let conversation = stateStatus.conversation ? { ...stateStatus.conversation } : null;
  let status = conversation && conversation.status || core.STATUS.IDLE;
  if (!core.isConfigured(config)) status = core.STATUS.NOT_CONFIGURED;
  else if (!config.enabled) status = core.STATUS.DISABLED;
  return {
    ok: true,
    status,
    configured: core.isConfigured(config),
    enabled: config.enabled,
    requestedAutoCommitPolicy: config.autoCommitPolicy,
    conversationId,
    conversation,
    queuedCount: stateStatus.queuedCount,
    totalQueuedCount: stateStatus.totalQueuedCount
  };
}

async function handleMessage(message, sender) {
  const payload = message && message.payload || {};
  switch (message && message.type) {
    case "OBSERVE_SNAPSHOT":
      return observeSnapshot(payload, sender);
    case "OBSERVE_MESSAGES":
      return observeLegacyMessages(payload, sender);
    case "GET_STATUS":
      return getStatus(payload);
    case "RETRY_NOW":
      await stateStore.retryNow(payload.conversationId || null);
      void flushQueue();
      return { ok: true };
    case "CONFIG_UPDATED":
      void flushQueue();
      await updateBadge();
      return { ok: true };
    case "TEST_CONNECTION": {
      const client = new OpenVikingClient(core.normalizeConfig(payload.config));
      const result = await client.testConnection();
      return { ok: true, result, authMode: client.resolvedAuthMode || payload.config.authMode };
    }
    default:
      throw new TypeError("未知的扩展消息类型");
  }
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      error: core.safeErrorMessage(error),
      code: error && error.code || "EXTENSION_ERROR"
    }));
  return true;
});

function ensureRetryAlarm() {
  extensionApi.alarms.create("openviking-retry", { periodInMinutes: 1 });
}

extensionApi.runtime.onInstalled.addListener(() => {
  ensureRetryAlarm();
  void updateBadge();
});

if (extensionApi.runtime.onStartup) {
  extensionApi.runtime.onStartup.addListener(() => {
    ensureRetryAlarm();
    void flushQueue();
  });
}

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "openviking-retry") void flushQueue();
});

ensureRetryAlarm();
void updateBadge();
void flushQueue();
