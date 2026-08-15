# ADR 0001 — Stack

**Status:** Accepted · **Context:** `SPEC.md` §2 requires the choice be deliberate and recorded.

## Decision

TypeScript on Node 22, Fastify for the API, React 18 + Vite for the client,
PostgreSQL 16 for storage, Microsoft Entra ID for identity.

## Why

§2 names TypeScript, React, PostgreSQL, Entra and Azure as the intended shape.
We adopted it rather than re-litigating it: the constraints that would justify
deviating (team skills, existing platform) point the same way.

Two choices inside that shape are ours:

**Fastify over Express.** The `onRoute` hook lets us refuse to *register* a
route that has no authorisation declaration. `SEC-010` says "the absence of a
declaration fails the build"; with Fastify that is a hook, with Express it would
be a lint rule people can silence.

**SPA served from the API, not SSR.** §2 says "server-side rendering". We serve
a static shell with a per-response CSP nonce and let the client fetch. The
reason is `SEC-032`: SSR of a data-dense grid pushes towards inlined state and
inlined styles, which is precisely what a nonce-based CSP with no
`unsafe-inline` forbids. A static shell has exactly one nonce'd script tag and
no inline anything. If SSR becomes necessary for first-paint, it can be added
behind the same CSP — but it should be a measured decision, not the default.

## Consequences

- No framework-level SSR, so first paint waits for the API. Acceptable for an
  internal tool behind Conditional Access.
- Node's `--experimental-strip-types` runs TypeScript directly, so there is no
  build step for the API. Parameter properties and enums are unavailable; the
  code avoids both.
