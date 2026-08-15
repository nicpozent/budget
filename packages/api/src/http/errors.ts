/**
 * Error responses.
 *
 * Clients get a stable code and a short, non-specific message. Nothing that
 * distinguishes "this row does not exist" from "this row exists but is not
 * yours" leaves the process, and no stack trace, SQL text, driver message or
 * internal identifier is ever serialised into a response body — that detail is
 * reconnaissance (OWASP A01/A09, and the OSINT exposure note in docs/security).
 * The full error goes to the log, correlated by request id.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'step_up_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  step_up_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  internal: 500,
};

const SAFE_MESSAGE: Record<ErrorCode, string> = {
  bad_request: 'The request could not be understood.',
  unauthenticated: 'Authentication is required.',
  step_up_required: 'Re-authentication is required for this action.',
  forbidden: 'You do not have permission to perform this action.',
  not_found: 'Not found.',
  conflict: 'The record changed since you loaded it. Reload and try again.',
  validation_failed: 'The submitted values are not valid.',
  rate_limited: 'Too many requests. Try again shortly.',
  internal: 'Something went wrong.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Field-level detail. Only ever populated from our own validation output,
   *  never from a database or driver message. */
  readonly fields?: Record<string, string>;

  constructor(code: ErrorCode, internalMessage?: string, fields?: Record<string, string>) {
    super(internalMessage ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    if (fields) this.fields = fields;
  }

  toBody(): { error: { code: ErrorCode; message: string; fields?: Record<string, string> } } {
    return {
      error: {
        code: this.code,
        message: SAFE_MESSAGE[this.code],
        ...(this.fields ? { fields: this.fields } : {}),
      },
    };
  }
}

export const badRequest = (why?: string) => new AppError('bad_request', why);
export const unauthenticated = (why?: string) => new AppError('unauthenticated', why);
export const stepUpRequired = (why?: string) => new AppError('step_up_required', why);
export const forbidden = (why?: string) => new AppError('forbidden', why);
export const conflict = (why?: string) => new AppError('conflict', why);
export const internal = (why?: string) => new AppError('internal', why);

/**
 * SEC-011: on read paths, a resource outside the caller's scope is reported as
 * 404 rather than 403, so that identifiers cannot be enumerated by comparing
 * status codes. Write paths use 403, where the caller already knows the object
 * exists because they named it.
 */
export const notFound = (why?: string) => new AppError('not_found', why);

export function validationFailed(fields: Record<string, string>): AppError {
  return new AppError('validation_failed', 'schema validation failed', fields);
}
