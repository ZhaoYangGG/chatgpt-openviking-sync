(function initStateStore(root, factory) {
  const core = root.OpenVikingSyncCore || (typeof require === "function" ? require("../shared/core.js") : null);
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OpenVikingStateStoreModule = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function stateStoreFactory(core) {
  "use strict";

  const RECONCILIATION = Object.freeze({
    REQUIRED: "required",
    CLEAN: "clean",
    CONFLICT: "conflict"
  });

  function emptyState() {
    return {
      version: core.STATE_VERSION,
      queue: [],
      conversations: {},
      updatedAt: Date.now()
    };
  }

  function emptyConversation(conversationId) {
    return {
      sessionId: core.buildSessionId(conversationId),
      title: "",
      initialized: false,
      confirmedSourceIds: [],
      confirmedMessages: {},
      confirmedTurnCursor: 0,
      expectedTotalMessageCount: null,
      reconciliationStatus: RECONCILIATION.REQUIRED,
      reconciliationReason: "initial",
      pendingBatch: null,
      latestSnapshot: null,
      status: core.STATUS.WAITING_HISTORY,
      waitingReason: "",
      lastError: "",
      lastSyncedAt: 0,
      lastObservedAt: 0,
      lastActivityAt: 0,
      lastServerCheckAt: 0,
      pendingTokens: 0,
      liveMessageCount: 0,
      totalMessageCount: 0,
      commitCount: 0,
      memoriesExtracted: 0,
      memoryCounts: {},
      effectiveAutoCommitPolicy: null,
      autoCommitPolicyStatus: "unknown",
      autoCommitPolicyError: "",
      latestTaskId: "",
      latestTaskStatus: "",
      latestTaskStage: "",
      latestTaskError: "",
      latestArchiveUri: "",
      memoryDiffUri: "",
      archiveStatus: "none",
      lastCommitAt: 0,
      lastArchivedAt: 0,
      lastCommitTaskId: ""
    };
  }

  function integerOr(value, fallback) {
    return Number.isInteger(value) ? value : fallback;
  }

  function messageContentHash(message) {
    return core.hashString(`${message.role}\u0000${core.normalizeMessageContent(message.content)}`);
  }

  function normalizeSnapshotMessage(message) {
    const role = message && message.role;
    const content = core.normalizeMessageContent(message && message.content);
    const sourceMessageId = String(message && message.sourceMessageId || "").trim();
    const turnIndex = Number.parseInt(message && message.turnIndex, 10);
    if (!content || !["user", "assistant"].includes(role)) return null;
    return {
      role,
      content,
      sourceMessageId,
      sourceMessageIdKind: String(message && message.sourceMessageIdKind || ""),
      turnIndex: Number.isInteger(turnIndex) && turnIndex > 0 ? turnIndex : null,
      ordinal: integerOr(message && message.ordinal, -1),
      turnId: String(message && message.turnId || ""),
      createdAt: core.isIsoTimestamp(message && message.createdAt) ? message.createdAt : "",
      timestampPrecision: String(message && message.timestampPrecision || ""),
      stable: message && message.stable === true,
      identityConflict: message && message.identityConflict === true,
      historical: message && message.historical === true
    };
  }

  function normalizeSnapshot(value) {
    if (!value || typeof value !== "object") return null;
    const messages = (Array.isArray(value.messages) ? value.messages : [])
      .map(normalizeSnapshotMessage)
      .filter(Boolean)
      .sort((left, right) => (left.turnIndex || Number.MAX_SAFE_INTEGER)
        - (right.turnIndex || Number.MAX_SAFE_INTEGER)
        || left.ordinal - right.ordinal);
    return {
      completeFromStart: value.completeFromStart === true,
      observedAt: Number(value.observedAt) || Date.now(),
      messages
    };
  }

  function snapshotSignature(snapshot) {
    if (!snapshot) return "";
    return snapshot.messages.map((message) => [
      message.sourceMessageId,
      message.role,
      message.turnIndex,
      message.content,
      message.stable
    ].join("\u0000")).join("\u0001");
  }

  function normalizeConfirmedMessages(value) {
    if (!value || typeof value !== "object") return {};
    const result = {};
    for (const [sourceMessageId, record] of Object.entries(value)) {
      if (!sourceMessageId || !record || typeof record !== "object") continue;
      result[sourceMessageId] = {
        role: ["user", "assistant"].includes(record.role) ? record.role : "",
        contentHash: String(record.contentHash || ""),
        turnIndex: integerOr(record.turnIndex, 0),
        createdAt: String(record.createdAt || ""),
        turnId: String(record.turnId || ""),
        peerId: String(record.peerId || "")
      };
    }
    return result;
  }

  function normalizeConversation(conversationId, value) {
    const base = emptyConversation(conversationId);
    const input = value && typeof value === "object" ? value : {};
    const normalized = {
      ...base,
      ...input,
      sessionId: String(input.sessionId || base.sessionId),
      title: String(input.title || "").slice(0, 300),
      initialized: input.initialized === true,
      confirmedSourceIds: Array.isArray(input.confirmedSourceIds)
        ? input.confirmedSourceIds.map(String).filter(Boolean)
        : [],
      confirmedMessages: normalizeConfirmedMessages(input.confirmedMessages),
      confirmedTurnCursor: Math.max(0, integerOr(input.confirmedTurnCursor, 0)),
      expectedTotalMessageCount: Number.isInteger(input.expectedTotalMessageCount)
        ? Math.max(0, input.expectedTotalMessageCount)
        : null,
      reconciliationStatus: Object.values(RECONCILIATION).includes(input.reconciliationStatus)
        ? input.reconciliationStatus
        : RECONCILIATION.REQUIRED,
      pendingBatch: input.pendingBatch && typeof input.pendingBatch === "object"
        ? { ...input.pendingBatch }
        : null,
      latestSnapshot: normalizeSnapshot(input.latestSnapshot),
      pendingTokens: Math.max(0, Number(input.pendingTokens) || 0),
      liveMessageCount: Math.max(0, Number(input.liveMessageCount) || 0),
      totalMessageCount: Math.max(0, Number(input.totalMessageCount) || 0),
      commitCount: Math.max(0, Number(input.commitCount) || 0),
      memoriesExtracted: Math.max(0, Number(input.memoriesExtracted) || 0),
      memoryCounts: input.memoryCounts && typeof input.memoryCounts === "object"
        ? { ...input.memoryCounts }
        : {},
      effectiveAutoCommitPolicy: input.effectiveAutoCommitPolicy
        && typeof input.effectiveAutoCommitPolicy === "object"
        ? { ...input.effectiveAutoCommitPolicy }
        : null
    };
    delete normalized.pendingCommit;
    delete normalized.peerHistoryIncomplete;
    return normalized;
  }

  function normalizeQueueItem(item) {
    if (!item || typeof item !== "object") return null;
    const conversationId = String(item.conversationId || "");
    const sourceMessageId = String(item.sourceMessageId || "");
    if (!conversationId || !sourceMessageId) return null;
    const role = item.role === "assistant" ? "assistant" : "user";
    const content = core.normalizeMessageContent(item.content);
    if (!content) return null;
    const turnIndex = Number.parseInt(item.turnIndex, 10);
    const fingerprint = core.createMessageFingerprint({ sourceMessageId }, conversationId);
    return {
      id: `${conversationId}:${fingerprint}`,
      conversationId,
      sessionId: String(item.sessionId || core.buildSessionId(conversationId)),
      fingerprint,
      role,
      content,
      sourceMessageId,
      sourceMessageIdKind: String(item.sourceMessageIdKind || ""),
      turnIndex: Number.isInteger(turnIndex) && turnIndex > 0 ? turnIndex : Math.max(1, integerOr(item.ordinal, 0) + 1),
      ordinal: integerOr(item.ordinal, -1),
      turnId: String(item.turnId || ""),
      createdAt: core.isIsoTimestamp(item.createdAt) ? item.createdAt : "",
      timestampPrecision: String(item.timestampPrecision || ""),
      status: item.status === "uploading" ? "uploading" : "pending",
      attempts: Math.max(0, Number(item.attempts) || 0),
      nextAttemptAt: Math.max(0, Number(item.nextAttemptAt) || 0),
      queuedAt: Math.max(0, Number(item.queuedAt) || Date.now()),
      inflightAt: Math.max(0, Number(item.inflightAt) || 0)
    };
  }

  function migrateV1(value) {
    const state = emptyState();
    const inputConversations = value && value.conversations && typeof value.conversations === "object"
      ? value.conversations
      : {};
    for (const [conversationId, oldConversation] of Object.entries(inputConversations)) {
      const conversation = emptyConversation(conversationId);
      conversation.sessionId = String(oldConversation && oldConversation.sessionId || conversation.sessionId);
      conversation.title = String(oldConversation && oldConversation.title || "").slice(0, 300);
      conversation.initialized = oldConversation && oldConversation.initialized === true;
      conversation.reconciliationReason = "v1_migration";
      conversation.lastObservedAt = Number(oldConversation && oldConversation.lastObservedAt) || 0;
      conversation.lastSyncedAt = Number(oldConversation && oldConversation.lastSyncedAt) || 0;
      state.conversations[conversationId] = conversation;
    }

    const seen = new Set();
    for (const oldItem of Array.isArray(value && value.queue) ? value.queue : []) {
      const normalized = normalizeQueueItem({
        ...oldItem,
        turnIndex: Number.isInteger(oldItem.ordinal) ? oldItem.ordinal + 1 : null,
        status: "pending",
        inflightAt: 0
      });
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      state.queue.push(normalized);
      if (!state.conversations[normalized.conversationId]) {
        state.conversations[normalized.conversationId] = emptyConversation(normalized.conversationId);
        state.conversations[normalized.conversationId].reconciliationReason = "v1_migration";
      }
    }
    return state;
  }

  function migrateV2(value) {
    const state = emptyState();
    const inputConversations = value && value.conversations && typeof value.conversations === "object"
      ? value.conversations
      : {};
    for (const [conversationId, oldConversation] of Object.entries(inputConversations)) {
      const conversation = normalizeConversation(conversationId, oldConversation);
      conversation.pendingBatch = null;
      conversation.reconciliationStatus = RECONCILIATION.REQUIRED;
      conversation.reconciliationReason = "v2_turn_queue_migration";
      conversation.status = core.STATUS.WAITING_HISTORY;
      state.conversations[conversationId] = conversation;
    }
    // V2 可能持久化了未完成的单条 User；丢弃旧队列并从最新 DOM 快照按完整 Turn 重建。
    return state;
  }

  function migratePeerState(value, sourceVersion) {
    const state = emptyState();
    const inputConversations = value && value.conversations && typeof value.conversations === "object"
      ? value.conversations
      : {};
    for (const [conversationId, oldConversation] of Object.entries(inputConversations)) {
      const conversation = normalizeConversation(conversationId, oldConversation);
      if (conversation.reconciliationStatus === RECONCILIATION.CONFLICT
        && ["assistant_peer_conflict", "message_peer_conflict"].includes(conversation.reconciliationReason)) {
        conversation.reconciliationStatus = RECONCILIATION.REQUIRED;
        conversation.reconciliationReason = `v${sourceVersion}_peer_removal_migration`;
        conversation.status = core.STATUS.WAITING_HISTORY;
        conversation.lastError = "";
      }
      state.conversations[conversationId] = conversation;
    }
    const seen = new Set();
    for (const item of Array.isArray(value && value.queue) ? value.queue : []) {
      const normalized = normalizeQueueItem(item);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      state.queue.push(normalized);
    }
    state.updatedAt = Number(value && value.updatedAt) || Date.now();
    return state;
  }

  function normalizeState(value) {
    if (!value || typeof value !== "object") return emptyState();
    if (value.version === 1) return migrateV1(value);
    if (value.version === 2) return migrateV2(value);
    if (value.version === 3 || value.version === 4) return migratePeerState(value, value.version);
    if (value.version !== core.STATE_VERSION) return emptyState();
    const state = emptyState();
    for (const [conversationId, conversation] of Object.entries(
      value.conversations && typeof value.conversations === "object" ? value.conversations : {}
    )) {
      state.conversations[conversationId] = normalizeConversation(conversationId, conversation);
    }
    const seen = new Set();
    for (const item of Array.isArray(value.queue) ? value.queue : []) {
      const normalized = normalizeQueueItem(item);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      state.queue.push(normalized);
    }
    state.updatedAt = Number(value.updatedAt) || Date.now();
    return state;
  }

  function ensureConversation(state, conversationId, metadata) {
    if (!state.conversations[conversationId]) {
      state.conversations[conversationId] = emptyConversation(conversationId);
    } else {
      state.conversations[conversationId] = normalizeConversation(
        conversationId,
        state.conversations[conversationId]
      );
    }
    const conversation = state.conversations[conversationId];
    if (metadata && metadata.title) conversation.title = String(metadata.title).slice(0, 300);
    return conversation;
  }

  function setConflict(conversation, reason, message) {
    conversation.reconciliationStatus = RECONCILIATION.CONFLICT;
    conversation.reconciliationReason = String(reason || "order_conflict");
    conversation.status = core.STATUS.CONFLICT;
    conversation.lastError = String(message || "服务端消息不是当前 ChatGPT 会话的正确前缀，已暂停同步。");
    conversation.pendingBatch = null;
  }

  function queueForConversation(state, conversationId) {
    return state.queue
      .filter((item) => item.conversationId === conversationId)
      .sort((left, right) => left.turnIndex - right.turnIndex || left.queuedAt - right.queuedAt);
  }

  function validateKnownMessage(conversation, queuedBySource, message) {
    const confirmed = conversation.confirmedMessages[message.sourceMessageId];
    const queued = queuedBySource.get(message.sourceMessageId);
    const known = queued || confirmed;
    if (!known) return true;
    if (known.role && known.role !== message.role) return false;
    const knownHash = queued ? messageContentHash(queued) : confirmed.contentHash;
    if (knownHash && knownHash !== messageContentHash(message)) return false;
    if (known.turnIndex && known.turnIndex !== message.turnIndex) return false;
    return true;
  }

  function groupMessagesByTurn(messages) {
    const groups = [];
    for (const message of messages) {
      const turnId = String(message.turnId || "");
      const current = groups[groups.length - 1];
      if (!current || current.turnId !== turnId) {
        groups.push({ turnId, messages: [message] });
      } else {
        current.messages.push(message);
      }
    }
    return groups;
  }

  function completeTurn(group) {
    if (!group || !group.turnId || !group.messages.length) return false;
    if (group.messages[0].role !== "user") return false;
    if (group.messages.length < 2) return false;
    return group.messages.slice(1).every((message) => message.role === "assistant");
  }

  function timestampValue(value) {
    if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function applySessionMeta(conversation, sessionMeta, now) {
    const meta = sessionMeta && typeof sessionMeta === "object" ? sessionMeta : {};
    if (Object.prototype.hasOwnProperty.call(meta, "pending_tokens")) {
      conversation.pendingTokens = Math.max(0, Number(meta.pending_tokens) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(meta, "message_count")) {
      conversation.liveMessageCount = Math.max(0, Number(meta.message_count) || 0);
    }
    if (Number.isInteger(meta.total_message_count) && meta.total_message_count >= 0) {
      conversation.totalMessageCount = meta.total_message_count;
    }
    if (Object.prototype.hasOwnProperty.call(meta, "commit_count")) {
      conversation.commitCount = Math.max(0, Number(meta.commit_count) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(meta, "memories_extracted")) {
      conversation.memoriesExtracted = Math.max(0, Number(meta.memories_extracted) || 0);
    }
    conversation.lastCommitAt = timestampValue(meta.last_commit_at) || conversation.lastCommitAt;
    if (Object.prototype.hasOwnProperty.call(meta, "auto_commit_policy")) {
      conversation.effectiveAutoCommitPolicy = meta.auto_commit_policy
        && typeof meta.auto_commit_policy === "object" ? { ...meta.auto_commit_policy } : null;
    }
    if (meta.auto_commit_policy_status) {
      conversation.autoCommitPolicyStatus = String(meta.auto_commit_policy_status);
    }
    if (Object.prototype.hasOwnProperty.call(meta, "auto_commit_policy_error")) {
      conversation.autoCommitPolicyError = String(meta.auto_commit_policy_error || "");
    }
    conversation.lastServerCheckAt = now;
  }

  function autoPolicyUnavailable(conversation) {
    return ["disabled", "missing", "mismatch"].includes(conversation.autoCommitPolicyStatus);
  }

  function prepareSnapshotInState(state, conversationId, now) {
    const conversation = ensureConversation(state, conversationId);
    const snapshot = conversation.latestSnapshot;
    if (!snapshot || !snapshot.messages.length) return { added: 0, blocked: "empty_snapshot" };
    if (conversation.reconciliationStatus !== RECONCILIATION.CLEAN) {
      return { added: 0, blocked: conversation.reconciliationStatus };
    }

    const messages = snapshot.messages;
    const sourceSeen = new Set();
    const turnSeen = new Map();
    for (const message of messages) {
      if (message.identityConflict) {
        setConflict(conversation, "duplicate_source_id", "页面中同一 ChatGPT 消息 ID 对应了不同内容，已暂停同步。");
        return { added: 0, blocked: "conflict" };
      }
      if (!message.sourceMessageId || !message.turnIndex) continue;
      if (sourceSeen.has(message.sourceMessageId)) continue;
      sourceSeen.add(message.sourceMessageId);
      const turnSource = turnSeen.get(message.turnIndex);
      if (turnSource && turnSource !== message.sourceMessageId) {
        setConflict(conversation, "duplicate_turn_index", "页面中同一 Conversation turn 出现多个不同消息，已暂停同步。");
        return { added: 0, blocked: "conflict" };
      }
      turnSeen.set(message.turnIndex, message.sourceMessageId);
    }

    const queued = queueForConversation(state, conversationId);
    const queuedBySource = new Map(queued.map((item) => [item.sourceMessageId, item]));
    for (const message of messages) {
      if (!message.sourceMessageId || !validateKnownMessage(conversation, queuedBySource, message)) {
        if (message.sourceMessageId) {
          setConflict(conversation, "source_content_changed", "已确认的 ChatGPT 消息 ID 对应内容发生变化，已暂停同步。");
          return { added: 0, blocked: "conflict" };
        }
      }
    }

    const knownIds = [...conversation.confirmedSourceIds, ...queued.map((item) => item.sourceMessageId)];
    const lastKnownId = knownIds[knownIds.length - 1] || "";
    let startIndex = 0;
    let previousTurnIndex = 0;
    if (!lastKnownId) {
      if (!snapshot.completeFromStart || messages[0].turnIndex !== 1 || messages[0].role !== "user") {
        conversation.status = core.STATUS.WAITING_HISTORY;
        conversation.waitingReason = "history_start_missing";
        return { added: 0, blocked: "history_start_missing" };
      }
    } else {
      const anchorIndex = messages.findIndex((message) => message.sourceMessageId === lastKnownId);
      if (anchorIndex >= 0) {
        startIndex = anchorIndex + 1;
        previousTurnIndex = messages[anchorIndex].turnIndex;
      } else if (snapshot.completeFromStart && knownIds.length <= messages.length
        && knownIds.every((sourceId, index) => messages[index].sourceMessageId === sourceId)) {
        startIndex = knownIds.length;
        previousTurnIndex = startIndex ? messages[startIndex - 1].turnIndex : 0;
      } else {
        conversation.status = core.STATUS.WAITING_HISTORY;
        conversation.waitingReason = "known_anchor_not_visible";
        return { added: 0, blocked: "known_anchor_not_visible" };
      }
    }

    let added = 0;
    let blocked = "";
    const remainingGroups = groupMessagesByTurn(messages.slice(startIndex));
    for (const group of remainingGroups) {
      const priorSameTurnConfirmed = startIndex > 0
        && messages[startIndex - 1].turnId
        && messages[startIndex - 1].turnId === group.turnId;
      const complete = completeTurn(group) || priorSameTurnConfirmed
        && group.messages.every((message) => message.role === "assistant");
      if (!complete) {
        conversation.status = core.STATUS.WAITING_HISTORY;
        conversation.waitingReason = group.messages.some((message) => !message.stable)
          ? "earlier_message_unstable"
          : "turn_incomplete";
        blocked = conversation.waitingReason;
        break;
      }
      for (const message of group.messages) {
        if (!message.sourceMessageId || !message.turnIndex) {
          conversation.status = core.STATUS.WAITING_HISTORY;
          conversation.waitingReason = "stable_id_missing";
          blocked = conversation.waitingReason;
          break;
        }
        if (message.turnIndex <= previousTurnIndex) {
          conversation.status = core.STATUS.WAITING_HISTORY;
          conversation.waitingReason = "turn_order_invalid";
          blocked = conversation.waitingReason;
          break;
        }
        if (!message.stable) {
          conversation.status = core.STATUS.WAITING_HISTORY;
          conversation.waitingReason = message.timestampPrecision === "missing" || message.timestampPrecision === "unparsed"
            ? "history_timestamp_missing"
            : "earlier_message_unstable";
          blocked = conversation.waitingReason;
          break;
        }
        if (!message.createdAt) {
          conversation.status = core.STATUS.WAITING_HISTORY;
          conversation.waitingReason = "history_timestamp_missing";
          blocked = conversation.waitingReason;
          break;
        }
        previousTurnIndex = message.turnIndex;
      }
      if (blocked) break;
      for (const message of group.messages) {
        const existing = queuedBySource.get(message.sourceMessageId);
        if (existing) {
          existing.createdAt = message.createdAt;
          existing.timestampPrecision = message.timestampPrecision;
          existing.turnId = message.turnId;
          existing.turnIndex = message.turnIndex;
        } else if (!conversation.confirmedSourceIds.includes(message.sourceMessageId)) {
          const fingerprint = core.createMessageFingerprint(message, conversationId);
          const item = {
            id: `${conversationId}:${fingerprint}`,
            conversationId,
            sessionId: conversation.sessionId,
            fingerprint,
            role: message.role,
            content: message.content,
            sourceMessageId: message.sourceMessageId,
            sourceMessageIdKind: message.sourceMessageIdKind,
            turnIndex: message.turnIndex,
            ordinal: message.ordinal,
            turnId: message.turnId,
            createdAt: message.createdAt,
            timestampPrecision: message.timestampPrecision,
            status: "pending",
            attempts: 0,
            nextAttemptAt: now,
            queuedAt: now,
            inflightAt: 0
          };
          state.queue.push(item);
          queuedBySource.set(item.sourceMessageId, item);
          added += 1;
        }
      }
    }

    if (blocked) return { added, blocked };
    conversation.waitingReason = "";
    if (queueForConversation(state, conversationId).length) {
      conversation.status = core.STATUS.QUEUED;
      conversation.lastError = "";
    } else if (autoPolicyUnavailable(conversation)) {
      conversation.status = core.STATUS.POLICY_DISABLED;
    } else if (conversation.liveMessageCount > 0) {
      conversation.status = core.STATUS.PENDING_ARCHIVE;
    } else {
      conversation.status = core.STATUS.SYNCED;
    }
    return { added, blocked: "" };
  }

  class StateStore {
    constructor(adapter, dependencies) {
      this.adapter = adapter;
      this.now = dependencies && dependencies.now || (() => Date.now());
      this.random = dependencies && dependencies.random || Math.random;
      this.lock = Promise.resolve();
    }

    transaction(mutator) {
      const operation = this.lock.then(async () => {
        const stored = await this.adapter.get(core.STATE_KEY);
        const state = normalizeState(stored);
        const result = await mutator(state);
        state.updatedAt = this.now();
        await this.adapter.set(core.STATE_KEY, state);
        return result;
      });
      this.lock = operation.catch(() => undefined);
      return operation;
    }

    async read() {
      await this.lock;
      return normalizeState(await this.adapter.get(core.STATE_KEY));
    }

    observeSnapshot(conversationId, title, snapshotValue) {
      return this.transaction((state) => {
        const now = this.now();
        const conversation = ensureConversation(state, conversationId, { title });
        const snapshot = normalizeSnapshot({ ...snapshotValue, observedAt: now });
        if (snapshotSignature(snapshot) !== snapshotSignature(conversation.latestSnapshot)) {
          conversation.lastActivityAt = now;
        }
        conversation.latestSnapshot = snapshot;
        conversation.lastObservedAt = now;
        if (!snapshot || !snapshot.messages.length) return { added: 0, queued: 0, blocked: "empty_snapshot" };
        const result = prepareSnapshotInState(state, conversationId, now);
        return {
          ...result,
          queued: queueForConversation(state, conversationId).length,
          reconciliationStatus: conversation.reconciliationStatus
        };
      });
    }

    enqueue(conversationId, title, messages) {
      const nowIso = new Date(this.now()).toISOString();
      let logicalTurn = 0;
      return this.observeSnapshot(conversationId, title, {
        completeFromStart: true,
        messages: messages.map((message, index) => {
          if (message.role === "user" || logicalTurn === 0) logicalTurn += 1;
          return {
            ...message,
            turnIndex: Number.isInteger(message.turnIndex)
              ? message.turnIndex
              : Number.isInteger(message.ordinal) ? message.ordinal + 1 : index + 1,
            turnId: message.turnId || `turn-${logicalTurn}`,
            createdAt: message.createdAt || nowIso,
            timestampPrecision: message.timestampPrecision || "observed",
            stable: message.stable !== false
          };
        })
      });
    }

    prepareSnapshot(conversationId) {
      return this.transaction((state) => prepareSnapshotInState(state, conversationId, this.now()));
    }

    listConversationIds() {
      return this.read().then((state) => Object.keys(state.conversations));
    }

    setInitialized(conversationId, initialized, sessionMeta) {
      return this.transaction((state) => {
        const conversation = ensureConversation(state, conversationId);
        conversation.initialized = Boolean(initialized);
        if (sessionMeta) {
          applySessionMeta(conversation, sessionMeta, this.now());
        }
      });
    }

    markReconciliationRequired(conversationId, reason) {
      return this.transaction((state) => {
        const conversation = ensureConversation(state, conversationId);
        conversation.reconciliationStatus = RECONCILIATION.REQUIRED;
        conversation.reconciliationReason = String(reason || "watermark_mismatch");
        if (conversation.status !== core.STATUS.ERROR) conversation.status = core.STATUS.WAITING_HISTORY;
      });
    }

    applyReconciliation(conversationId, serverMessages, sessionMeta) {
      return this.transaction((state) => {
        const conversation = ensureConversation(state, conversationId);
        const records = Array.isArray(serverMessages) ? serverMessages : [];
        const snapshot = conversation.latestSnapshot;
        const snapshotBySource = new Map(
          snapshot ? snapshot.messages.filter((message) => message.sourceMessageId)
            .map((message) => [message.sourceMessageId, message]) : []
        );
        const serverSeen = new Set();
        for (const record of records) {
          if (!record || !record.sourceMessageId) {
            setConflict(conversation, "missing_source_message_id", "服务端 Session 含有无法识别来源的消息，已暂停自动追加。");
            return { ok: false, conflict: true };
          }
          if (serverSeen.has(record.sourceMessageId)) {
            setConflict(conversation, "duplicate_server_source_id", "服务端 Session 已存在重复 ChatGPT 消息，需手动重建后再同步。");
            return { ok: false, conflict: true };
          }
          serverSeen.add(record.sourceMessageId);
          const local = snapshotBySource.get(record.sourceMessageId);
          if (local && (local.role !== record.role || messageContentHash(local) !== messageContentHash(record))) {
            setConflict(conversation, "server_content_mismatch", "服务端与 ChatGPT 中同一消息 ID 的正文不一致，已暂停同步。");
            return { ok: false, conflict: true };
          }
        }

        if (snapshot && snapshot.completeFromStart) {
          const comparable = Math.min(records.length, snapshot.messages.length);
          for (let index = 0; index < comparable; index += 1) {
            if (records[index].sourceMessageId !== snapshot.messages[index].sourceMessageId) {
              setConflict(conversation, "server_order_conflict", "服务端消息顺序不是当前 ChatGPT 历史的正确前缀，已暂停同步。");
              return { ok: false, conflict: true };
            }
          }
        } else {
          let previousTurnIndex = 0;
          for (const record of records) {
            const local = snapshotBySource.get(record.sourceMessageId);
            if (!local) continue;
            if (local.turnIndex <= previousTurnIndex) {
              setConflict(conversation, "server_order_conflict", "服务端可见消息顺序与 ChatGPT DOM 顺序冲突，已暂停同步。");
              return { ok: false, conflict: true };
            }
            previousTurnIndex = local.turnIndex;
          }
        }

        const total = Number.isInteger(sessionMeta && sessionMeta.total_message_count)
          ? sessionMeta.total_message_count
          : records.length;
        if (total !== records.length) {
          setConflict(conversation, "server_log_incomplete", "服务端累计消息数与可读取 JSONL 数量不一致，已暂停同步以避免重复写入。");
          return { ok: false, conflict: true };
        }

        const confirmedMessages = {};
        let confirmedTurnCursor = 0;
        for (const record of records) {
          const local = snapshotBySource.get(record.sourceMessageId);
          const previous = conversation.confirmedMessages[record.sourceMessageId];
          const turnIndex = local && local.turnIndex || previous && previous.turnIndex || 0;
          confirmedTurnCursor = Math.max(confirmedTurnCursor, turnIndex);
          confirmedMessages[record.sourceMessageId] = {
            role: record.role,
            contentHash: messageContentHash(record),
            turnIndex,
            createdAt: String(record.createdAt || ""),
            turnId: String(record.turnId || ""),
            peerId: String(record.peerId || "")
          };
        }

        const queue = queueForConversation(state, conversationId);
        for (const item of queue) {
          if (!serverSeen.has(item.sourceMessageId)) continue;
          const confirmed = confirmedMessages[item.sourceMessageId];
          if (!confirmed || confirmed.contentHash !== messageContentHash(item)) {
            setConflict(conversation, "pending_server_mismatch", "待确认消息与服务端已写入内容不一致，已暂停同步。");
            return { ok: false, conflict: true };
          }
        }
        state.queue = state.queue.filter(
          (item) => item.conversationId !== conversationId || !serverSeen.has(item.sourceMessageId)
        );

        conversation.confirmedSourceIds = records.map((record) => record.sourceMessageId);
        conversation.confirmedMessages = confirmedMessages;
        conversation.confirmedTurnCursor = confirmedTurnCursor;
        conversation.expectedTotalMessageCount = total;
        conversation.totalMessageCount = total;
        conversation.pendingBatch = null;
        conversation.reconciliationStatus = RECONCILIATION.CLEAN;
        conversation.reconciliationReason = "";
        conversation.lastServerCheckAt = this.now();
        applySessionMeta(conversation, { ...sessionMeta, total_message_count: total }, this.now());
        conversation.lastError = "";
        conversation.status = autoPolicyUnavailable(conversation)
          ? core.STATUS.POLICY_DISABLED
          : conversation.liveMessageCount > 0
            ? core.STATUS.PENDING_ARCHIVE
            : core.STATUS.SYNCED;
        const prepared = prepareSnapshotInState(state, conversationId, this.now());
        return { ok: true, confirmed: records.length, ...prepared };
      });
    }

    claimBatch(limit) {
      return this.transaction((state) => {
        const now = this.now();
        for (const item of state.queue) {
          const conversation = ensureConversation(state, item.conversationId);
          const protectedByIntent = conversation.pendingBatch
            && Array.isArray(conversation.pendingBatch.sourceIds)
            && conversation.pendingBatch.sourceIds.includes(item.sourceMessageId);
          if (!protectedByIntent && item.status === "uploading" && now - (item.inflightAt || 0) > 60000) {
            item.status = "pending";
            item.nextAttemptAt = Math.min(item.nextAttemptAt || now, now);
          }
        }
        const batchLimit = Math.max(1, Math.min(100, limit || 50));
        for (const conversationId of Array.from(new Set(state.queue.map((item) => item.conversationId)))) {
          const conversation = ensureConversation(state, conversationId);
          if (conversation.reconciliationStatus !== RECONCILIATION.CLEAN
            || conversation.pendingBatch
            || !conversation.latestSnapshot) continue;
          const ordered = queueForConversation(state, conversationId);
          if (!ordered.length || ordered[0].status !== "pending" || (ordered[0].nextAttemptAt || 0) > now) continue;
          const batch = [];
          const groups = groupMessagesByTurn(ordered);
          for (const group of groups) {
            if (!group.turnId) {
              conversation.status = core.STATUS.ERROR;
              conversation.lastError = "待同步消息缺少 turn_id，已暂停以避免拆分逻辑 Turn。";
              break;
            }
            if (group.messages.length > 100) {
              conversation.status = core.STATUS.ERROR;
              conversation.lastError = `单个逻辑 Turn 含 ${group.messages.length} 条消息，超过 OpenViking 单批 100 条上限，无法安全拆分。`;
              break;
            }
            if (group.messages.some((item) => item.status !== "pending" || (item.nextAttemptAt || 0) > now)) break;
            if (batch.length && (batch.length + group.messages.length > batchLimit
              || batch.length + group.messages.length > 100)) break;
            batch.push(...group.messages);
            if (batch.length >= batchLimit) break;
          }
          if (!batch.length) continue;
          const ids = new Set(batch.map((item) => item.id));
          for (const item of state.queue) {
            if (ids.has(item.id)) {
              item.status = "uploading";
              item.inflightAt = now;
            }
          }
          conversation.status = core.STATUS.SYNCING;
          conversation.lastError = "";
          return batch.map((item) => ({ ...item }));
        }
        return [];
      });
    }

    releaseClaim(items) {
      return this.transaction((state) => {
        const ids = new Set(items.map((item) => item.id));
        for (const item of state.queue) {
          if (!ids.has(item.id)) continue;
          item.status = "pending";
          item.inflightAt = 0;
          item.nextAttemptAt = Math.min(item.nextAttemptAt || this.now(), this.now());
        }
      });
    }

    beginPendingBatch(items, baselineTotal) {
      return this.transaction((state) => {
        if (!items.length) return null;
        const conversation = ensureConversation(state, items[0].conversationId);
        const intent = {
          sourceIds: items.map((item) => item.sourceMessageId),
          baselineTotal: Math.max(0, Number(baselineTotal) || 0),
          fromTurn: items[0].turnIndex,
          toTurn: items[items.length - 1].turnIndex,
          count: items.length,
          createdAt: this.now()
        };
        conversation.pendingBatch = intent;
        conversation.status = core.STATUS.SYNCING;
        return { ...intent };
      });
    }

    confirmBatch(items, response) {
      return this.transaction((state) => {
        if (!items.length) return;
        const conversationId = items[0].conversationId;
        const conversation = ensureConversation(state, conversationId);
        const ids = new Set(items.map((item) => item.id));
        state.queue = state.queue.filter((item) => !ids.has(item.id));
        for (const item of items) {
          if (!conversation.confirmedSourceIds.includes(item.sourceMessageId)) {
            conversation.confirmedSourceIds.push(item.sourceMessageId);
          }
          conversation.confirmedMessages[item.sourceMessageId] = {
            role: item.role,
            contentHash: messageContentHash(item),
            turnIndex: item.turnIndex,
            createdAt: item.createdAt,
            turnId: item.turnId,
            peerId: ""
          };
          conversation.confirmedTurnCursor = Math.max(conversation.confirmedTurnCursor, item.turnIndex);
        }
        const baseline = conversation.pendingBatch
          ? Number(conversation.pendingBatch.baselineTotal) || 0
          : Number(conversation.expectedTotalMessageCount) || 0;
        conversation.expectedTotalMessageCount = baseline + items.length;
        conversation.totalMessageCount = conversation.expectedTotalMessageCount;
        conversation.pendingBatch = null;
        applySessionMeta(conversation, {
          ...response,
          message_count: Number(response && response.message_count)
            || conversation.liveMessageCount + items.length,
          total_message_count: Number.isInteger(response && response.total_message_count)
            ? response.total_message_count : conversation.expectedTotalMessageCount
        }, this.now());
        conversation.lastSyncedAt = this.now();
        conversation.lastError = "";
        conversation.status = queueForConversation(state, conversationId).length
          ? core.STATUS.QUEUED
          : autoPolicyUnavailable(conversation)
            ? core.STATUS.POLICY_DISABLED
            : core.STATUS.PENDING_ARCHIVE;
      });
    }

    acknowledge(items) {
      return this.confirmBatch(items, {});
    }

    fail(items, error, options) {
      return this.transaction((state) => {
        if (!items.length) return;
        const ids = new Set(items.map((item) => item.id));
        const now = this.now();
        const message = core.safeErrorMessage(error);
        const uncertain = options && options.uncertain === true;
        const retryable = !error || error.retryable !== false;
        for (const item of state.queue) {
          if (!ids.has(item.id)) continue;
          item.attempts = (item.attempts || 0) + 1;
          if (!uncertain) {
            item.status = "pending";
            item.nextAttemptAt = now + (retryable
              ? core.retryDelayMs(item.attempts, this.random())
              : 5 * 60 * 1000);
            item.inflightAt = 0;
          }
        }
        const conversation = ensureConversation(state, items[0].conversationId);
        if (!uncertain) conversation.pendingBatch = null;
        conversation.status = core.STATUS.ERROR;
        conversation.lastError = uncertain
          ? `${message}；写入结果未知，将先与服务端对账。`
          : message;
      });
    }

    resolvePendingNotWritten(conversationId) {
      return this.transaction((state) => {
        const conversation = ensureConversation(state, conversationId);
        const sourceIds = new Set(conversation.pendingBatch && conversation.pendingBatch.sourceIds || []);
        for (const item of state.queue) {
          if (item.conversationId !== conversationId || !sourceIds.has(item.sourceMessageId)) continue;
          item.status = "pending";
          item.inflightAt = 0;
          item.nextAttemptAt = this.now();
        }
        conversation.pendingBatch = null;
        conversation.status = sourceIds.size ? core.STATUS.QUEUED : core.STATUS.IDLE;
        conversation.lastError = "";
      });
    }

    async listPendingBatches() {
      const state = await this.read();
      return Object.entries(state.conversations)
        .filter(([, conversation]) => conversation.pendingBatch)
        .map(([conversationId, conversation]) => ({
          conversationId,
          sessionId: conversation.sessionId,
          pendingBatch: { ...conversation.pendingBatch }
        }));
    }

    updateServerMeta(conversationId, sessionMeta) {
      return this.transaction((state) => {
        const conversation = ensureConversation(state, conversationId);
        applySessionMeta(conversation, sessionMeta, this.now());
      });
    }

    updateProcessingState(conversationId, task, archiveState) {
      return this.transaction((state) => {
        const conversation = ensureConversation(state, conversationId);
        const taskValue = task && typeof task === "object" ? task : null;
        const archive = archiveState && typeof archiveState === "object" ? archiveState : {};
        if (taskValue) {
          conversation.latestTaskId = String(taskValue.task_id || taskValue.id || conversation.latestTaskId || "");
          conversation.lastCommitTaskId = conversation.latestTaskId;
          conversation.latestTaskStatus = String(taskValue.status || "");
          conversation.latestTaskStage = String(
            taskValue.stage || taskValue.phase || taskValue.result && taskValue.result.phase || ""
          );
          conversation.latestTaskError = String(
            taskValue.error && (taskValue.error.message || taskValue.error)
            || taskValue.error_message || ""
          );
        }
        conversation.archiveStatus = String(archive.archiveStatus || conversation.archiveStatus || "none");
        conversation.latestArchiveUri = String(archive.archiveUri || conversation.latestArchiveUri || "");
        conversation.memoryDiffUri = String(archive.memoryDiffUri || conversation.memoryDiffUri || "");
        if (archive.memoryCounts && typeof archive.memoryCounts === "object") {
          conversation.memoryCounts = { ...archive.memoryCounts };
          const extracted = Object.values(conversation.memoryCounts)
            .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
          conversation.memoriesExtracted = Math.max(conversation.memoriesExtracted, extracted);
        }
        if (conversation.archiveStatus !== "none") conversation.lastArchivedAt = this.now();

        const taskStatus = conversation.latestTaskStatus.toLowerCase();
        const taskResult = taskValue && taskValue.result && typeof taskValue.result === "object"
          ? taskValue.result : {};
        const noOp = taskStatus === "skipped" || taskResult.skipped === true || taskResult.archived === false;
        const taskTime = timestampValue(taskValue && (
          taskValue.completed_at || taskValue.updated_at || taskValue.created_at
        ));
        const taskIsStale = Boolean(taskTime && conversation.lastSyncedAt
          && taskTime < conversation.lastSyncedAt);
        if (taskIsStale && conversation.liveMessageCount > 0) {
          conversation.status = core.STATUS.PENDING_ARCHIVE;
          conversation.lastError = "";
        } else if (taskStatus === "failed" || conversation.archiveStatus === "failed") {
          conversation.status = core.STATUS.ERROR;
          conversation.lastError = conversation.latestTaskError || "OpenViking 后台整理任务失败。";
        } else if (conversation.archiveStatus === "done") {
          conversation.status = core.STATUS.MEMORY_COMPLETE;
          conversation.lastError = "";
        } else if (conversation.archiveStatus === "processing") {
          conversation.status = core.STATUS.MEMORY_PROCESSING;
          conversation.lastError = "";
        } else if (conversation.archiveStatus === "archived"
          || taskStatus === "completed" && taskResult.archived === true) {
          conversation.status = core.STATUS.PHASE1_ARCHIVED;
          conversation.lastError = "";
        } else if (taskStatus === "running") {
          conversation.status = core.STATUS.ARCHIVING;
          conversation.lastError = "";
        } else if (taskStatus === "pending") {
          conversation.status = core.STATUS.PENDING_ARCHIVE;
          conversation.lastError = "";
        } else if (noOp || taskStatus === "completed") {
          conversation.status = conversation.liveMessageCount > 0
            ? core.STATUS.PENDING_ARCHIVE : core.STATUS.SYNCED;
          conversation.lastError = "";
        } else if (autoPolicyUnavailable(conversation)) {
          conversation.status = core.STATUS.POLICY_DISABLED;
        } else if (conversation.liveMessageCount > 0) {
          conversation.status = core.STATUS.PENDING_ARCHIVE;
        }
      });
    }

    setError(conversationId, error) {
      return this.transaction((state) => {
        const conversation = ensureConversation(state, conversationId);
        conversation.status = core.STATUS.ERROR;
        conversation.lastError = core.safeErrorMessage(error);
      });
    }

    async getConversation(conversationId) {
      const state = await this.read();
      return state.conversations[conversationId] || null;
    }

    async getStatus(conversationId) {
      const state = await this.read();
      const conversation = conversationId ? state.conversations[conversationId] : null;
      return {
        conversation: conversation || null,
        queuedCount: conversationId
          ? state.queue.filter((item) => item.conversationId === conversationId).length
          : state.queue.length,
        totalQueuedCount: state.queue.length,
        hasError: Object.values(state.conversations).some(
          (item) => item.status === core.STATUS.ERROR || item.status === core.STATUS.CONFLICT
        )
      };
    }

    retryNow(conversationId) {
      return this.transaction((state) => {
        const now = this.now();
        for (const item of state.queue) {
          if (!conversationId || item.conversationId === conversationId) {
            item.status = "pending";
            item.nextAttemptAt = now;
            item.inflightAt = 0;
          }
        }
        const targets = conversationId
          ? [[conversationId, state.conversations[conversationId]]]
          : Object.entries(state.conversations);
        for (const [id, existing] of targets) {
          if (!existing) continue;
          const conversation = ensureConversation(state, id);
          conversation.reconciliationStatus = RECONCILIATION.REQUIRED;
          conversation.reconciliationReason = "manual_retry";
          conversation.pendingBatch = null;
          conversation.status = core.STATUS.WAITING_HISTORY;
          conversation.lastError = "";
        }
      });
    }
  }

  return {
    StateStore,
    RECONCILIATION,
    emptyState,
    normalizeState,
    messageContentHash
  };
});
