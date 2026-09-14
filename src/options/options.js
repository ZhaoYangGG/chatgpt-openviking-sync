(function initializeOptions() {
  "use strict";

  const core = globalThis.OpenVikingSyncCore;
  const extensionApi = globalThis.browser || globalThis.chrome;
  const usesPromiseApi = Boolean(globalThis.browser);
  const form = document.querySelector("#settings-form");
  const resultBox = document.querySelector("#result");
  const saveButton = document.querySelector("#save-button");

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

  function requestOriginPermission(serverUrl) {
    const originPattern = `${new URL(serverUrl).origin}/*`;
    const request = { origins: [originPattern] };
    if (usesPromiseApi) return extensionApi.permissions.request(request);
    return new Promise((resolve, reject) => {
      extensionApi.permissions.request(request, (granted) => {
        const error = extensionApi.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(granted);
      });
    });
  }

  function showResult(message, kind) {
    resultBox.hidden = false;
    resultBox.className = `result ${kind || ""}`;
    resultBox.textContent = message;
  }

  function collectConfig() {
    return core.normalizeConfig({
      enabled: document.querySelector("#enabled").checked,
      serverUrl: document.querySelector("#server-url").value,
      apiKey: document.querySelector("#api-key").value,
      agentId: document.querySelector("#agent-id").value,
      authMode: document.querySelector("#auth-mode").value,
      autoCommitEnabled: document.querySelector("#auto-commit-enabled").checked,
      autoCommitPolicy: {
        message_count_threshold: document.querySelector("#message-threshold").value,
        idle_timeout_seconds: document.querySelector("#idle-timeout").value,
        pending_token_threshold: document.querySelector("#token-threshold").value,
        keep_recent_count: document.querySelector("#keep-recent").value,
        min_commit_interval_seconds: 60
      }
    });
  }

  function renderConfig(configValue) {
    const config = core.normalizeConfig(configValue);
    document.querySelector("#enabled").checked = config.enabled;
    document.querySelector("#server-url").value = config.serverUrl;
    document.querySelector("#api-key").value = config.apiKey;
    document.querySelector("#agent-id").value = config.agentId;
    document.querySelector("#auth-mode").value = config.authMode;
    document.querySelector("#auto-commit-enabled").checked = config.autoCommitEnabled;
    document.querySelector("#message-threshold").value = config.autoCommitPolicy.message_count_threshold;
    document.querySelector("#idle-timeout").value = config.autoCommitPolicy.idle_timeout_seconds;
    document.querySelector("#token-threshold").value = config.autoCommitPolicy.pending_token_threshold;
    document.querySelector("#keep-recent").value = config.autoCommitPolicy.keep_recent_count;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    resultBox.hidden = true;
    let saved = false;
    try {
      const config = collectConfig();
      if (!config.serverUrl) throw new TypeError("请填写 OpenViking Server 地址");
      document.querySelector("#server-url").value = config.serverUrl;
      const granted = await requestOriginPermission(config.serverUrl);
      if (!granted) throw new Error("浏览器未授予该 OpenViking Server 的访问权限");
      await storageSet(core.CONFIG_KEY, config);
      saved = true;
      await sendMessage({ type: "CONFIG_UPDATED", payload: {} });
      const response = await sendMessage({ type: "TEST_CONNECTION", payload: { config } });
      if (!response || !response.ok) throw new Error(response && response.error || "连接测试失败");
      const version = response.result && response.result.version ? `，版本 ${response.result.version}` : "";
      showResult(`设置已保存，OpenViking 连接成功${version}。`, "success");
    } catch (error) {
      const prefix = saved ? "设置已保存，但连接测试失败" : "设置未保存";
      showResult(`${prefix}：${core.safeErrorMessage(error)}`, "error");
    } finally {
      saveButton.disabled = false;
    }
  });

  storageGet(core.CONFIG_KEY)
    .then((config) => renderConfig(config || core.DEFAULT_CONFIG))
    .catch((error) => showResult(core.safeErrorMessage(error), "error"));
})();
