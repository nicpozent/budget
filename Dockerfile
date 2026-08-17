# Spendifre API + shell.
#
# Two properties this image is built for, in priority order:
#
#   Reproducible.  `npm ci` against the committed lockfile, exact base image
#                  versions, and SOURCE_DATE_EPOCH honoured by the builder.
#                  Two builds of the same commit produce the same digest, which
#                  is what makes the signature in CI mean anything (row 18).
#
#   Small attack surface.  Distroless runtime: no shell, no package manager,
#                  no curl. A container with no shell is a container an RCE
#                  cannot pivot from with the usual toolkit.
#
# The app deliberately runs from TypeScript sources under Node's type stripping
# rather than a compiled bundle — see ADR-0001. That means the runtime stage
# carries `packages/**/src`, which is source, not secrets; the confidential
# workbook under `design/` is excluded by .dockerignore and asserted absent by
# a CI check.

# --- Build ----------------------------------------------------------------
#
# On base image pinning: these are exact version tags, not digests, and that is
# a deliberate half-measure with a compensating control rather than an
# oversight. A digest pins one architecture unless you pin the manifest-list
# digest, and a digest committed here goes stale silently — nobody rebases it
# and the image stops receiving base security updates, which trades one supply
# chain risk for a worse one.
#
# Instead, CI resolves both bases to their digests at build time and records
# them in the SLSA provenance attestation alongside the image
# (.github/workflows/release.yml). The build is therefore reproducible *from
# the attestation*, which is the artefact a verifier actually consults, and the
# base still gets patched. Renovate opens a PR when a new patch version exists.
FROM node:22.14.0-bookworm-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/

# `npm ci` fails rather than resolving when the lockfile disagrees with the
# manifests — which is the behaviour a reproducible build needs.
RUN npm ci

COPY tsconfig.json ./
COPY packages/ packages/

# The client is bundled; the server is not (ADR-0001).
RUN npm run build --workspace @spendifre/web

# Drop dev dependencies from the tree that will be copied forward. Vite, axe,
# Playwright and vitest have no business in a runtime image.
RUN npm prune --omit=dev

# --- Runtime --------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

WORKDIR /app

# `nonroot` in the distroless image is uid 65532. Stated explicitly so a
# platform that ignores the image default still runs unprivileged.
USER 65532:65532

COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/packages ./packages
COPY --from=build --chown=65532:65532 /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/tsconfig.json ./tsconfig.json
# Migrations travel with the image so the schema and the code that expects it
# are the same artefact. They run as a different database role (SEC-021), from
# an init container, never from the running service.
COPY --from=build --chown=65532:65532 /app/db ./db

ENV NODE_ENV=production
ENV NODE_OPTIONS=--experimental-strip-types

EXPOSE 8080

# No HEALTHCHECK: distroless has no shell and no curl, so the usual
# `CMD curl -f localhost/healthz` cannot run. The platform probes /healthz over
# HTTP instead — see ops/infra/main.bicep. A HEALTHCHECK that silently never
# succeeds is worse than none.

ENTRYPOINT ["/nodejs/bin/node", "--experimental-strip-types", "packages/api/src/main.ts"]
