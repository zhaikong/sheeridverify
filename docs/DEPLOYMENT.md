# 部署指南

项目仓库：[JenkinWoo/sheeridVerify](https://github.com/JenkinWoo/sheeridVerify)。

本指南面向获得授权的学校教学、学术研究和流程测试。使用前阅读 [免责声明](../DISCLAIMER.md)；使用真实资料前确认授权和数据处理方式。

## 文件与运行要求

| 文件 | 作用 |
| --- | --- |
| `config/sheerid.example.json` | 应用配置模板，复制为 `config/sheerid.local.json` 后编辑 |
| `deploy/.env.web.example` | Web 监听地址、HTTPS 入口与密码模板 |
| `deploy/one-web.service` | systemd 用户服务，默认安装路径 `/data/workspace/one` |
| `deploy/nginx.conf.example` | 自管 Linux 服务器的 HTTPS 反向代理示例 |

需要 Node.js >= 22.15、npm、适用于当前系统的 Camoufox，以及浏览器所需的系统库。有界面模式还需要可用的桌面会话。systemd 配置用于支持用户服务的 Linux 环境；Windows 本地运行不使用它。

下面假定 Linux 程序位于 `/data/workspace/one`。如果安装到其他目录，需要同时修改服务的 `WorkingDirectory`、`EnvironmentFile` 和 `ExecStart`。配置文件相对于工作目录解析。

`one` 是现有部署目录名，`one-web` 是服务名，`ONE_WEB_*` 是当前环境变量前缀，与 GitHub 项目名称无关；更新项目名称无需迁移已有部署。首次部署可用 `git clone https://github.com/JenkinWoo/sheeridVerify.git /data/workspace/one` 将仓库克隆到本指南约定的位置。

## 本地准备

在仓库根目录安装依赖与浏览器：

```bash
npm ci
npm run browser:install
```

Windows PowerShell 复制配置：

```powershell
Copy-Item config/sheerid.example.json config/sheerid.local.json
```

Linux 复制配置并限制权限：

```bash
cp -n config/sheerid.example.json config/sheerid.local.json
chmod 600 config/sheerid.local.json
```

已有个人配置时直接编辑原文件，不要覆盖。至少确认 `data.country`、`data.organization.name`、`data.organization.optionText` 和 `data.organization.emailDomain`。邮箱后缀用于生成本次表单邮箱，不代表邮箱或学校身份已获认证。材料使用真实且已获授权的文件，`document.path` 与 `document.url` 只能设置其中一个。

配置必须是标准 JSON，不支持 `//` 注释、单引号或尾随逗号。快速检查 JSON 语法：

```bash
node --input-type=module -e 'import {readFile} from "node:fs/promises"; JSON.parse((await readFile("config/sheerid.local.json", "utf8")).replace(/^\uFEFF/, "")); console.log("JSON OK");'
```

以上语法检查命令适用于 Bash；Windows 可直接运行 `npm run web` 查看配置加载错误。通过语法检查不等于所有业务字段均有效，新任务入队时还会校验配置。

启动本地服务：

```bash
npm run web
```

打开 `http://127.0.0.1:8787`。开发时默认访问密码为 `JenkinWoo`；公网部署必须设置自己的密码。按 Ctrl+C 停止。端口占用时可用 `npm run web -- --port 8788`；以下 systemd 和代理示例均使用默认端口 8787。

## Instabox 部署

将仓库代码上传或检出到 `/data/workspace/one`，然后执行：

```bash
cd /data/workspace/one
npm ci
npm run browser:install
cp -n config/sheerid.example.json config/sheerid.local.json
chmod 600 config/sheerid.local.json
cp -n deploy/.env.web.example .env.web
chmod 600 .env.web
```

编辑应用配置与 `.env.web`，不要覆盖已有凭据。Instabox 公网端口入口使用：

```dotenv
ONE_WEB_HOST=0.0.0.0
ONE_WEB_PUBLIC_ORIGIN=https://你的8787端口HTTPS域名
ONE_WEB_PASSWORD=替换为独立的随机密码
```

`ONE_WEB_PUBLIC_ORIGIN` 必须与实际访问的 HTTPS 域名一致，不含路径、查询参数或账号密码。使用 Instabox 分配的端口域名，不要填写 SSH 域名。可在终端执行以下命令生成密码，然后自行写入 `.env.web`：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

模板中的密码占位符不会自动替换，程序也不会自动拒绝该占位符，启动前必须自行更换。有界面浏览器使用 `DISPLAY=:1`，确保 Instabox 的 Computer 桌面可用；所附服务文件已设置该变量。

安装用户服务前检查 Node.js 路径：

```bash
command -v node
node --version
systemctl --user show-environment >/dev/null
```

`deploy/one-web.service` 使用 `/usr/local/bin/node`。如果实际路径不同，请修改服务文件的 `ExecStart`。安装并启动：

```bash
mkdir -p ~/.config/systemd/user
install -m 644 deploy/one-web.service ~/.config/systemd/user/one-web.service
systemctl --user daemon-reload
systemctl --user enable --now one-web
systemctl --user status one-web --no-pager
```

用户服务能否在退出登录或机器重启后继续运行，取决于宿主的用户服务生命周期。在支持的自管主机上可由管理员按需执行 `sudo loginctl enable-linger "$USER"`；托管平台按平台规则处理。用户服务可启动并不代表桌面会话一定就绪。

通过公网入口打开页面并输入设置的访问密码。首页可公开读取，API 需要密码或会话 Cookie。不要用“首页返回 200”代替登录及任务接口检查。

## 自管 Linux 与 Nginx

按前面的步骤安装应用、配置和用户服务。使用同机 Nginx 时，在 `.env.web` 中保留 `ONE_WEB_HOST=127.0.0.1`，将 `ONE_WEB_PUBLIC_ORIGIN` 改为自己的 HTTPS 域名，并设置强密码。这样应用只监听本机，Nginx 提供公网入口。

1. 配置域名 DNS，使其指向服务器，并取得该域名的有效 TLS 证书。
2. 将 [Nginx 模板](../deploy/nginx.conf.example) 放入服务器实际使用的 Nginx 配置目录。
3. 替换 `server_name`、HTTP 跳转域名和证书路径；域名应与 `.env.web` 一致。
4. 执行 `sudo nginx -t`，检查成功后执行 `sudo systemctl reload nginx`。
5. 确认页面、登录、队列查询均正常，并限制不必要的网络访问。

Nginx 通过 `Host` 转发域名，应用会验证 Host、Origin 和写请求令牌。不要通过删除应用来源检查来解决代理配置错误。Instabox 已提供 HTTPS 端口入口时，无需额外部署 Nginx。

有桌面的 Linux 使用真实的 `DISPLAY`，并相应修改服务配置。无桌面的服务器可在应用配置中设置 `"browser": { "headless": true, "keepOpen": false, "autoFill": true }`；需要用户交互的步骤仍需可操作的浏览器环境，不保证无界面模式能完成所有流程。

## 更新与重新启动

先停止或等待当前任务完成。队列和历史只保存在内存中，停止或重启服务会终止任务并清空队列，不会自动恢复远端操作。

1. 备份现有代码以及私有配置，将备份保存在受限目录中。
2. 更新代码，保留 `config/sheerid.local.json`、`.env.web`、材料和运行记录；不要用示例配置覆盖它们。
3. 依赖变化时运行 `npm ci`；浏览器依赖变化时重新执行 `npm run browser:install`。
4. 若修改了服务文件，重新安装文件并执行 `systemctl --user daemon-reload`。
5. 重启并查看状态、日志，随后验证公网登录和队列接口。

```bash
systemctl --user restart one-web
systemctl --user status one-web --no-pager
journalctl --user -u one-web -n 50 --no-pager
```

若更新后启动失败，恢复已备份的代码和对应依赖，再重新启动。旧代码可能不兼容新配置，回滚时也要核对配置字段。

## 配置何时生效

| 修改内容 | 生效时机 |
| --- | --- |
| `config/sheerid.local.json` 中的学校、邮箱后缀、浏览器及轮询配置 | 新任务入队时读取；已有任务保留原配置快照 |
| `web.concurrency` | 服务启动或新任务入队时读取，调低不会中断已有任务 |
| `.env.web` 中的密码、监听地址、HTTPS 域名 | 重启服务后生效 |
| systemd 服务文件 | 重新安装、`daemon-reload` 并重启后生效 |

“恢复任务”沿用该已停止任务原有配置；希望使用新配置时应删除已停止或失败的任务，再重新加入队列。服务重启后网页需重新验证访问密码。

## 常见问题

- **修改配置无效**：确认编辑的是服务工作目录下的 `config/sheerid.local.json`，文件已保存，并且重新创建了任务。邮箱后缀优先读取 `data.organization.emailDomain`，其次为顶层 `emailDomain` 和 `data.emailDomain`；推荐仅在前者设置，避免多处配置冲突。
- **Web 服务启动失败**：检查 JSON 是否包含注释或尾随逗号，以及 `web.concurrency` 是否为正整数；再检查配置权限、Node.js 路径和服务日志。
- **端口被占用**：先查看是否已有 `one-web` 服务或手动运行的实例，不要同时启动多个监听 8787 的进程。
- **浏览器打不开**：在运行服务的系统执行浏览器安装，确认系统库、桌面、`DISPLAY` 和文件权限；不要复制另一操作系统的浏览器缓存。
- **公网 API 返回 403**：检查实际域名、`ONE_WEB_PUBLIC_ORIGIN`、代理转发的 Host；重启后刷新页面获取新的会话与写请求令牌。
- **页面显示旧内容**：确认访问的是预期部署的域名，代码已更新；刷新页面并检查代理缓存配置。
- **失败任务不能重新提交**：选中失败任务，点击“删除当前任务”，再提交原链接。删除不会撤销第三方平台已经完成的操作。

应用配置、`.env.web` 和 `.runs/` 不应提交到 Git。发布前可用 `git ls-files` 核对跟踪文件；被 `.gitignore` 忽略不等于已上传的历史内容会自动消失。
