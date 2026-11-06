import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AutomationError } from './errors.js';

const taskLocks = new AsyncLocalStorage();

// A browser-to-document continuation owns the same task until both stages finish.
// Independent calls still acquire the on-disk lock and cannot enter this scope.
export async function withTaskLock(directory, identity, operation) {
  const absoluteDirectory = resolve(directory);
  const current = taskLocks.getStore();
  if (current?.active && current.directory === absoluteDirectory && current.identity === identity) {
    return operation();
  }
  const release = await acquireLock(absoluteDirectory, identity);
  const scope = { directory: absoluteDirectory, identity, active: true };
  try {
    return await taskLocks.run(scope, operation);
  } finally {
    scope.active = false;
    await release();
  }
}

export async function acquireLock(directory, identity) {
  await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(identity).digest('hex');
  const filename = join(directory, `${key}.lock`);
  let handle;
  try { handle = await open(filename, 'wx', 0o600); } catch (cause) {
    throw new AutomationError(cause.code === 'EEXIST' ? 'TASK_LOCKED' : 'STORAGE_ERROR',
      cause.code === 'EEXIST' ? '同一验证任务已锁定；确认旧进程结束后再处理 .runs 中的锁文件' : '无法创建任务锁', { cause });
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } catch (error) {
    await handle.close();
    await unlink(filename);
    throw error;
  }
  await handle.close();
  return () => unlink(filename);
}

export async function saveResult(directory, result) {
  const filename = join(directory, `${result.runId}.json`);
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}
