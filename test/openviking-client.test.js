"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/shared/core.js");
const { OpenVikingClient } = require("../src/background/openviking-client.js");

function fakeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return payload === null ? "" : JSON.stringify(payload); }
  };
}

function config(overrides) {
  return {
    serverUrl: "https://example.com/openviking",
    apiKey: "secret-test-key",
    agentId: "chatgpt-browser",
    authMode: "auto",
    enabled: true,
    autoCommitEnabled: true,
    ...overrides
  };
}

test("自动认证只在 401 后从 Bearer 切换到 X-API-Key", async () => {
  const calls = [];
  const client = new OpenVikingClient(config(), {
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return fakeResponse(401, { status: "error", error: { code: "UNAUTHENTICATED", message: "bad auth" } });
      return fakeResponse(200, { status: "ok", healthy: true, version: "v0.4.12" });
    }
  });
  const result = await client.testConnection();
  assert.equal(result.healthy, true);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-test-key");
  assert.equal(calls[1].options.headers["X-API-Key"], "secret-test-key");
  assert.equal(calls[1].options.headers["X-OpenViking-Agent"], "chatgpt-browser");
});

test("health 被代理层隐藏时使用官方 system status 接口完成只读探测", async () => {
  const calls = [];
  const client = new OpenVikingClient(config({ authMode: "bearer" }), {
    fetch: async (url) => {
      calls.push(url);
      if (calls.length === 1) return fakeResponse(404, { status: "error" });
      return fakeResponse(200, { status: "ok", result: { initialized: true } });
    }
  });
  const result = await client.testConnection();
  assert.equal(result.initialized, true);
  assert.match(calls[0], /\/health$/);
  assert.match(calls[1], /\/api\/v1\/system\/status$/);
});

test("连接探测连续 404 时给出 base URL 与实际探测路径", async () => {
  const client = new OpenVikingClient(config({ authMode: "bearer" }), {
    fetch: async () => fakeResponse(404, null)
  });
  await assert.rejects(
    () => client.testConnection(),
    (error) => {
      assert.equal(error.code, "INVALID_SERVER_BASE_URL");
      assert.equal(error.retryable, false);
      assert.match(error.message, /example\.com\/openviking\/health/);
      assert.match(error.message, /不要包含 \/api\/v1 或 \/health/);
      return true;
    }
  );
});

test("ensureSession 先查询，404 后按官方字段创建确定性 Session", async () => {
  const calls = [];
  const client = new OpenVikingClient(config({ authMode: "bearer" }), {
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return fakeResponse(404, { status: "error", error: { code: "NOT_FOUND", message: "missing" } });
      return fakeResponse(200, { status: "ok", result: { session_id: "chatgpt_c1" } });
    }
  });
  const result = await client.ensureSession("chatgpt_c1");
  assert.equal(result.session_id, "chatgpt_c1");
  assert.match(calls[0].url, /\/api\/v1\/sessions\/chatgpt_c1$/);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.session_id, "chatgpt_c1");
  assert.deepEqual(body.memory_policy, {
    self: { enabled: true },
    peer: { enabled: true }
  });
  assert.equal(body.auto_commit_policy.pending_token_threshold, 10000);
  assert.equal(body.auto_commit_policy.message_count_threshold, 20);
  assert.equal(body.auto_commit_policy.idle_timeout_seconds, 86400);
  assert.equal(body.auto_commit_policy.keep_recent_count, 2);
  assert.equal(body.auto_commit_policy.min_commit_interval_seconds, 60);
});

test("旧 Agent 模式保留原认证 Header 且不与消息级 Peer 混用", async () => {
  let request;
  const client = new OpenVikingClient(config({ authMode: "x-api-key" }), {
    fetch: async (url, options) => {
      request = { url, options };
      return fakeResponse(200, { status: "ok", result: { added: 2 } });
    }
  });
  await client.addMessages("chatgpt_c1", "c1", [
    {
      role: "user", content: "hello", sourceMessageId: "u1", ordinal: 0,
      createdAt: "2026-08-17T01:00:00.000Z", turnId: "turn-1"
    },
    {
      role: "assistant", content: "hi", sourceMessageId: "a1", ordinal: 1,
      createdAt: "2026-08-17T01:01:00.000Z", turnId: "turn-1"
    }
  ]);
  assert.match(request.url, /\/messages\/batch$/);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(body.messages.map((message) => message.content), ["hello", "hi"]);
  assert.match(body.messages[0].source_message_ids[0], /^chatgpt:c1:u1$/);
  assert.equal(body.messages[0].created_at, "2026-08-17T01:00:00.000Z");
  assert.equal(body.messages[1].turn_id, "turn-1");
  assert.equal(Object.hasOwn(body.messages[0], "peer_id"), false);
  assert.equal(Object.hasOwn(body.messages[1], "peer_id"), false);
  assert.equal(request.options.headers["X-API-Key"], "secret-test-key");
  assert.equal(request.options.headers["X-OpenViking-Agent"], "chatgpt-browser");
  assert.equal(Object.hasOwn(request.options.headers, "X-OpenViking-Actor-Peer"), false);
});

test("现代协议的 User 与 Assistant 均不发送消息 Peer 或 Actor Peer Header", async () => {
  let request;
  const client = new OpenVikingClient(config({ authMode: "bearer", agentId: "" }), {
    fetch: async (url, options) => {
      request = { url, options };
      return fakeResponse(200, { status: "ok", result: { added: 2 } });
    }
  });
  await client.addMessages("chatgpt_c1", "c1", [
    { role: "user", content: "hello", sourceMessageId: "u1", createdAt: "2026-08-17T01:00:00.000Z", turnId: "turn-1" },
    { role: "assistant", content: "hi", sourceMessageId: "a1", createdAt: "2026-08-17T01:01:00.000Z", turnId: "turn-1" }
  ]);
  const messages = JSON.parse(request.options.body).messages;
  assert.equal(Object.hasOwn(messages[0], "peer_id"), false);
  assert.equal(Object.hasOwn(messages[1], "peer_id"), false);
  assert.equal(Object.hasOwn(request.options.headers, "X-OpenViking-Actor-Peer"), false);
  assert.equal(Object.hasOwn(request.options.headers, "X-OpenViking-Agent"), false);
});

test("既有 Session 通过 PATCH 更新策略，Task 只使用查询接口恢复", async () => {
  const calls = [];
  const client = new OpenVikingClient(config({ authMode: "bearer", agentId: "" }), {
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/api/v1/tasks?")) {
        return fakeResponse(200, { status: "ok", result: { tasks: [{ id: "task-1", status: "pending" }] } });
      }
      if (url.endsWith("/api/v1/tasks/task-1")) {
        return fakeResponse(200, { status: "ok", result: { id: "task-1", status: "running" } });
      }
      return fakeResponse(200, { status: "ok", result: { auto_commit_policy: core.DEFAULT_CONFIG?.autoCommitPolicy } });
    }
  });
  const policy = {
    pending_token_threshold: 10000,
    message_count_threshold: 20,
    idle_timeout_seconds: 86400,
    keep_recent_count: 2,
    min_commit_interval_seconds: 60
  };
  await client.updateSessionConfig("chatgpt_c1", policy);
  const tasks = await client.listSessionCommitTasks("chatgpt_c1", 20);
  const task = await client.getTask("task-1");
  assert.deepEqual(JSON.parse(calls[0].options.body), { auto_commit_policy: policy });
  assert.equal(calls[0].options.method, "PATCH");
  assert.match(calls[0].url, /\/sessions\/chatgpt_c1\/config$/);
  assert.match(calls[1].url, /task_type=session_commit/);
  assert.match(calls[1].url, /resource_id=chatgpt_c1/);
  assert.equal(tasks[0].id, "task-1");
  assert.equal(task.status, "running");
  assert.equal(calls.some((call) => /\/sessions\/chatgpt_c1\/commit$/.test(call.url)), false);
});

test("对账按 archive 编号后接当前 messages.jsonl 读取完整官方 Session 日志", async () => {
  const calls = [];
  const root = "viking://session/chatgpt_c1";
  const archive1 = `${root}/history/archive_001/messages.jsonl`;
  const archive2 = `${root}/history/archive_002/messages.jsonl`;
  const current = `${root}/messages.jsonl`;
  const contents = new Map([
    [archive1, [
      JSON.stringify({
        role: "user",
        parts: [{ type: "text", text: "one" }],
        created_at: "2026-08-17T01:00:00.000Z",
        turn_id: "turn-1",
        source_message_ids: ["chatgpt:c1:u1"]
      }),
      ""
    ].join("\n")],
    [archive2, `${JSON.stringify({
      role: "assistant",
      content: "two",
      peer_id: "chatgpt_Web",
      source_message_ids: ["chatgpt:c1:a2"]
    })}\n`],
    [current, `${JSON.stringify({
      role: "user",
      content: "three",
      source_message_ids: ["chatgpt:c1:u3"]
    })}\n`]
  ]);
  const client = new OpenVikingClient(config({ authMode: "bearer" }), {
    fetch: async (url) => {
      calls.push(url);
      if (url.includes("/api/v1/fs/ls?")) {
        return fakeResponse(200, {
          status: "ok",
          result: [
            { uri: current, isDir: false },
            { uri: archive2, isDir: false },
            { uri: `${root}/history`, isDir: true },
            { uri: archive1, isDir: false }
          ]
        });
      }
      const uri = new URL(url).searchParams.get("uri");
      return fakeResponse(200, { status: "ok", result: contents.get(uri) });
    }
  });

  const records = await client.readSessionMessages("chatgpt_c1", "c1", { uri: root });
  assert.deepEqual(records.map((record) => record.sourceMessageId), ["u1", "a2", "u3"]);
  assert.deepEqual(records.map((record) => record.content), ["one", "two", "three"]);
  assert.equal(records[0].turnId, "turn-1");
  assert.equal(records[1].peerId, "chatgpt_Web");
  assert.match(calls[0], /recursive=true/);
  assert.match(calls[0], /output=original/);
});

test("Archive 标记和 memory_diff.json 可作为 Task 404 时的状态事实来源", async () => {
  const root = "viking://session/chatgpt_c1";
  const archive = `${root}/history/archive_003`;
  const memoryDiff = `${archive}/memory_diff.json`;
  const client = new OpenVikingClient(config({ authMode: "bearer" }), {
    fetch: async (url) => {
      if (url.includes("/api/v1/fs/ls?")) {
        return fakeResponse(200, { status: "ok", result: [
          { uri: `${archive}/messages.jsonl`, isDir: false },
          { uri: memoryDiff, isDir: false },
          { uri: `${archive}/.done`, isDir: false }
        ] });
      }
      return fakeResponse(200, { status: "ok", result: JSON.stringify({
        memories: { preferences: [{ id: 1 }, { id: 2 }], entities: [{ id: 3 }] }
      }) });
    }
  });
  const state = await client.readSessionArchiveState("chatgpt_c1", { uri: root });
  assert.equal(state.archiveStatus, "done");
  assert.equal(state.archiveUri, archive);
  assert.equal(state.memoryDiffUri, memoryDiff);
  assert.deepEqual(state.memoryCounts, { preference: 2, entity: 1 });
});

test("其他来源消息在对账中保留为空 ID，由状态机判为冲突而非静默忽略", async () => {
  const root = "viking://session/chatgpt_c1";
  const current = `${root}/messages.jsonl`;
  const client = new OpenVikingClient(config({ authMode: "bearer" }), {
    fetch: async (url) => {
      if (url.includes("/api/v1/fs/ls?")) {
        return fakeResponse(200, { status: "ok", result: [{ uri: current, isDir: false }] });
      }
      return fakeResponse(200, {
        status: "ok",
        result: `${JSON.stringify({ role: "user", content: "foreign", source_message_ids: ["cli:1"] })}\n`
      });
    }
  });
  const records = await client.readSessionMessages("chatgpt_c1", "c1", { uri: root });
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceMessageId, "");
});
