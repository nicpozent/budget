# ADR 0004 — Write it rather than take the dependency

**Status:** Accepted · **Drivers:** `SEC-040`, `SEC-041`, OWASP A06/A08

## Decision

Two dependencies were removed during implementation and replaced with code:

**`exceljs`** → a ~200-line OOXML + ZIP writer. It pulled a large transitive
tree including several deprecated and unmaintained packages.

**`@fastify/static`** → a boot-time asset map keyed by exact filename. The
first `npm audit` of the project flagged two path-traversal advisories against
it; we upgraded, then removed it.

## Why

Both replacements sit directly on a security boundary, and in both cases owning
the code made the control clearer rather than riskier.

The export path is where our data crosses into someone else's Excel. `SEC-023`
requires leading `=`, `+`, `-`, `@`, tab and CR to be neutralised. As a library
option that is a flag someone can turn off in a refactor; as the single function
every text cell passes through, it is the code path.

Static file serving is where path traversal lives. Reading the build output into
a map at boot and looking up by exact filename means request input is never
joined to a path — the entire class is absent rather than defended.

## Why not, in general

This is not an argument for writing everything. We did not write our own OIDC
client, crypto, HTTP server or SQL driver — those are large, subtle, and
well-maintained. The rule applied was narrower: **replace a dependency when the
thing it does is small, sits on a security boundary, and its transitive tree is
larger than the code it saves.**

## Consequences

- The XLSX writer supports inline strings and numbers only. Styling or formulas
  would mean extending it or revisiting the decision.
- Production dependency count is 6 direct. `npm audit --audit-level=high
  --omit=dev` currently reports zero vulnerabilities.
