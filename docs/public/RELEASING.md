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

1.0.0 作为正式版发布，不设置 GitHub prerelease。发布前必须通过功能回归、脱敏与打包检查、长会话分页补录及重复加载验证；版本号、主界面和文档保持一致。保留采集范围、非实时、跨设备竞态与页面信任边界说明，不将自动测试等同于所有浏览器场景已验收。
