(function startContentScript() {
  "use strict";

  const core = globalThis.OpenVikingSyncCore;
  const extractor = globalThis.ChatGPTConversationExtractor;
  const extensionApi = globalThis.browser || globalThis.chrome;
  const usesPromiseApi = Boolean(globalThis.browser);
  const tracker = new extractor.StabilityTracker();
  const USER_STABLE_MS = 250;
  const ASSISTANT_STABLE_MS = 1600;
  let activeConversationId = null;
  let scanTimer = null;
  let scanRunning = false;
  let scanAgain = false;
  let stopped = false;
  let firstSnapshot = true;
  let highestObservedTurnIndex = 0;
  let lastSentSnapshotSignature = "";

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

  function scheduleScan(delay) {
    if (stopped) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      void scan();
    }, Math.max(50, delay || 350));
  }

  async function scan() {
    if (scanRunning) {
      scanAgain = true;
      return;
    }
    scanRunning = true;
    try {
      const conversationId = core.getConversationId(location.href);
      if (!conversationId) return;
      if (activeConversationId !== conversationId) {
        activeConversationId = conversationId;
        tracker.clear();
        firstSnapshot = true;
        highestObservedTurnIndex = 0;
        lastSentSnapshotSignature = "";
      }

      const candidates = extractor.extractCandidates(document);
      tracker.retain(candidates);
      const snapshotMessages = [];
      let needsFollowUp = false;
      let currentLogicalTurnIndex = null;
      const previousHighestTurnIndex = highestObservedTurnIndex;
      const pageGenerating = extractor.pageIsGenerating(document);
      const liveStartOnFirstSnapshot = firstSnapshot && pageGenerating
        ? [...candidates].reverse().find((candidate) => candidate.role === "user")?.turnIndex || null
        : null;
      const historyOrderAnchor = Date.now();

      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (candidate.role === "user") currentLogicalTurnIndex = candidate.turnIndex;
        const wasTracked = tracker.has(candidate);
        const stableFor = tracker.observe(candidate);
        const required = candidate.role === "assistant" ? ASSISTANT_STABLE_MS : USER_STABLE_MS;
        const historical = firstSnapshot
          ? !(liveStartOnFirstSnapshot && candidate.turnIndex >= liveStartOnFirstSnapshot)
          : Number.isInteger(candidate.turnIndex) && candidate.turnIndex <= previousHighestTurnIndex;
        let createdAt = null;
        let timestampPrecision = "";
        if (!historical) {
          const observedAt = tracker.firstObservedAt(candidate) || Date.now();
          createdAt = new Date(observedAt).toISOString();
          timestampPrecision = "observed";
        } else if (candidate.dateLabel && candidate.groupCreatedAt) {
          createdAt = candidate.groupCreatedAt;
          timestampPrecision = "group";
        } else if (candidate.dateLabel) {
          createdAt = new Date(historyOrderAnchor - (candidates.length - candidateIndex) * 1000).toISOString();
          timestampPrecision = "inferred_order";
        } else {
          createdAt = new Date(historyOrderAnchor - (candidates.length - candidateIndex) * 1000).toISOString();
          timestampPrecision = "inferred_order";
        }

        const stable = Boolean(
          candidate.sourceMessageId
          && Number.isInteger(candidate.turnIndex)
          && !candidate.identityConflict
          && createdAt
          && !candidate.streaming
          && stableFor >= required
        );
        if (!stable) {
          needsFollowUp = true;
        }
        const logicalTurnIndex = currentLogicalTurnIndex
          || (Number.isInteger(candidate.turnIndex) ? Math.max(1, candidate.turnIndex - 1) : null);
        snapshotMessages.push({
          role: candidate.role,
          content: candidate.content,
          sourceMessageId: candidate.sourceMessageId,
          sourceMessageIdKind: candidate.sourceMessageIdKind,
          turnIndex: candidate.turnIndex,
          ordinal: candidate.ordinal,
          turnId: logicalTurnIndex
            ? `chatgpt:${conversationId}:turn:${logicalTurnIndex}`
            : "",
          createdAt,
          timestampPrecision,
          stable,
          identityConflict: candidate.identityConflict,
          historical,
          firstObservation: !wasTracked
        });
      }

      highestObservedTurnIndex = Math.max(
        highestObservedTurnIndex,
        ...candidates.map((candidate) => candidate.turnIndex || 0)
      );
      if (snapshotMessages.length) {
        const completeFromStart = extractor.isContiguousFromStart(candidates);
        const signature = JSON.stringify({
          completeFromStart,
          messages: snapshotMessages.map((message) => [
            message.role,
            message.sourceMessageId,
            message.turnIndex,
            message.content,
            message.createdAt,
            message.timestampPrecision,
            message.stable,
            message.identityConflict
          ])
        });
        if (signature !== lastSentSnapshotSignature) {
          await sendMessage({
            type: "OBSERVE_SNAPSHOT",
            payload: {
              conversationId,
              title: extractor.conversationTitle(document),
              completeFromStart,
              messages: snapshotMessages
            }
          });
          lastSentSnapshotSignature = signature;
        }
      }
      firstSnapshot = false;
      if (needsFollowUp) scheduleScan(ASSISTANT_STABLE_MS + 100);
    } catch (error) {
      if (/context invalidated|Extension context/i.test(String(error && error.message))) {
        stopped = true;
      } else {
        scheduleScan(3000);
      }
    } finally {
      scanRunning = false;
      if (scanAgain) {
        scanAgain = false;
        scheduleScan(100);
      }
    }
  }

  const observer = new MutationObserver(() => scheduleScan(350));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-message-id", "data-is-streaming", "data-testid", "aria-label"]
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleScan(100);
  });
  globalThis.addEventListener("online", () => scheduleScan(100));
  setInterval(() => scheduleScan(0), 2500);
  scheduleScan(100);
})();
