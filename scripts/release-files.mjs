// Explicit publication allowlist. Never recursively publish the development tree.
export const v1Files = [
  'manifest.json',
  'assets/icon.svg','assets/icon-16.png','assets/icon-32.png','assets/icon-48.png',
  'assets/icon-128.png','assets/icon-256.png','assets/icon-512.png',
  'src/shared/core.js','src/shared/content-core.js',
  'src/content/content.js','src/content/extractor.js',
  'src/background/openviking-client.js','src/background/service-worker.js','src/background/state-store.js',
  'src/options/options.html','src/options/options.js','src/options/options.css',
  'src/popup/popup.html','src/popup/popup.js','src/popup/popup.css'
];
export const v2Files = [
  'src/shared/core.js','src/capture/bridge.js','src/capture/relay.js','src/capture/parser.js',
  'src/background/message-store.js','src/background/v2-service-worker.js',
  'src/popup/v2-popup.html','src/popup/v2-popup.js','src/popup/v2-popup.css','src/popup/popup.css'
];
export const v2SyncFiles = [
  'src/shared/sync-status.js','src/background/status-badge.js','src/popup/v2-sync-popup.css',
  'src/shared/core.js','src/shared/source-time.js','src/capture/parser.js',
  'src/capture/signed-bridge.js','src/capture/signed-relay.js',
  'src/background/message-store.js','src/background/v2-sync-worker.js','src/background/openviking-client.js',
  'src/background/capture-auth.js','src/background/reconcile.js','src/background/sync-engine.js',
  'src/options/v2-options.html','src/options/v2-options.js','src/options/options.css',
  'src/popup/v2-sync-popup.html','src/popup/v2-sync-popup.js','src/popup/popup.css'
];
export const publicFiles = [...new Set([
  ...v1Files,...v2Files,...v2SyncFiles,'manifest.v2-preview.json','manifest.v2.json','manifest.v1.json',
  'README.md','LICENSE','SECURITY.md','PRIVACY.md','CONTRIBUTING.md','.gitignore',
  'package.json','package-lock.json',
  '.github/workflows/ci.yml','.github/ISSUE_TEMPLATE/bug_report.md','.github/pull_request_template.md',
  'docs/public/ARCHITECTURE.md','docs/public/TESTING.md','docs/public/RELEASING.md',
  'src/diagnostics/p0-server-test.html','src/diagnostics/p0-server-test.js',
  'poc/reconcile-snapshot.js',
  'poc/chrome-capture/README.md','poc/chrome-capture/manifest.json',
  'poc/chrome-capture/bridge.js','poc/chrome-capture/relay.js','poc/chrome-capture/parser.js',
  'poc/chrome-capture/background.js','poc/chrome-capture/popup.html',
  'poc/chrome-capture/popup.js','poc/chrome-capture/popup.css',
  'test/core.test.js','test/state-store.test.js','test/openviking-client.test.js',
  'test/p0-capture.test.js','test/p0-reconcile.test.js','test/p0-server-test.test.js',
  'test/message-store.test.js','test/v2-worker.test.js','test/v2-sync.test.js','test/v2-integration.test.js',
  'test/sync-status.test.js','test/v2-popup.test.js',
  'scripts/build-v2-preview.mjs','scripts/build-v2.mjs','scripts/validate-extension.mjs',
  'scripts/release-files.mjs','scripts/audit-public.mjs','scripts/package-release.mjs',
  'scripts/release.test.mjs'
])].sort();
