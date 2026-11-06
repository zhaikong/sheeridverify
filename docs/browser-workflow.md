# 历史浏览器流程说明

本文件保留原浏览器实现的说明；其中 npm start / npm run submit 的历史用法已不适用，当前命令行为以根目录 README.md 为准。浏览器实现仍可通过库入口 runAutomation 调用。

# Camoufox 应用自动化

Node.js ESM 项目，复用现有 `camoufox` / `playwright-core`，不引入运行依赖。首个适配器负责 SheerID 学生信息表单，浏览器层与业务适配器分离。

## 使用

要求 Node.js >= 22.15。首次安装：

```powershell
npm ci
npm run browser:install
```

现有 Windows 浏览器安装补丁保留在 `scripts/install-browser.js` 中，仅适用 Camoufox 0.5.9；升级该依赖时需同步检查补丁。

本工作区已生成 `config/sheerid.local.json` 并写入提供的验证链接；该文件被 Git 忽略。新工作区可复制示例：

```powershell
Copy-Item config/sheerid.example.json config/sheerid.local.json
```

填写本地配置中的国家、姓名、邮箱、出生日期（`YYYY-MM-DD`）和学校信息。`data.country` 是必填项，例如 `United States` 或 `US`，当前页面未选国家时会禁用学校输入框。`organization.name` 是搜索文本，`organization.optionText` 推荐填写带城市/州的完整候选名称，例如搜索 `Marshall University`、选项填 `Marshall University Huntington, WV`。仅填写本人或获授权提交的信息。

学校选项优先完整匹配，并兼容逗号与空白分隔符差异：页面选项把校名和地点显示在两个文本块中，其可访问名称是 `Marshall University Huntington, WV`，而选中后的输入框可能显示 `Marshall University, Huntington, WV`。兼容匹配保留所有校名、城市及州的文字，并要求候选唯一。

当 `optionText` 与搜索校名 `name` 相同时，也允许唯一的“完整校名 + 逗号或括号中的地点”候选，或具有独立完整校名文本块的候选；不会通过任意子串或默认第一项选学校。如果匹配多个校区，记录 `AMBIGUOUS_OPTION`，此时请填写完整候选名称。显式填写了完整校区名称时，不使用地点后缀回退。

```powershell
# 自动填写并提交一次
npm run submit

# 指定其他配置
npm run submit -- --config config/sheerid.local.json

# 只填写、不点击提交；完成后保留浏览器供查看或手动操作
npm start
```

可以使用 `$env:AUTOMATION_URL = '完整验证链接'` 覆盖配置 URL。链接需要包含 `verificationId`；过期链接需更新。所有相对路径基于启动命令时的工作目录。

### 启动前查询验证状态

`npm start` 和 `npm run submit` 都先从有效配置 URL 提取 `verificationId`，通过 Node.js 内置 `fetch` 请求 `GET https://my.sheerid.com/rest/v2/verification/{verificationId}`。验证 ID 不写死在代码中，也不需要另配接口 URL。只有接口返回 `currentStep: collectStudentPersonalInfo` 且 `errorIds` 为空，才校验表单资料并启动 Camoufox。

| 接口步骤/结果 | 行为 |
| --- | --- |
| `collectStudentPersonalInfo` 且无错误 | 校验资料，打开浏览器，填写；提交模式再提交一次 |
| `success` | 记录 `verified`，不打开浏览器 |
| `docUpload` / `sso` / `emailLoop` / `pending` | 报告需要材料、学校登录、邮件验证或等待审核，不打开浏览器 |
| `error` 或非空 `errorIds` | 记录 `rejected` 和错误码，不打开浏览器 |
| 其他步骤 | 记录 `not_actionable`，不打开浏览器 |
| 请求失败、超时、HTTP 错误、JSON/字段异常、返回 ID 不匹配 | 报告状态检查错误，不打开浏览器 |

`timeouts.apiMs` 默认 20000 毫秒，覆盖请求及读取 JSON；可配置范围 1000–300000。请求只读、不自动重试、不跟随跳转，失败时不会回退到浏览器尝试。状态检查阶段为 `preflight`；结果包含 `browserOpened`，正常状态响应还包含 `currentStep`、`errorIds`，不保存接口原始内容。无需填写的状态不要求个人资料完整，结果保存后直接释放任务锁并退出。已有浏览器进程不会被这项检查关闭。

状态可能在检查后发生变化，因此打开页面后仍保留错误页检查和提交按钮就绪判断。此次开发仅直接查询了用户指定的状态接口，未运行填表或提交测试。

有界面模式默认保留浏览器，填写、提交或执行失败后均不会自动关闭已有页面。完成后会出现 `browser_kept_open` 日志，脚本继续等待；可手动查看、修改或继续操作页面。关闭任务标签页/窗口，或在终端按 Ctrl+C，才会结束等待并清理浏览器及任务锁。已有配置不必修改；如果需要自动关闭，设置 `browser.keepOpen: false`。无界面模式默认自动关闭，不允许设置 `keepOpen: true`。

### 每次启动的会话与指纹

每次运行都新建 Camoufox 浏览器进程，再用 Camoufox `NewContext()` 生成并安装新的上下文指纹。启动时显式禁用持久化上下文和固定预设，不传入已保存指纹、用户资料目录或 `storageState`，因此不会恢复上次的 Cookie、本地存储或登录状态。日志中的 `browser_identity_created` / `FRESH_CONTEXT` 表示该创建流程已完成，并非检测网站的指纹唯一性证明。

Camoufox 0.5.9 在未传入固定指纹/预设时默认重新随机生成，`NewContext()` 也会重新生成上下文指纹。随机生成并不保证每个字段变化或绝对无重复；浏览器版本、配置语言、操作系统及部分硬件相关值可能保持相同。本改动未启用代理，出口 IP 不会因此自动改变。浏览器窗口保持打开时，刷新或继续操作仍属于当前上下文；关闭后重新启动才创建新的上下文。

浏览器会话与 SheerID 验证会话不同：配置 URL 中相同的 `verificationId` 仍对应服务器上的同一笔验证，换浏览器指纹不会创建新的验证记录。此次调整依据已安装依赖源码完成，未启动多轮浏览器或运行指纹差异测试。

国家、月份和学校同时支持原生 select 与具有 ARIA `option` 的自定义下拉框。自定义下拉框会展开菜单并选择对应选项，不会只写入输入框文字。国家的完整名称和学校 `optionText` 应与页面显示文字一致；两位国家代码和出生月份会按 `browser.locale` 转换为选项文字，请使该配置与页面语言一致（当前页面为英语，默认 `en-US`）。可选 `data.consent: true` 用于勾选页面上的同意项，未配置时不操作该字段。

### 随机填写间隔

默认逐字输入，每字符随机间隔 40–120 毫秒；每个字段开始前和自定义下拉选项点击前随机等待 500–1200 毫秒；提交前随机等待 1000–2000 毫秒。普通文本填写完成后失焦以触发表单校验。等待和输入支持 Ctrl+C 取消，不会因重试自动再次提交。

旧配置直接使用默认值。可在本地 JSON 的顶层添加 `interaction` 调整（下方为配置片段）：

```json
{
  "interaction": {
    "keyDelayMs": { "min": 40, "max": 120 },
    "fieldDelayMs": { "min": 500, "max": 1200 },
    "submitDelayMs": { "min": 1000, "max": 2000 }
  }
}
```

单位均为毫秒，`min` 和 `max` 必须是整数且 `0 <= min <= max`；字符间隔最大 1000，其他间隔最大 10000。将某项的 min/max 都设为 0 可关闭该项等待。`interaction_delay` 日志报告字段名和本次间隔，不记录输入内容。

### 页面加载与动态表单等待

自动填写的执行顺序为 `preflight` 查询接口确认需要填写 → 校验资料 → 打开页面 → `wait_ready` 等待页面 `load`、国家控件可用及姓名/邮箱可编辑 → `fill` 选择国家 → 等待学校输入框启用并选择学校 → 填写姓名 → 填写生日（月、日、年）→ 填写邮箱 → 可选提交。初始阶段不等待尚被禁用的学校输入框，以免产生循环等待。国家和月份的只读下拉控件只要求可用，不要求能够输入文本。学校搜索结果单独等待精确匹配选项。

`timeouts.readyMs` 默认 **120000 毫秒**，现有本地配置不用修改就会生效；可在 `timeouts` 中显式设置，范围为 1000–300000。页面加载和首轮表单检查共享该预算，之后动态字段各自使用该等待预算。`actionMs` 仍用于普通操作，`navigationMs` 用于初始导航。

日志出现 `form_ready` 后才进入填写；`field_started` / `field_filled` 显示当前操作的字段名，`waiting_for_fields` 会在待就绪字段变化或每隔 10 秒时报告等待状态，不记录字段值。超过等待时间会记录 `PAGE_LOAD_TIMEOUT` 或 `FORM_NOT_READY`；后者列出未出现或不可操作的字段。下拉选项未匹配时报告 `OPTION_NOT_FOUND` 及字段名。如果页面已经显示而字段仍无法匹配，需要调整选择器，单纯增加等待时间不能解决选择器不匹配。

提交前等待按钮启用，最多使用 `readyMs` 的等待预算，并每 10 秒报告 `waiting_for_submit`；持续禁用或无法点击会报告 `SUBMIT_NOT_READY`。当前页面的 `#sid-step-error`（例如 “We couldn't continue your verification”）会被识别为 `VERIFICATION_UNAVAILABLE`，停止自动操作并保留窗口。随机延迟不会解除服务端拒绝，需按页面提示处理。日志会在浏览器保持打开时立即显示已分类错误的说明；本工具不强制启用按钮或自动重新发起验证。

## 当前验证范围

已查看用户打开的实际页面，核对学校 `sid-college-name`、生日 `sid-birthdate-day` / `sid-birthdate-year`、国家及月份下拉框和提交按钮的控件标识，并据此修正适配器。按要求未运行自动化测试或重新执行填表/提交流程；下拉选择交互和提交响应仍未端到端验证。目标表单可能因地区、语言或项目设置而不同。选择器集中在 `src/apps/sheerid/selectors.js`，也可以在 JSON 中逐字段覆盖：

```json
{
  "selectors": {
    "firstName": ["input[name='firstName']"],
    "submit": ["form#student-form button[type='submit']"]
  }
}
```

以上只是配置片段，应合并进完整配置。数组按优先级查找可见元素，匹配多个元素会报错，避免选错表单。提交结果监听的是同一 verificationId 的 `POST /rest/v2/verification/{id}/step/collectStudentPersonalInfo`；若该项目使用不同端点，需要修改适配器。只有接口明确返回 `currentStep: success` 才标记审核通过。

## 结果与运行管理

标准输出包含最终 JSON；标准错误输出结构化事件日志。`.runs/<runId>.json` 保存结果，不保存姓名、邮箱、学校、出生日期、验证链接或接口原始内容，也不自动生成截图、HAR、trace。

| 状态 | 含义 | 退出码 |
| --- | --- | --- |
| `filled` | 仅完成填写 | 0 |
| `verified` | 接口明确确认验证成功 | 0 |
| `document_required` / `sso_required` / `email_required` | 需要材料、学校登录或邮件验证 | 2 |
| `pending` | 等待审核 | 2 |
| `not_actionable` | 接口返回不支持的步骤，未启动浏览器 | 2 |
| `validation_failed` / `rejected` / `failed` | 字段校验、服务拒绝或执行失败 | 1 |
| `submission_unknown` | 已尝试提交，但无法确认结果 | 3 |

收到中断信号时退出码为 130。后续材料上传、学校登录、邮件验证及验证码由使用者继续处理，本适配器只实现初始个人信息提交。

每次运行只点击一次，不自动重试提交。点击前先写入 `submission_unknown` 记录，防止崩溃留下虚假的成功结果。超时或中断后先检查验证页面/结果记录，再决定是否重跑，不能把未知结果当作提交失败。任务锁按验证 ID 的 SHA-256 创建，阻止共享同一 `.runs` 目录的进程同时操作同一会话；它不提供跨机器分布式锁或跨运行业务幂等。异常终止后可能留下 `.lock`，确认记录中的 PID 不再运行后再手动删除对应锁文件。

自动化步骤结束后立即保存结果；浏览器保留期间仍持有任务锁，防止另一进程重复操作同一会话。手动操作不会改写自动化结果；库调用和 CLI 最终标准输出会等窗口关闭后返回。运行中或保留窗口期间收到 SIGINT/SIGTERM 会尝试关闭已启动浏览器并释放任务锁；启动阶段的中断需等启动返回后释放资源。个人配置、运行目录均被 Git 忽略，实际文件访问权限由本机账户/Windows ACL 管理。

## 扩展应用

```text
src/
  cli.js                  命令行参数、信号、退出码
  index.js                库入口
  core/                   配置校验、错误、日志、结果存储、执行器
  browser/                Camoufox 生命周期、通用表单操作
  apps/
    registry.js           应用注册表
    sheerid/              SheerID 校验、字段和提交结果解释
config/                   示例及私有本地配置
```

新增 `src/apps/<app>/index.js` 并在注册表中注册，提供以下接口：

```javascript
export const application = {
  validate(config) {},             // 校验 URL 等状态查询所需的基础配置
  identity(config) { return 'application:session-key'; },
  async preflight({ config, signal, log }) { // 可选：在启动浏览器之前查询状态
    return { proceed: true };      // 或 { proceed: false, outcome: { status, code, message } }
  },
  validateInput(config) {},        // 可选：仅在需要打开浏览器时校验表单资料
  async waitUntilReady({ page, config, signal }) {}, // 可选：页面和业务表单就绪条件
  async fill({ page, config, log, signal }) {},
  async submit({ page, config, markSubmissionAttempted }) {
    // 在可能产生远端写入之前记录；之后发生的异常按结果未知处理。
    await markSubmissionAttempted();
    // 执行提交并判断业务结果。
    return { status: 'pending', code: 'AWAITING_REVIEW' };
  },
};
```

应用必须在提交前调用并等待 `markSubmissionAttempted()`，不要自动重试远端写操作。新状态需同步扩展 CLI 退出码映射。适配器仅返回不含个人数据的状态及固定错误码。

也可直接从其他应用调用：

```javascript
import { loadConfig, runAutomation } from './src/index.js';
const config = await loadConfig('config/sheerid.local.json');
const result = await runAutomation(config, { submit: true });
```

后续按实际业务需求增加队列、数据库或 HTTP 服务即可复用执行器；当前实现是单任务 CLI/库，不包含后台服务或分布式调度。
