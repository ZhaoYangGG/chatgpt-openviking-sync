(function initExtractor(root, factory) {
  const core = root.OpenVikingSyncCore || (typeof require === "function" ? require("../shared/core.js") : null);
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTConversationExtractor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function extractorFactory(core) {
  "use strict";

  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const DATE_SEPARATOR_SELECTOR = '[role="separator"][aria-label]';

  function cleanText(value) {
    return core.normalizeMessageContent(String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\u200b/g, ""));
  }

  function elementText(element) {
    if (!element) return "";
    return cleanText(typeof element.innerText === "string" ? element.innerText : element.textContent);
  }

  function topLevelMatches(node, selector) {
    return Array.from(node.querySelectorAll(selector)).filter((candidate) => {
      const parent = candidate.parentElement && candidate.parentElement.closest(selector);
      return !parent || !node.contains(parent);
    });
  }

  function extractMessageText(node, role) {
    if (role === "assistant") {
      const markdown = topLevelMatches(node, ".markdown");
      if (markdown.length) return cleanText(markdown.map(elementText).filter(Boolean).join("\n\n"));
    } else {
      const userBlocks = topLevelMatches(node, '[data-testid="user-message"], .whitespace-pre-wrap');
      if (userBlocks.length) return cleanText(userBlocks.map(elementText).filter(Boolean).join("\n\n"));
    }

    const clone = node.cloneNode(true);
    for (const removable of clone.querySelectorAll(
      'button, svg, script, style, textarea, [contenteditable="true"], [aria-hidden="true"]'
    )) {
      removable.remove();
    }
    return elementText(clone);
  }

  function parseTurnIndex(value) {
    const match = String(value || "").match(/^conversation-turn-(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function findTurnContainer(node) {
    return node && node.closest ? node.closest(TURN_SELECTOR) : null;
  }

  function findSourceMessageId(node) {
    const carrier = node.hasAttribute("data-message-id")
      ? node
      : node.querySelector("[data-message-id]") || node.closest("[data-message-id]");
    const messageId = carrier && carrier.getAttribute("data-message-id");
    const turn = findTurnContainer(node);
    const testId = turn && turn.getAttribute("data-testid");
    const turnIndex = parseTurnIndex(testId);
    if (messageId) return { id: messageId, kind: "message-id", turnIndex };
    return { id: "", kind: "missing", turnIndex };
  }

  function parseDateSeparatorLabel(value, nowValue) {
    const label = cleanText(value).replace(/[，,]/g, " ").replace(/\s+/g, " ");
    if (!label) return null;
    const now = nowValue instanceof Date ? new Date(nowValue.getTime()) : new Date(nowValue || Date.now());
    let match = label.match(/^(今天|昨天|today|yesterday)\s+(\d{1,2}):(\d{2})/i);
    if (match) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[2]), Number(match[3]));
      if (/^(昨天|yesterday)$/i.test(match[1])) date.setDate(date.getDate() - 1);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    match = label.match(/^(?:星期|周)([一二三四五六日天])\s+(\d{1,2}):(\d{2})/);
    if (match) {
      const weekdays = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
      const date = new Date(
        now.getFullYear(), now.getMonth(), now.getDate(), Number(match[2]), Number(match[3])
      );
      let daysAgo = (now.getDay() - weekdays[match[1]] + 7) % 7;
      if (daysAgo === 0 && date.getTime() > now.getTime()) daysAgo = 7;
      date.setDate(date.getDate() - daysAgo);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    match = label.match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2}):(\d{2})/i);
    if (match) {
      const weekdays = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
        thursday: 4, friday: 5, saturday: 6
      };
      const date = new Date(
        now.getFullYear(), now.getMonth(), now.getDate(), Number(match[2]), Number(match[3])
      );
      let daysAgo = (now.getDay() - weekdays[match[1].toLowerCase()] + 7) % 7;
      if (daysAgo === 0 && date.getTime() > now.getTime()) daysAgo = 7;
      date.setDate(date.getDate() - daysAgo);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    match = label.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日.*?(\d{1,2}):(\d{2})/);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    match = label.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日.*?(\d{1,2}):(\d{2})/);
    if (match) {
      const date = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]));
      if (date.getTime() - now.getTime() > 31 * 24 * 60 * 60 * 1000) date.setFullYear(date.getFullYear() - 1);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    const parsed = Date.parse(label);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  function pageIsGenerating(documentValue) {
    return Boolean(documentValue.querySelector(
      '[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="停止生成"], .result-streaming, [data-is-streaming="true"]'
    ));
  }

  function nodeIsHidden(node) {
    return Boolean(node.closest('[hidden], [aria-hidden="true"]'));
  }

  function dateGroupsByMessage(documentValue, messageNodes) {
    const result = new Map();
    const wanted = new Set(messageNodes);
    let currentLabel = "";
    for (const node of documentValue.querySelectorAll(`${DATE_SEPARATOR_SELECTOR}, ${ROLE_SELECTOR}`)) {
      if (node.matches && node.matches(DATE_SEPARATOR_SELECTOR)) {
        currentLabel = node.getAttribute("aria-label") || "";
      } else if (wanted.has(node)) {
        result.set(node, currentLabel);
      }
    }
    return result;
  }

  function extractCandidates(documentValue, options) {
    const allNodes = Array.from(documentValue.querySelectorAll(ROLE_SELECTOR));
    const nodes = allNodes.filter((node) => !node.querySelector(ROLE_SELECTOR) && !nodeIsHidden(node));
    const generating = pageIsGenerating(documentValue);
    const lastAssistantNode = [...nodes].reverse().find(
      (node) => node.getAttribute("data-message-author-role") === "assistant"
    );
    const groups = dateGroupsByMessage(documentValue, nodes);
    const candidates = [];
    const seenExact = new Set();
    const seenBySource = new Map();
    const now = options && options.now instanceof Date ? options.now : new Date(options && options.now || Date.now());

    nodes.forEach((node, domOrdinal) => {
      const role = node.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") return;
      const content = extractMessageText(node, role);
      if (!content) return;
      const source = findSourceMessageId(node);
      const exactKey = `${role}\u0000${source.id}\u0000${content}`;
      if (seenExact.has(exactKey)) return;
      seenExact.add(exactKey);
      const previous = source.id ? seenBySource.get(source.id) : null;
      const identityConflict = Boolean(previous && (previous.role !== role || previous.content !== content));
      if (source.id && !previous) seenBySource.set(source.id, { role, content });
      const dateLabel = groups.get(node) || "";
      candidates.push({
        role,
        content,
        sourceMessageId: source.id,
        sourceMessageIdKind: source.kind,
        turnIndex: source.turnIndex,
        ordinal: domOrdinal,
        dateLabel,
        groupCreatedAt: dateLabel ? parseDateSeparatorLabel(dateLabel, now) : null,
        identityConflict,
        streaming: role === "assistant" && (node === lastAssistantNode && generating
          || Boolean(node.closest('.result-streaming, [data-is-streaming="true"]')))
      });
    });

    candidates.sort((left, right) => {
      if (left.turnIndex !== null && right.turnIndex !== null) return left.turnIndex - right.turnIndex;
      if (left.turnIndex !== null) return -1;
      if (right.turnIndex !== null) return 1;
      return left.ordinal - right.ordinal;
    });
    return candidates;
  }

  function isContiguousFromStart(candidates) {
    if (!candidates.length || candidates[0].turnIndex !== 1 || candidates[0].role !== "user") return false;
    let previousTurnIndex = 0;
    return candidates.every((candidate) => {
      const valid = Number.isInteger(candidate.turnIndex)
        && candidate.turnIndex > previousTurnIndex
        && Boolean(candidate.sourceMessageId)
        && !candidate.identityConflict;
      if (valid) previousTurnIndex = candidate.turnIndex;
      return valid;
    });
  }

  function conversationTitle(documentValue) {
    const title = cleanText(documentValue && documentValue.title || "");
    return title.replace(/\s*[|–—-]\s*ChatGPT\s*$/i, "").slice(0, 300);
  }

  class StabilityTracker {
    constructor(now) {
      this.now = now || (() => Date.now());
      this.entries = new Map();
    }

    identity(candidate) {
      return String(candidate && candidate.sourceMessageId || "");
    }

    has(candidate) {
      return this.entries.has(this.identity(candidate));
    }

    observe(candidate) {
      const identity = this.identity(candidate);
      if (!identity) return 0;
      const existing = this.entries.get(identity);
      const currentTime = this.now();
      if (!existing || existing.content !== candidate.content || existing.role !== candidate.role) {
        this.entries.set(identity, {
          role: candidate.role,
          content: candidate.content,
          stableSince: currentTime,
          firstObservedAt: existing && existing.firstObservedAt || currentTime
        });
        return 0;
      }
      return currentTime - existing.stableSince;
    }

    firstObservedAt(candidate) {
      const entry = this.entries.get(this.identity(candidate));
      return entry ? entry.firstObservedAt : null;
    }

    retain(candidates) {
      const active = new Set(candidates.map((candidate) => this.identity(candidate)).filter(Boolean));
      for (const key of this.entries.keys()) {
        if (!active.has(key)) this.entries.delete(key);
      }
    }

    clear() {
      this.entries.clear();
    }
  }

  return {
    ROLE_SELECTOR,
    TURN_SELECTOR,
    DATE_SEPARATOR_SELECTOR,
    cleanText,
    extractMessageText,
    parseTurnIndex,
    findSourceMessageId,
    parseDateSeparatorLabel,
    pageIsGenerating,
    extractCandidates,
    isContiguousFromStart,
    conversationTitle,
    StabilityTracker
  };
});
