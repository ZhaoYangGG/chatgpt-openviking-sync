import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDirectory);
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = [];

function requireFile(relativePath, label) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    errors.push(`${label} 指向不存在的文件：${relativePath}`);
  }
}

if (manifest.manifest_version !== 3) errors.push("manifest_version 必须为 3");
requireFile(manifest.background?.service_worker, "background.service_worker");
requireFile(manifest.action?.default_popup, "action.default_popup");
requireFile(manifest.options_ui?.page, "options_ui.page");

for (const entry of manifest.content_scripts || []) {
  for (const script of entry.js || []) requireFile(script, "content_scripts.js");
}
for (const iconPath of Object.values(manifest.icons || {})) requireFile(iconPath, "icons");
for (const iconPath of Object.values(manifest.action?.default_icon || {})) requireFile(iconPath, "action.default_icon");

const contentScriptSources = (manifest.content_scripts || [])
  .flatMap((entry) => entry.js || [])
  .map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8"))
  .join("\n");
if (/apiKey|Authorization|X-API-Key/.test(contentScriptSources)) {
  errors.push("ChatGPT content script 不应包含凭据或认证 Header 处理逻辑");
}

const backgroundSources = [
  "src/shared/core.js",
  manifest.background?.service_worker,
  "src/background/openviking-client.js",
  "src/background/state-store.js"
].filter(Boolean).map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8")).join("\n");
if (/commitSession\s*\(|\/sessions\/\$\{[^}]+\}\/commit/.test(backgroundSources)) {
  errors.push("插件后台不应主动调用 Session commit；自动整理必须由 OpenViking 服务端策略负责");
}
if (/message\.peer_id\s*=|X-OpenViking-Actor-Peer/.test(backgroundSources)) {
  errors.push("插件后台不应发送消息级 peer_id 或 X-OpenViking-Actor-Peer");
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log("WebExtension manifest 与文件引用验证通过。");
