export class AutomationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'AutomationError';
    this.code = code;
  }
}

export function requireValue(condition, message) {
  if (!condition) throw new AutomationError('INVALID_CONFIG', message);
}
