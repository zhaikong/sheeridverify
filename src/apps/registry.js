import { sheerid } from './sheerid/index.js';
import { AutomationError } from '../core/errors.js';

const applications = new Map([['sheerid', sheerid]]);

export function getApplication(name) {
  const application = applications.get(name);
  if (!application) throw new AutomationError('UNKNOWN_APP', '未注册该应用适配器');
  return application;
}
