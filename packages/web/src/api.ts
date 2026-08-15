/**
 * API client.
 *
 * Two things worth noting for security review:
 *
 *   * The CSRF token is read from the `csrf` cookie and echoed in the
 *     `x-csrf-token` header on every state-changing call (SEC-034). The session
 *     cookie itself is HttpOnly and is never touched by this file.
 *   * Nothing here stores a token in `localStorage`. There is no token to
 *     store: authentication is entirely cookie-borne and server-validated.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: Record<string, string>;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function csrfToken(): string {
  const match = document.cookie
    .split('; ')
    .find((c) => c.startsWith('csrf=') || c.startsWith('__Host-csrf='));
  return match ? decodeURIComponent(match.slice(match.indexOf('=') + 1)) : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();

  const response = await fetch(path, {
    method,
    headers,
    // Cookies are the credential; nothing is attached by hand.
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; fields?: Record<string, string> } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal',
      error?.message ?? 'Request failed.',
      error?.fields ?? {},
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
