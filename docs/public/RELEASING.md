# 发布与脱敏

`scripts/release-files.mjs` 是公开文件白名单。只复制所列常规文件，拒绝符号链接；未列出的私人调研、证据、桌面采集、依赖和浏览器资料不会自动进入包。

```bash
npm ci --ignore-scripts
npm test
npm run validate
npm run package:release
node scripts/audit-public.mjs dist/release/source
```

目标已存在则拒绝覆盖，可指定新 `--output` 目录。ZIP 使用固定时间戳，不附加本机用户和扩展属性，生成 SHA256SUMS。浏览器包只含运行依赖，不含服务写入诊断页。

人工核对：

- 不带凭据、配置、聊天标题正文、真实会话 ID/时间、本机路径、姓名邮箱、profile、截图。
- 测试数据为合成；锁文件不含个人目录或认证 URL。
- 图标无文本/EXIF 元数据。
- 不带旧 Git 历史，首次从隔离目录建仓使用项目级作者，不读取本机个人 Git 身份。
- 检查压缩包与校验值，只从审计通过的 source 目录提交。

扫描不是全部私人语义/凭据识别器，不能替代人工审核。GitHub 仍展示仓库所属账号及平台操作记录；源码提交匿名化不等于平台账号匿名化。

本次只发布 pre-release：V1 0.1.0 / V2 capture preview 0.2.0。Release notes 必须突出 V2 不上传和页面载荷真实性缺口，不把计划写成已完成。
