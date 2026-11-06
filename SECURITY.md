# 安全说明

本说明适用于 [JenkinWoo/sheeridVerify](https://github.com/JenkinWoo/sheeridVerify)。

## 部署与数据

- 公网部署使用 HTTPS，并通过 `ONE_WEB_PASSWORD` 设置独立的强密码；不要使用代码中的默认密码。
- 仅向获得授权的人员开放入口，按需增加网络访问限制。本项目使用共享密码，不提供多租户隔离或个人账号权限管理。
- 保持 Node.js、依赖及浏览器更新；升级后运行相关测试。
- 将 `config/*.local.json`、`.env.web`、材料和 `.runs/` 保持为私有文件，限制读取权限，按实际需求清理和备份。
- 不把配置文件或材料目录作为静态网站目录发布。环境变量模板仅为示例，不应包含真实凭据。

配置与示例见 [部署指南](docs/DEPLOYMENT.md)。

## 漏洞报告

如仓库启用了 GitHub Private vulnerability reporting，请从仓库的 **Security → Advisories → Report a vulnerability** 私下报告。若该入口不可用，请先在 Issue 中仅请求维护者提供私下联系渠道，不要公开漏洞细节、利用代码或真实数据。

报告应包括影响范围、受影响版本、在本地模拟环境中的复现步骤和建议修复方式。不要测试未经授权的第三方系统，也不要为演示问题而读取、修改或提交他人资料。仓库目前未承诺特定响应时限或历史版本支持周期。
