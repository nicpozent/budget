/**
 * Serves the single-page shell and its build assets.
 *
 * Assets are read into memory at boot and served from a map keyed by exact
 * filename. There is no path joining of request input, which means the entire
 * path-traversal class — the one that produced two advisories in the static
 * plugin we started with — cannot occur here: a request either names a file
 * that was in the build output, or it gets a 404.
 *
 * The shell is rendered per request so the CSP nonce can be stamped onto the
 * one script tag (SEC-032). That is the only dynamic part; there is no user
 * input in this HTML at all.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { publicRoute } from '../http/guard.ts';
import type { AppConfig } from '../config.ts';

const DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface Asset {
  content: Buffer;
  contentType: string;
  etag: string;
}

async function loadAssets(): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>();
  let names: string[];
  try {
    names = await readdir(path.join(DIST, 'assets'));
  } catch {
    // The frontend has not been built. The API still serves, which keeps the
    // test suite independent of a Vite build.
    return assets;
  }

  for (const name of names) {
    const ext = path.extname(name);
    const contentType = CONTENT_TYPES[ext];
    // Anything with an extension we do not explicitly serve is skipped rather
    // than served as octet-stream.
    if (!contentType) continue;
    const content = await readFile(path.join(DIST, 'assets', name));
    assets.set(name, {
      content,
      contentType,
      etag: `"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`,
    });
  }
  return assets;
}

/**
 * Asset names come from the build output rather than being hard-coded, so a
 * change to Vite's naming cannot silently produce a shell that references a
 * stylesheet which is not there.
 */
/**
 * A data-URI icon rather than a served file.
 *
 * Every page load was requesting /favicon.ico and getting a 404, because this
 * route serves /assets/* by exact filename and nothing else. Inlining the icon
 * keeps that property — no second file-serving path, no path joining — and
 * `img-src 'self' data:` already permits it. It is an inline *image*, not an
 * inline script or style, so SEC-032 is untouched.
 */
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f6df6'/%3E%3Cpath d='M11 10h10M11 16h10M11 22h6' stroke='white' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E";

function shellHtml(nonce: string, scripts: string[], stylesheets: string[]): string {
  const links = stylesheets
    .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
    .join('\n');
  const tags = scripts
    .map((name) => `<script type="module" src="/assets/${name}" nonce="${nonce}"></script>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spendifre</title>
<link rel="icon" href="${FAVICON}">
${links}
${tags}
</head>
<body>
<div id="root"></div>
<noscript>Spendifre requires JavaScript.</noscript>
</body>
</html>
`;
}

export async function registerShellRoutes(
  app: FastifyInstance,
  _config: AppConfig,
): Promise<void> {
  const assets = await loadAssets();
  const names = [...assets.keys()].sort();
  // `app.js` is the configured entry name; any other .js is a lazy chunk that
  // the entry pulls in itself and must not be a second entry tag.
  const scripts = names.filter((n) => n === 'app.js');
  const stylesheets = names.filter((n) => n.endsWith('.css'));

  app.get('/assets/:file', { config: publicRoute }, async (request, reply) => {
    const { file } = request.params as { file: string };
    const asset = assets.get(file);
    if (!asset) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } });

    if (request.headers['if-none-match'] === asset.etag) {
      return reply.status(304).send();
    }

    return reply
      .header('Content-Type', asset.contentType)
      .header('ETag', asset.etag)
      // Build output is content-addressed by ETag; the shell is not cached.
      .header('Cache-Control', 'public, max-age=300, must-revalidate')
      .header('X-Content-Type-Options', 'nosniff')
      .send(asset.content);
  });

  // Everything else that is not an API or auth path renders the shell, so the
  // client can own its own routing.
  app.get('/', { config: publicRoute }, async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(shellHtml(request.cspNonce, scripts, stylesheets)),
  );

  app.get('/app/*', { config: publicRoute }, async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(shellHtml(request.cspNonce, scripts, stylesheets)),
  );
}
