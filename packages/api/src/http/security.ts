/**
 * Security headers (SEC-032, SEC-033).
 *
 * The CSP is nonce-based with no `unsafe-inline` and no `unsafe-eval`. The
 * nonce is minted per response and exposed on the request so the SSR shell can
 * stamp it onto the one script tag that bootstraps the app. This is why the
 * prototype's inline styles could not be carried over: every rule lives in an
 * external stylesheet instead.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';

declare module 'fastify' {
  interface FastifyRequest {
    cspNonce: string;
  }
}

export function buildCsp(nonce: string, reportUri: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // Styles are external files; `self` is enough and no nonce is needed.
    "style-src 'self'",
    // Fonts are self-hosted rather than pulled from Google, so that a font CDN
    // is not a script-adjacent third party in the trust boundary.
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
    `report-uri ${reportUri}`,
    "report-to csp-endpoint",
  ].join('; ');
}

export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const nonce = randomBytes(16).toString('base64');
    request.cspNonce = nonce;

    reply.header('Content-Security-Policy', buildCsp(nonce, config.CSP_REPORT_URI));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Permissions-Policy',
      [
        'accelerometer=()', 'camera=()', 'display-capture=()', 'geolocation=()',
        'gyroscope=()', 'magnetometer=()', 'microphone=()', 'payment=()',
        'usb=()', 'interest-cohort=()',
      ].join(', '),
    );
    reply.header(
      'Report-To',
      JSON.stringify({
        group: 'csp-endpoint',
        max_age: 10886400,
        endpoints: [{ url: config.CSP_REPORT_URI }],
      }),
    );

    if (config.cookieSecure) {
      reply.header(
        'Strict-Transport-Security',
        'max-age=63072000; includeSubDomains; preload',
      );
    }

    // Do not advertise the stack. Version strings are free reconnaissance.
    reply.removeHeader('X-Powered-By');
    // Responses are per-principal; a shared cache must never hold them.
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Cookie');
  });
}

/**
 * SEC-034: an origin check alongside SameSite and the CSRF token. Requests
 * whose `Origin` is present and does not match are refused before the handler
 * runs; `Sec-Fetch-Site` is honoured where the browser supplies it.
 */
export function isSameOrigin(request: FastifyRequest, publicOrigin: string): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string') {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return true;
    return false;
  }

  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    return origin === publicOrigin;
  }

  // No Origin and no Sec-Fetch-Site: a non-browser client. Fail closed on
  // state-changing methods; the caller must send one of them.
  return false;
}
