(function initClient(root, factory) {
  const core = root.OpenVikingSyncCore || (typeof require === "function" ? require("../shared/core.js") : null);
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OpenVikingClientModule = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function clientFactory(core) {
  "use strict";

  class OpenVikingError extends Error {
    constructor(message, options) {
      super(message);
      this.name = "OpenVikingError";
      this.code = options && options.code || "UNKNOWN";
      this.httpStatus = options && options.httpStatus || 0;
      this.retryable = options && options.retryable !== false;
      this.requestUrl = options && options.requestUrl || "";
    }
  }

  function isRetryableStatus(status) {
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function queryString(values) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values || {})) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    const encoded = params.toString();
    return encoded ? `?${encoded}` : "";
  }

  function messageText(record) {
    if (typeof (record && record.content) === "string") {
      return core.normalizeMessageContent(record.content);
    }
    const parts = Array.isArray(record && record.parts) ? record.parts : [];
    return core.normalizeMessageContent(parts.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    }).filter(Boolean).join("\n\n"));
  }

  function sourceIds(record) {
    const value = record && (record.source_message_ids || record.sourceMessageIds);
    return Array.isArray(value) ? value.map(String) : [];
  }

  function archiveNumber(uri) {
    const match = String(uri || "").match(/\/history\/archive_(\d+)\/messages\.jsonl$/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function archiveDirectoryNumber(uri) {
    const match = String(uri || "").match(/\/history\/archive_(\d+)(?:\/|$)/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function resultItems(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result && result.tasks)) return result.tasks;
    if (Array.isArray(result && result.items)) return result.items;
    if (Array.isArray(result && result.entries)) return result.entries;
    return [];
  }

  function memoryDiffCounts(value) {
    const aliases = {
      profile: "profile",
      profiles: "profile",
      preference: "preference",
      preferences: "preference",
      entity: "entity",
      entities: "entity",
      event: "event",
      events: "event",
      experience: "experience",
      experiences: "experience",
      pattern: "pattern",
      patterns: "pattern",
      goal: "goal",
      goals: "goal",
      knowledge: "knowledge",
      facts: "knowledge"
    };
    const counts = {};
    function walk(node, key) {
      if (!node || typeof node !== "object") return;
      const normalized = aliases[String(key || "").toLowerCase()];
      if (normalized && Array.isArray(node)) {
        counts[normalized] = (counts[normalized] || 0) + node.length;
        return;
      }
      for (const [childKey, child] of Object.entries(node)) walk(child, childKey);
    }
    walk(value, "");
    return counts;
  }

  class OpenVikingClient {
    constructor(config, dependencies) {
      this.config = core.normalizeConfig(config);
      this.fetchImpl = dependencies && dependencies.fetch || globalThis.fetch.bind(globalThis);
      this.timeoutMs = dependencies && dependencies.timeoutMs || 20000;
      this.resolvedAuthMode = null;
    }

    endpoint(path) {
      const suffix = String(path || "").startsWith("/") ? String(path) : `/${path}`;
      return `${this.config.serverUrl}${suffix}`;
    }

    authCandidates() {
      if (!this.config.apiKey) return ["none"];
      if (this.config.authMode === "auto") {
        if (this.resolvedAuthMode === "bearer") return ["bearer", "x-api-key"];
        if (this.resolvedAuthMode === "x-api-key") return ["x-api-key", "bearer"];
        return ["bearer", "x-api-key"];
      }
      return [this.config.authMode];
    }

    headers(authMode, hasBody) {
      const headers = { Accept: "application/json" };
      if (hasBody) headers["Content-Type"] = "application/json";
      if (authMode === "bearer" && this.config.apiKey) {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      } else if (authMode === "x-api-key" && this.config.apiKey) {
        headers["X-API-Key"] = this.config.apiKey;
      }
      if (this.config.agentId) headers["X-OpenViking-Agent"] = this.config.agentId;
      return headers;
    }

    async request(path, options) {
      const requestOptions = options || {};
      const method = requestOptions.method || "GET";
      const body = requestOptions.body;
      const candidates = this.authCandidates();
      let lastError;

      for (let index = 0; index < candidates.length; index += 1) {
        const authMode = candidates[index];
        try {
          const response = await this.fetchOnce(path, {
            method,
            body,
            authMode
          });
          if (this.config.authMode === "auto" && authMode !== "none") {
            this.resolvedAuthMode = authMode;
          }
          return response;
        } catch (error) {
          lastError = error;
          const canTryNext = error instanceof OpenVikingError
            && error.httpStatus === 401
            && index < candidates.length - 1;
          if (!canTryNext) throw error;
        }
      }
      throw lastError;
    }

    async fetchOnce(path, request) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeout = controller
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;
      let response;
      const requestUrl = this.endpoint(path);
      try {
        response = await this.fetchImpl(requestUrl, {
          method: request.method,
          headers: this.headers(request.authMode, request.body !== undefined),
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: controller ? controller.signal : undefined,
          cache: "no-store"
        });
      } catch (error) {
        const message = error && error.name === "AbortError"
          ? "连接 OpenViking 超时"
          : `无法连接 OpenViking：${core.safeErrorMessage(error)}`;
        throw new OpenVikingError(message, {
          code: "NETWORK_ERROR",
          retryable: true,
          requestUrl
        });
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      let payload = null;
      try {
        const text = await response.text();
        payload = text ? JSON.parse(text) : null;
      } catch (_error) {
        payload = null;
      }

      if (!response.ok || payload && payload.status === "error") {
        const apiError = payload && payload.error || {};
        const message = apiError.message || `OpenViking 请求失败（HTTP ${response.status}）`;
        throw new OpenVikingError(message, {
          code: apiError.code || `HTTP_${response.status}`,
          httpStatus: response.status,
          retryable: isRetryableStatus(response.status),
          requestUrl
        });
      }
      return payload && Object.prototype.hasOwnProperty.call(payload, "result")
        ? payload.result
        : payload;
    }

    async testConnection() {
      try {
        return await this.request("/health");
      } catch (healthError) {
        if (!(healthError instanceof OpenVikingError) || healthError.httpStatus !== 404) {
          throw healthError;
        }
      }

      try {
        return await this.request("/api/v1/system/status");
      } catch (statusError) {
        if (!(statusError instanceof OpenVikingError) || statusError.httpStatus !== 404) {
          throw statusError;
        }
        throw new OpenVikingError(
          `OpenViking 服务根地址不正确：${this.endpoint("/health")} 和 ${this.endpoint("/api/v1/system/status")} 均返回 HTTP 404。请填写 base URL，不要包含 /api/v1 或 /health；火山引擎云服务应为 https://api.vikingdb.cn-beijing.volces.com/openviking`,
          {
            code: "INVALID_SERVER_BASE_URL",
            httpStatus: 404,
            retryable: false,
            requestUrl: this.config.serverUrl
          }
        );
      }
    }

    async getSession(sessionId) {
      return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    }

    async ensureSession(sessionId) {
      try {
        return await this.getSession(sessionId);
      } catch (error) {
        if (!(error instanceof OpenVikingError) || error.httpStatus !== 404) throw error;
      }

      const body = {
        session_id: sessionId,
        memory_policy: {
          self: { enabled: true },
          peer: { enabled: true }
        }
      };
      if (this.config.autoCommitEnabled) {
        body.auto_commit_policy = this.config.autoCommitPolicy;
      }
      try {
        return await this.request("/api/v1/sessions", { method: "POST", body });
      } catch (error) {
        if (error instanceof OpenVikingError && error.httpStatus === 409) {
          return this.getSession(sessionId);
        }
        if (error instanceof OpenVikingError && [400, 422].includes(error.httpStatus)) {
          const compatibleBody = { ...body };
          delete compatibleBody.memory_policy;
          try {
            return await this.request("/api/v1/sessions", { method: "POST", body: compatibleBody });
          } catch (compatibleError) {
            if (compatibleError instanceof OpenVikingError && compatibleError.httpStatus === 409) {
              return this.getSession(sessionId);
            }
            throw compatibleError;
          }
        }
        throw error;
      }
    }

    async updateSessionConfig(sessionId, autoCommitPolicy) {
      return this.request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/config`,
        { method: "PATCH", body: { auto_commit_policy: autoCommitPolicy } }
      );
    }

    async addMessages(sessionId, conversationId, items) {
      const messages = items.map((item) => {
        const message = {
          role: item.role,
          content: item.content,
          created_at: item.createdAt,
          turn_id: item.turnId,
          message_kind: item.role === "user" ? "user_query" : "assistant_step",
          source_message_ids: [core.sourceMessageId(conversationId, item)]
        };
        return message;
      });
      return this.request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`,
        { method: "POST", body: { messages } }
      );
    }

    async listSessionCommitTasks(sessionId, limit) {
      const result = await this.request(`/api/v1/tasks${queryString({
        task_type: "session_commit",
        resource_id: sessionId,
        limit: Math.max(1, Math.min(100, Number(limit) || 20))
      })}`);
      return resultItems(result);
    }

    async getTask(taskId) {
      return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    }

    async listSessionFiles(sessionUri) {
      const result = await this.request(`/api/v1/fs/ls${queryString({
        uri: sessionUri,
        simple: false,
        recursive: true,
        output: "original",
        show_all_hidden: true,
        node_limit: 10000
      })}`);
      const entries = resultItems(result);
      return entries
        .filter((entry) => entry && entry.isDir !== true && typeof entry.uri === "string")
        .map((entry) => entry.uri);
    }

    async listSessionMessageFiles(sessionUri) {
      const entries = await this.listSessionFiles(sessionUri);
      const sessionRoot = String(sessionUri || "").replace(/\/$/, "");
      const files = entries
        .filter((uri) => uri === `${sessionRoot}/messages.jsonl`
          || archiveNumber(uri) !== null);
      return Array.from(new Set(files)).sort((left, right) => {
        const leftArchive = archiveNumber(left);
        const rightArchive = archiveNumber(right);
        if (leftArchive === null && rightArchive === null) return left.localeCompare(right);
        if (leftArchive === null) return 1;
        if (rightArchive === null) return -1;
        return leftArchive - rightArchive;
      });
    }

    async readSessionArchiveState(sessionId, sessionMeta) {
      const sessionUri = String(sessionMeta && sessionMeta.uri
        || `viking://session/${sessionId}`).replace(/\/$/, "");
      const files = await this.listSessionFiles(sessionUri);
      const archiveNumbers = files.map(archiveDirectoryNumber).filter((value) => value !== null);
      if (!archiveNumbers.length) {
        return {
          archiveStatus: "none",
          archiveUri: "",
          memoryDiffUri: "",
          memoryCounts: {}
        };
      }
      const latest = Math.max(...archiveNumbers);
      const archiveUri = `${sessionUri}/history/archive_${String(latest).padStart(3, "0")}`;
      const doneUri = files.find((uri) => uri === `${archiveUri}/.done`) || "";
      const failedUri = files.find((uri) => uri === `${archiveUri}/.failed.json`) || "";
      const memoryDiffUri = files.find((uri) => uri === `${archiveUri}/memory_diff.json`) || "";
      let memoryCounts = {};
      if (memoryDiffUri) {
        try {
          const raw = await this.readContent(memoryDiffUri);
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          memoryCounts = memoryDiffCounts(parsed);
        } catch (_error) {
          memoryCounts = {};
        }
      }
      return {
        archiveStatus: failedUri ? "failed" : doneUri ? "done" : memoryDiffUri ? "processing" : "archived",
        archiveUri,
        memoryDiffUri,
        archiveDoneUri: doneUri,
        archiveFailedUri: failedUri,
        memoryCounts
      };
    }

    async readContent(uri) {
      return this.request(`/api/v1/content/read${queryString({
        uri,
        offset: 0,
        limit: -1,
        raw: true
      })}`);
    }

    async readSessionMessages(sessionId, conversationId, sessionMeta) {
      const sessionUri = String(sessionMeta && sessionMeta.uri
        || `viking://session/${sessionId}`).replace(/\/$/, "");
      const files = await this.listSessionMessageFiles(sessionUri);
      const expectedPrefix = `chatgpt:${conversationId}:`;
      const records = [];
      for (const uri of files) {
        const content = await this.readContent(uri);
        if (typeof content !== "string") {
          throw new OpenVikingError(`OpenViking 日志读取结果不是文本：${uri}`, {
            code: "INVALID_SESSION_LOG",
            retryable: false,
            requestUrl: this.endpoint("/api/v1/content/read")
          });
        }
        const lines = content.split(/\r?\n/).filter((line) => line.trim());
        for (const line of lines) {
          let record;
          try {
            record = JSON.parse(line);
          } catch (_error) {
            throw new OpenVikingError(`OpenViking Session 日志含有无效 JSONL：${uri}`, {
              code: "INVALID_SESSION_LOG",
              retryable: false,
              requestUrl: this.endpoint("/api/v1/content/read")
            });
          }
          const sourceId = sourceIds(record).find((id) => id.startsWith(expectedPrefix)) || "";
          records.push({
            sourceMessageId: sourceId ? sourceId.slice(expectedPrefix.length) : "",
            role: String(record && record.role || ""),
            content: messageText(record),
            createdAt: String(record && (record.created_at || record.createdAt) || ""),
            turnId: String(record && (record.turn_id || record.turnId) || ""),
            peerId: String(record && (record.peer_id || record.peerId) || ""),
            uri
          });
        }
      }
      return records;
    }
  }

  return {
    OpenVikingClient,
    OpenVikingError,
    isRetryableStatus,
    messageText,
    archiveNumber,
    memoryDiffCounts
  };
});
