(function initContentCore(root, factory) {
  root.OpenVikingSyncCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function contentCoreFactory() {
  "use strict";

  function normalizeMessageContent(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t ]+$/gm, "")
      .replace(/^\n+|\n+$/g, "");
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

  return { normalizeMessageContent, getConversationId };
});
