(function initCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.OpenVikingSyncCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function coreFactory() {
  "use strict";

  const CONFIG_KEY = "ov_config";
  const CONFIG_VERSION = 2;
  const STATE_KEY = "ov_sync_state";
  const STATE_VERSION = 5;
  const OFFICIAL_CLOUD_HOST = "api.vikingdb.cn-beijing.volces.com";
  const OFFICIAL_CLOUD_PATH = "/openviking";

  const DEFAULT_CONFIG = Object.freeze({
    configVersion: CONFIG_VERSION,
    enabled: true,
    serverUrl: "",
    apiKey: "",
    agentId: "",
    authMode: "auto",
    autoCommitEnabled: true,
    autoCommitPolicy: Object.freeze({
      pending_token_threshold: 10000,
      message_count_threshold: 20,
      idle_timeout_seconds: 86400,
      keep_recent_count: 2,
      min_commit_interval_seconds: 60
    })
  });

  const STATUS = Object.freeze({
    NOT_CONFIGURED: "not_configured",
    DISABLED: "disabled",
    IDLE: "idle",
    QUEUED: "queued",
    SYNCING: "syncing",
    WAITING_HISTORY: "waiting_history",
    PENDING_ARCHIVE: "pending_archive",
    ARCHIVING: "archiving",
    PHASE1_ARCHIVED: "phase1_archived",
    MEMORY_PROCESSING: "memory_processing",
    MEMORY_COMPLETE: "memory_complete",
    POLICY_DISABLED: "policy_disabled",
    SYNCED: "synced",
    ERROR: "error",
    CONFLICT: "conflict"
  });

  function normalizeServerUrl(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("OpenViking Server 仅支持 http:// 或 https:// 地址");
    }
    parsed.hash = "";
    parsed.search = "";
    if (parsed.hostname.toLowerCase() === OFFICIAL_CLOUD_HOST) {
      parsed.pathname = OFFICIAL_CLOUD_PATH;
    }
    return parsed.toString().replace(/\/$/, "");
  }

  function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeConfig(input) {
    const raw = input && typeof input === "object" ? input : {};
    const rawPolicy = raw.autoCommitPolicy && typeof raw.autoCommitPolicy === "object"
      ? raw.autoCommitPolicy
      : {};
    const legacyDefaultPolicy = raw.configVersion !== CONFIG_VERSION
      && Number(rawPolicy.pending_token_threshold) === 8000
      && Number(rawPolicy.message_count_threshold) === 20
      && Number(rawPolicy.idle_timeout_seconds) === 600
      && Number(rawPolicy.keep_recent_count) === 2
      && Number(rawPolicy.min_commit_interval_seconds) === 60;
    const policy = legacyDefaultPolicy ? {} : rawPolicy;
    const authMode = ["auto", "bearer", "x-api-key"].includes(raw.authMode)
      ? raw.authMode
      : DEFAULT_CONFIG.authMode;

    return {
      configVersion: CONFIG_VERSION,
      enabled: raw.enabled !== false,
      serverUrl: raw.serverUrl ? normalizeServerUrl(raw.serverUrl) : "",
      apiKey: String(raw.apiKey || "").trim(),
      agentId: String(raw.agentId || "").trim(),
      authMode,
      autoCommitEnabled: raw.autoCommitEnabled !== false,
      autoCommitPolicy: {
        pending_token_threshold: boundedInteger(
          policy.pending_token_threshold,
          DEFAULT_CONFIG.autoCommitPolicy.pending_token_threshold,
          100,
          1000000
        ),
        message_count_threshold: boundedInteger(
          policy.message_count_threshold,
          DEFAULT_CONFIG.autoCommitPolicy.message_count_threshold,
          2,
          10000
        ),
        idle_timeout_seconds: boundedInteger(
          policy.idle_timeout_seconds,
          DEFAULT_CONFIG.autoCommitPolicy.idle_timeout_seconds,
          30,
          604800
        ),
        keep_recent_count: boundedInteger(
          policy.keep_recent_count,
          DEFAULT_CONFIG.autoCommitPolicy.keep_recent_count,
          0,
          1000
        ),
        min_commit_interval_seconds: boundedInteger(
          policy.min_commit_interval_seconds,
          DEFAULT_CONFIG.autoCommitPolicy.min_commit_interval_seconds,
          0,
          86400
        )
      }
    };
  }

  function isConfigured(config) {
    return Boolean(config && config.serverUrl);
  }

  function autoCommitPoliciesEqual(left, right) {
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    return Object.keys(DEFAULT_CONFIG.autoCommitPolicy).every(
      (key) => Number(left[key]) === Number(right[key])
    );
  }

  function getConversationId(urlValue) {
    let parsed;
    try {
      parsed = new URL(String(urlValue));
    } catch (_error) {
      return null;
    }
    if (parsed.hostname !== "chatgpt.com") return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (segments[index] !== "c") continue;
      const candidate = decodeURIComponent(segments[index + 1] || "").trim();
      if (candidate && /^[A-Za-z0-9_-]{6,200}$/.test(candidate)) return candidate;
    }
    return null;
  }

  function buildSessionId(conversationId) {
    const normalized = String(conversationId || "")
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!normalized) throw new TypeError("缺少有效的 ChatGPT Conversation ID");
    return `chatgpt_${normalized}`.slice(0, 128);
  }

  function normalizeMessageContent(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t ]+$/gm, "")
      .replace(/^\n+|\n+$/g, "");
  }

  function fnv1a32(value, seed) {
    let hash = seed >>> 0;
    const input = String(value);
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function hashString(value) {
    return fnv1a32(value, 0x811c9dc5) + fnv1a32(value, 0x9e3779b9);
  }

  function createMessageFingerprint(message, conversationId) {
    const source = String(message && message.sourceMessageId || "").trim();
    if (!source) throw new TypeError("缺少稳定的 ChatGPT 消息 ID");
    const conversation = String(
      conversationId || message && message.conversationId || ""
    ).trim();
    return `m2_${hashString(`${conversation}\u0000${source}`)}`;
  }

  function sourceMessageId(conversationId, message) {
    const local = String(message && message.sourceMessageId || "").trim();
    if (!local) throw new TypeError("缺少稳定的 ChatGPT 消息 ID");
    return `chatgpt:${conversationId}:${local}`.slice(0, 512);
  }

  function isIsoTimestamp(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && /^\d{4}-\d{2}-\d{2}T/.test(value);
  }

  function retryDelayMs(attempt, randomValue) {
    const safeAttempt = Math.max(1, Number(attempt) || 1);
    const base = Math.min(5 * 60 * 1000, 1000 * (2 ** Math.min(8, safeAttempt - 1)));
    const random = Number.isFinite(randomValue) ? randomValue : Math.random();
    return Math.round(base * (0.8 + random * 0.4));
  }

  function safeErrorMessage(error) {
    const message = error && error.message ? String(error.message) : String(error || "未知错误");
    return message.replace(/Bearer\s+\S+/gi, "Bearer <redacted>").slice(0, 500);
  }

  return {
    CONFIG_KEY,
    CONFIG_VERSION,
    STATE_KEY,
    STATE_VERSION,
    DEFAULT_CONFIG,
    STATUS,
    normalizeServerUrl,
    normalizeConfig,
    isConfigured,
    autoCommitPoliciesEqual,
    getConversationId,
    buildSessionId,
    normalizeMessageContent,
    hashString,
    createMessageFingerprint,
    sourceMessageId,
    isIsoTimestamp,
    retryDelayMs,
    safeErrorMessage
  };
});
