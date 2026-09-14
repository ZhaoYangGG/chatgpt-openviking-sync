# 发布与脱敏

scripts/release-files.mjs 为公开白名单，拒绝符号链接。只导出源码、合成测试和公开文档，不带私人研究、聊天证据、桌面采集、依赖或 profile。

```bash
npm ci --ignore-scripts
npm test
npm run validate
npm run build:v2
npm run test:release
node scripts/package-release.mjs --output dist/release-v2
node scripts/audit-public.mjs dist/release-v2/source
```

已存在目标拒绝覆盖。公开源码根 manifest 使用完整 V2，原开发目录的 V1 不被切换。生成 V2 安装 ZIP、源码 ZIP 和 SHA256SUMS；不再把 V1/旧 preview 作为当前推荐发布包。

ZIP 使用固定时间戳，不带本机 UID/GID/扩展属性；PNG 剥离 EXIF/文本元数据而不改像素。扫描检查路径、凭据特征、邮件/真实形状会话 ID、PNG 元数据和白名单，不能代替人工语义复核。

只从已审计的 source 目录创建 Git 历史。用项目级作者，不带个人姓名/邮箱。不发布原始诊断、截图或浏览器配置。GitHub 仍展示仓库所属账号，脱敏不等于平台匿名。

0.2.1 为完整功能测试版：描述采集范围、非实时、尽力去重、MAIN 信任边界和实机覆盖，不把自动测试等同于真实服务/浏览器已验收。
