import { parseArgs } from 'node:util';
import { loadConfig } from './core/config.js';
import { AutomationError } from './core/errors.js';
import { runWorkflow } from './core/workflow.js';

const help = `Usage: npm start -- [--config <path>] [--submit | --status] [--file <path> | --url <url>]

  --config <path>  JSON config (default: config/sheerid.local.json)
  --submit         Submit via the browser or document API, based on the current step
  --status         Query status only; never open a browser or change remote state
  --file <path>    Local PNG/JPEG/PDF; overrides the configured document source
  --url <url>      HTTP/HTTPS PNG/JPEG/PDF; overrides the configured document source
  --help           Show help

Exit codes: 0 filled/verified/manual; 1 failed/rejected; 2 follow-up required;
            3 submission outcome unknown; 130 interrupted.
AUTOMATION_URL overrides the URL in the config file.
AUTOMATION_PROXY overrides proxy in the config file (HTTP/HTTPS/SOCKS5, or "direct").
Without a configured proxy, HTTPS_PROXY/HTTP_PROXY or the enabled Windows system proxy is used.
Default: open and fill the browser only when student information is required.
Set browser.autoFill to false for manual form entry; --submit can still upload documents after that step.
Use --submit for browser submission or API document upload; otherwise material steps are read-only.
After browser submission reaches SSO/document review, --submit continues with the configured document.
SSO may transition to document review through the official cancel-SSO endpoint.
`;

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'config/sheerid.local.json' },
    submit: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    file: { type: 'string' },
    url: { type: 'string' },
    help: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) { process.stdout.write(help); return; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const config = await loadConfig(values.config);
    const result = await runWorkflow(config, {
      submit: values.submit, statusOnly: values.status, file: values.file, url: values.url, signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (controller.signal.aborted) process.exitCode = 130;
    else if (['filled', 'verified', 'manual'].includes(result.status)) process.exitCode = 0;
    else if (['document_required', 'sso_required', 'email_required', 'personal_info_required', 'human_verification_required', 'pending', 'not_actionable'].includes(result.status)) process.exitCode = 2;
    else if (result.status === 'submission_unknown') process.exitCode = 3;
    else process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ status: 'failed',
    code: error instanceof AutomationError ? error.code : 'STARTUP_ERROR',
    message: error instanceof AutomationError ? error.message : '启动或结果保存失败；请检查参数、配置和目录权限',
  })}\n`);
  process.exitCode = 1;
});
