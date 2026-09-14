"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/shared/core.js");
const {
  StabilityTracker,
  parseTurnIndex,
  parseDateSeparatorLabel,
  findSourceMessageId,
  isContiguousFromStart
} = require("../src/content/extractor.js");

test("从普通和自定义 GPT URL 识别 Conversation ID", () => {
  assert.equal(core.getConversationId("https://chatgpt.com/c/12345678-abcd"), "12345678-abcd");
  assert.equal(
    core.getConversationId("https://chatgpt.com/g/g-example/c/conversation_123?model=gpt-5"),
    "conversation_123"
  );
  assert.equal(core.getConversationId("https://chatgpt.com/"), null);
  assert.equal(core.getConversationId("https://example.com/c/12345678"), null);
});

test("Session ID 确定、保守且不超过 128 字符", () => {
  assert.equal(core.buildSessionId("abc-def_123"), "chatgpt_abc_def_123");
  assert.equal(core.buildSessionId("abc-def_123"), core.buildSessionId("abc-def_123"));
  assert.match(core.buildSessionId("conversation/with spaces"), /^[A-Za-z][A-Za-z0-9_]*$/);
  assert.ok(core.buildSessionId("a".repeat(300)).length <= 128);
});

test("消息指纹只由 Conversation 与 ChatGPT 消息 ID 决定", () => {
  const base = { role: "assistant", sourceMessageId: "msg-1", ordinal: 1, content: "hello" };
  const fingerprint = core.createMessageFingerprint(base, "c1");
  assert.equal(fingerprint, core.createMessageFingerprint({ ...base, content: "hello!" }, "c1"));
  assert.equal(fingerprint, core.createMessageFingerprint({ ...base, ordinal: 20, role: "user" }, "c1"));
  assert.notEqual(fingerprint, core.createMessageFingerprint(base, "c2"));
  assert.notEqual(fingerprint, core.createMessageFingerprint({ ...base, sourceMessageId: "msg-2" }, "c1"));
  assert.throws(() => core.createMessageFingerprint({ content: "no id" }, "c1"), /稳定/);
});

test("Conversation turn 只负责数字顺序，日期分组可生成历史 created_at", () => {
  assert.equal(parseTurnIndex("conversation-turn-12"), 12);
  assert.equal(parseTurnIndex("conversation-turn-x"), null);
  const now = new Date("2026-08-17T06:00:00.000Z");
  const today = parseDateSeparatorLabel("今天 13:01", now);
  assert.equal(today, new Date(2026, 7, 17, 13, 1).toISOString());
  assert.equal(
    parseDateSeparatorLabel("2026年8月16日 09:30", now),
    new Date(2026, 7, 16, 9, 30).toISOString()
  );
  assert.equal(
    parseDateSeparatorLabel("星期六 23:30", now),
    new Date(2026, 7, 15, 23, 30).toISOString()
  );
  assert.equal(
    parseDateSeparatorLabel("Saturday 23:30", now),
    new Date(2026, 7, 15, 23, 30).toISOString()
  );
});

test("可见历史允许 ChatGPT 内部 turn 编号跳号和连续 Assistant", () => {
  const turns = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
  const roles = ["user", "assistant", "user", "assistant", "user", "assistant",
    "assistant", "user", "assistant", "user", "assistant"];
  const candidates = turns.map((turnIndex, index) => ({
    turnIndex,
    role: roles[index],
    sourceMessageId: `message-${turnIndex}`,
    identityConflict: false
  }));
  assert.equal(isContiguousFromStart(candidates), true);
  assert.equal(isContiguousFromStart(candidates.slice(1)), false);
});

test("缺少 data-message-id 时保留 turn 顺序但不把 turn 当作消息身份", () => {
  const turn = { getAttribute: () => "conversation-turn-6" };
  const withoutMessageId = {
    hasAttribute: () => false,
    querySelector: () => null,
    closest: (selector) => selector.includes("conversation-turn") ? turn : null
  };
  assert.deepEqual(findSourceMessageId(withoutMessageId), {
    id: "",
    kind: "missing",
    turnIndex: 6
  });

  const withMessageId = {
    hasAttribute: (name) => name === "data-message-id",
    getAttribute: (name) => name === "data-message-id" ? "uuid-6" : null,
    closest: (selector) => selector.includes("conversation-turn") ? turn : null
  };
  assert.deepEqual(findSourceMessageId(withMessageId), {
    id: "uuid-6",
    kind: "message-id",
    turnIndex: 6
  });
});

test("配置规范化保留官方云端与自托管认证选项", () => {
  const config = core.normalizeConfig({
    serverUrl: "https://example.com/openviking/",
    authMode: "bearer",
    autoCommitPolicy: { message_count_threshold: 1, idle_timeout_seconds: 9999999 }
  });
  assert.equal(config.serverUrl, "https://example.com/openviking");
  assert.equal(config.authMode, "bearer");
  assert.equal(config.autoCommitPolicy.message_count_threshold, 2);
  assert.equal(config.autoCommitPolicy.idle_timeout_seconds, 604800);
});

test("默认 Session 自动整理策略保持不变，核心不再提供消息 Peer", () => {
  const config = core.normalizeConfig({});
  assert.deepEqual(config.autoCommitPolicy, {
    pending_token_threshold: 10000,
    message_count_threshold: 20,
    idle_timeout_seconds: 86400,
    keep_recent_count: 2,
    min_commit_interval_seconds: 60
  });
  assert.equal(Object.hasOwn(core, "CHATGPT_PEER_ID"), false);
  assert.equal(Object.hasOwn(core, "actorPeerId"), false);
  assert.equal(core.autoCommitPoliciesEqual(config.autoCommitPolicy, { ...config.autoCommitPolicy }), true);
  assert.equal(core.autoCommitPoliciesEqual(config.autoCommitPolicy, {
    ...config.autoCommitPolicy,
    keep_recent_count: 0
  }), false);
});

test("旧版 8000/600 默认策略在升级时迁移为本版官方 Session 策略", () => {
  const config = core.normalizeConfig({
    autoCommitPolicy: {
      pending_token_threshold: 8000,
      message_count_threshold: 20,
      idle_timeout_seconds: 600,
      keep_recent_count: 2,
      min_commit_interval_seconds: 60
    }
  });
  assert.equal(config.configVersion, 2);
  assert.equal(config.autoCommitPolicy.pending_token_threshold, 10000);
  assert.equal(config.autoCommitPolicy.idle_timeout_seconds, 86400);
});

test("官方云地址统一规范化为文档要求的 OpenViking base URL", () => {
  const expected = "https://api.vikingdb.cn-beijing.volces.com/openviking";
  assert.equal(core.normalizeServerUrl("https://api.vikingdb.cn-beijing.volces.com"), expected);
  assert.equal(core.normalizeServerUrl("https://api.vikingdb.cn-beijing.volces.com/api/v1"), expected);
  assert.equal(core.normalizeServerUrl(`${expected}/health`), expected);
});

test("稳定性追踪器在文本变化后重新计时", () => {
  let now = 1000;
  const tracker = new StabilityTracker(() => now);
  const message = { role: "assistant", sourceMessageId: "m1", ordinal: 1, content: "a" };
  assert.equal(tracker.observe(message), 0);
  now += 1000;
  assert.equal(tracker.observe(message), 1000);
  now += 100;
  assert.equal(tracker.observe({ ...message, content: "ab" }), 0);
});
