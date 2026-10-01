export class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new WorkflowError(code, message);
}

export function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('VALIDATION_ERROR', `${name} is required`);
  return value.trim();
}
