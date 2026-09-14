"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/shared/core.js");
const { StateStore, RECONCILIATION } = require("../src/background/state-store.js");

function memoryAdapter(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    data
  };
}

function message(turnIndex, role, overrides) {
  const options = overrides || {};
  return {
    role,
    content: `${role}-${turnIndex}`,
    sourceMessageId: `${role}-${turnIndex}`,
    sourceMessageIdKind: "message-id",
    turnIndex,
    ordinal: turnIndex - 1,
    turnId: options.turnId || `turn-${Math.ceil(turnIndex / 2)}`,
    createdAt: `2026-08-17T${String(Math.min(turnIndex, 23)).padStart(2, "0")}:00:00.000Z`,
    timestampPrecision: "group",
    stable: true,
    ...options
  };
}

function fullTurn(number, startIndex) {
  const turnId = `turn-${number}`;
  return [
    message(startIndex, "user", { turnId }),
    message(startIndex + 1, "assistant", { turnId })
  ];
}

async function observeAndReconcileEmpty(store, conversationId, messages, meta) {
  const observed = await store.observeSnapshot(conversationId, "Title", {
    completeFromStart: true,
    messages
  });
  assert.equal(observed.reconciliationStatus, RECONCILIATION.REQUIRED);
  return store.applyReconciliation(conversationId, [], {
    total_message_count: 0,
    message_count: 0,
    pending_tokens: 0,
    auto_commit_policy: core.DEFAULT_CONFIG.autoCommitPolicy,
    auto_commit_policy_status: "enabled",
    ...meta
  });
}

test("尾部 User 不入队，完整 Turn 才整体入队并完成去重闭环", async () => {
  let now = 1000;
  const store = new StateStore(memoryAdapter(), { now: () => now, random: () => 0.5 });
  const userOnly = await observeAndReconcileEmpty(store, "conversation-a", [message(1, "user", { turnId: "turn-1" })]);
  assert.equal(userOnly.added, 0);
  assert.equal((await store.getConversation("conversation-a")).waitingReason, "turn_incomplete");

  const complete = await store.observeSnapshot("conversation-a", "Title", {
    completeFromStart: true,
    messages: fullTurn(1, 1)
  });
  assert.equal(complete.added, 2);
  const duplicate = await store.observeSnapshot("conversation-a", "Title", {
    completeFromStart: true,
    messages: fullTurn(1, 1).map((item) => ({ ...item, ordinal: item.ordinal + 99 }))
  });
  assert.equal(duplicate.added, 0);

  const batch = await store.claimBatch(50);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].sessionId, "chatgpt_conversation_a");
  await store.beginPendingBatch(batch, 0);
  now += 100;
  await store.confirmBatch(batch, { message_count: 2, total_message_count: 2, pending_tokens: 20 });
  assert.equal((await store.getStatus("conversation-a")).queuedCount, 0);
  assert.equal((await store.getConversation("conversation-a")).status, core.STATUS.PENDING_ARCHIVE);
});

test("相同 ChatGPT source message ID 在不同 Conversation 中使用不同去重空间", async () => {
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  const messages = fullTurn(1, 1);
  assert.equal((await observeAndReconcileEmpty(store, "conversation-a", messages)).added, 2);
  assert.equal((await observeAndReconcileEmpty(store, "conversation-b", messages)).added, 2);
  assert.equal((await store.getStatus(null)).totalQueuedCount, 4);
});

test("失败的完整 Turn 阻塞本 Conversation，但不阻塞其他 Conversation", async () => {
  let now = 1000;
  const store = new StateStore(memoryAdapter(), { now: () => now, random: () => 0 });
  await observeAndReconcileEmpty(store, "conversation-a", fullTurn(1, 1));
  await observeAndReconcileEmpty(store, "conversation-b", fullTurn(1, 1));

  const failedBatch = await store.claimBatch(100);
  assert.equal(failedBatch[0].conversationId, "conversation-a");
  await store.beginPendingBatch(failedBatch, 0);
  await store.fail(failedBatch, Object.assign(new Error("offline"), { retryable: true }), { uncertain: false });

  const available = await store.claimBatch(100);
  assert.equal(available[0].conversationId, "conversation-b");
  await store.releaseClaim(available);
  now += 2000;
  const retried = await store.claimBatch(100);
  assert.equal(retried[0].conversationId, "conversation-a");
  assert.deepEqual(retried.map((item) => item.turnId), ["turn-1", "turn-1"]);
});

test("未稳定的较早 Assistant 阻塞整个 Turn 和后续 Turn", async () => {
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  const partial = [
    message(1, "user", { turnId: "turn-1" }),
    message(2, "assistant", { turnId: "turn-1", stable: false }),
    ...fullTurn(2, 3)
  ];
  const first = await observeAndReconcileEmpty(store, "barrier", partial);
  assert.equal(first.added, 0);
  assert.equal((await store.getStatus("barrier")).queuedCount, 0);

  const completed = await store.observeSnapshot("barrier", "Title", {
    completeFromStart: true,
    messages: partial.map((item) => ({ ...item, stable: true }))
  });
  assert.equal(completed.added, 4);
  const batch = await store.claimBatch(100);
  assert.deepEqual(batch.map((item) => item.turnIndex), [1, 2, 3, 4]);
});

test("turn 跳号与连续 Assistant 使用同一 turn_id 并保持原始顺序", async () => {
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  const turns = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
  const roles = ["user", "assistant", "user", "assistant", "user", "assistant",
    "assistant", "user", "assistant", "user", "assistant"];
  const logicalTurns = [1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5];
  const messages = turns.map((turnIndex, index) => message(turnIndex, roles[index], {
    turnId: `turn-${logicalTurns[index]}`
  }));

  const result = await observeAndReconcileEmpty(store, "chatgpt-gap", messages);
  assert.equal(result.added, messages.length);
  const batch = await store.claimBatch(100);
  assert.deepEqual(batch.map((item) => item.turnIndex), turns);
  assert.deepEqual(batch.filter((item) => item.turnId === "turn-3").map((item) => item.role), [
    "user", "assistant", "assistant"
  ]);
});

test("领取批次不会按软上限拆分逻辑 Turn，单 Turn 超过 100 条则明确失败", async () => {
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  const largeTurn = [message(1, "user", { turnId: "turn-large" })];
  for (let index = 2; index <= 60; index += 1) {
    largeTurn.push(message(index, "assistant", { turnId: "turn-large" }));
  }
  await observeAndReconcileEmpty(store, "large", largeTurn);
  assert.equal((await store.claimBatch(50)).length, 60);

  const oversized = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  const tooLarge = [message(1, "user", { turnId: "turn-too-large" })];
  for (let index = 2; index <= 101; index += 1) {
    tooLarge.push(message(index, "assistant", { turnId: "turn-too-large" }));
  }
  await observeAndReconcileEmpty(oversized, "too-large", tooLarge);
  assert.deepEqual(await oversized.claimBatch(100), []);
  assert.match((await oversized.getConversation("too-large")).lastError, /超过 OpenViking 单批 100 条/);
});

test("POST 结果未知时通过服务端完整日志确认，不会重复入队", async () => {
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  const messages = fullTurn(1, 1);
  await observeAndReconcileEmpty(store, "recovery", messages);
  const batch = await store.claimBatch(100);
  await store.beginPendingBatch(batch, 0);

  const reconciled = await store.applyReconciliation("recovery", messages, {
    total_message_count: 2,
    message_count: 2,
    pending_tokens: 30,
    auto_commit_policy: core.DEFAULT_CONFIG.autoCommitPolicy,
    auto_commit_policy_status: "enabled"
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.confirmed, 2);
  assert.equal((await store.getStatus("recovery")).queuedCount, 0);
  assert.equal((await store.getConversation("recovery")).pendingBatch, null);
});

test("服务端重复来源 ID 或 JSONL 累计总量不一致会进入冲突状态", async () => {
  const local = fullTurn(1, 1);
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  await store.observeSnapshot("bad", "Title", { completeFromStart: true, messages: local });
  const duplicate = await store.applyReconciliation("bad", [local[0], local[0]], {
    total_message_count: 2,
    message_count: 2
  });
  assert.equal(duplicate.conflict, true);
  assert.equal((await store.getConversation("bad")).status, core.STATUS.CONFLICT);

  const second = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  await second.observeSnapshot("incomplete", "Title", { completeFromStart: true, messages: local });
  const mismatch = await second.applyReconciliation("incomplete", [local[0]], {
    total_message_count: 2,
    message_count: 1
  });
  assert.equal(mismatch.conflict, true);
  assert.equal((await second.getConversation("incomplete")).reconciliationReason, "server_log_incomplete");
});

test("不启用消息 Peer 时，对账兼容并忽略历史 peer_id", async () => {
  const local = fullTurn(1, 1);
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  await store.observeSnapshot("peer-old", "Title", { completeFromStart: true, messages: local });
  const legacyRecords = local.map((item) => ({
    ...item,
    peerId: item.role === "assistant" ? "chatgpt_Web" : ""
  }));
  const oldResult = await store.applyReconciliation("peer-old", legacyRecords, {
    total_message_count: 2,
    message_count: 2
  });
  assert.equal(oldResult.ok, true);
  assert.equal(Object.hasOwn(await store.getConversation("peer-old"), "peerHistoryIncomplete"), false);

  const otherStore = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  await otherStore.observeSnapshot("peer-other", "Title", { completeFromStart: true, messages: local });
  const records = local.map((item) => ({ ...item, peerId: "another-peer" }));
  const result = await otherStore.applyReconciliation("peer-other", records, {
    total_message_count: 2,
    message_count: 2
  });
  assert.equal(result.ok, true);
  assert.equal((await otherStore.getConversation("peer-other")).reconciliationStatus, RECONCILIATION.CLEAN);
});

test("服务端策略、Task 与 Archive 状态可恢复并展示 Phase 1/Phase 2/完成/失败", async () => {
  let now = 1000;
  const store = new StateStore(memoryAdapter(), { now: () => now, random: () => 0.5 });
  await observeAndReconcileEmpty(store, "processing", fullTurn(1, 1), {
    auto_commit_policy_status: "enabled",
    commit_count: 3,
    memories_extracted: 2
  });
  await store.updateProcessingState("processing", { id: "task-1", status: "running" }, {
    archiveStatus: "archived",
    archiveUri: "viking://session/chatgpt_processing/history/archive_001"
  });
  let conversation = await store.getConversation("processing");
  assert.equal(conversation.status, core.STATUS.PHASE1_ARCHIVED);
  assert.equal(conversation.commitCount, 3);

  now += 100;
  await store.updateProcessingState("processing", { id: "task-1", status: "running" }, {
    archiveStatus: "processing",
    memoryDiffUri: "viking://session/chatgpt_processing/history/archive_001/memory_diff.json",
    memoryCounts: { preference: 2, entity: 1 }
  });
  conversation = await store.getConversation("processing");
  assert.equal(conversation.status, core.STATUS.MEMORY_PROCESSING);
  assert.equal(conversation.memoriesExtracted, 3);

  await store.updateProcessingState("processing", { id: "task-1", status: "completed" }, {
    archiveStatus: "done"
  });
  assert.equal((await store.getConversation("processing")).status, core.STATUS.MEMORY_COMPLETE);

  await store.updateProcessingState("processing", { id: "task-2", status: "failed", error: { message: "boom" } }, {});
  conversation = await store.getConversation("processing");
  assert.equal(conversation.status, core.STATUS.ERROR);
  assert.equal(conversation.lastError, "boom");
});

test("策略为空或不一致时显示自动整理未启用", async () => {
  const store = new StateStore(memoryAdapter(), { now: () => 1000, random: () => 0.5 });
  await store.observeSnapshot("policy", "Title", { completeFromStart: true, messages: fullTurn(1, 1) });
  await store.applyReconciliation("policy", [], {
    total_message_count: 0,
    message_count: 0,
    auto_commit_policy: null,
    auto_commit_policy_status: "missing",
    auto_commit_policy_error: "PATCH unsupported"
  });
  const batch = await store.claimBatch(100);
  await store.beginPendingBatch(batch, 0);
  await store.confirmBatch(batch, { message_count: 2 });
  assert.equal((await store.getConversation("policy")).status, core.STATUS.POLICY_DISABLED);
});

test("V2 迁移丢弃可能拆 Turn 的旧队列并要求重新对账", async () => {
  const adapter = memoryAdapter({
    [core.STATE_KEY]: {
      version: 2,
      queue: [{
        conversationId: "legacy-v2", role: "user", content: "partial",
        sourceMessageId: "u1", turnIndex: 1, turnId: "turn-1"
      }],
      conversations: {
        "legacy-v2": {
          sessionId: "chatgpt_legacy_v2",
          reconciliationStatus: "clean",
          pendingCommit: { keepRecentCount: 2 }
        }
      }
    }
  });
  const store = new StateStore(adapter, { now: () => 1000, random: () => 0.5 });
  assert.equal((await store.getStatus(null)).totalQueuedCount, 0);
  const conversation = await store.getConversation("legacy-v2");
  assert.equal(conversation.reconciliationStatus, RECONCILIATION.REQUIRED);
  assert.equal(Object.hasOwn(conversation, "pendingCommit"), false);
});

test("V4 撤销 Peer 模式时保留队列并解除旧 Peer 冲突", async () => {
  const adapter = memoryAdapter({
    [core.STATE_KEY]: {
      version: 4,
      queue: [{
        conversationId: "legacy-v3", role: "user", content: "hello",
        sourceMessageId: "u1", turnIndex: 1, turnId: "turn-1",
        createdAt: "2026-08-17T01:00:00.000Z"
      }],
      conversations: {
        "legacy-v3": {
          sessionId: "chatgpt_legacy_v3",
          reconciliationStatus: "conflict",
          reconciliationReason: "message_peer_conflict",
          status: core.STATUS.CONFLICT,
          lastError: "peer mismatch",
          peerHistoryIncomplete: true
        }
      }
    }
  });
  const store = new StateStore(adapter, { now: () => 1000, random: () => 0.5 });
  assert.equal((await store.getStatus(null)).totalQueuedCount, 1);
  const conversation = await store.getConversation("legacy-v3");
  assert.equal(conversation.reconciliationStatus, RECONCILIATION.REQUIRED);
  assert.equal(conversation.reconciliationReason, "v4_peer_removal_migration");
  assert.equal(conversation.lastError, "");
  assert.equal(Object.hasOwn(conversation, "peerHistoryIncomplete"), false);
});

test("V1 状态迁移不信任旧指纹，必须重新与服务端对账", async () => {
  const adapter = memoryAdapter({
    [core.STATE_KEY]: {
      version: 1,
      queue: [],
      conversations: {
        legacy: { sessionId: "chatgpt_legacy", initialized: true, synced: ["old-fingerprint"] }
      }
    }
  });
  const store = new StateStore(adapter, { now: () => 1000, random: () => 0.5 });
  const conversation = await store.getConversation("legacy");
  assert.equal(conversation.reconciliationStatus, RECONCILIATION.REQUIRED);
  assert.deepEqual(conversation.confirmedSourceIds, []);
});
