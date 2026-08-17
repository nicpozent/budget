/**
 * Metrics, in Prometheus exposition format (ZT-008, row 13 of the evaluation).
 *
 * Hand-rolled rather than taken from `prom-client` or the OpenTelemetry SDK,
 * on the reasoning ADR-0004 already sets out. The exposition format is a dozen
 * lines of text generation; the SDK alternative is a transitive tree an order
 * of magnitude larger than this whole application's dependency set, sitting
 * inside the trust boundary, to produce the same bytes.
 *
 * What is deliberately *not* here: no metric carries a user id, an entity id,
 * a URL with an identifier in it, or an amount. Cardinality is the usual reason
 * given for that rule, and it is a good one — but the reason that matters here
 * is that `/metrics` is scraped by infrastructure that is not covered by
 * SEC-011, and a label is a data leak with a different name. Route labels use
 * the *pattern* (`/api/lines/:lineId`), never the resolved path.
 */

import type { FastifyInstance } from 'fastify';
import { publicRoute } from '../http/guard.ts';

type Labels = Readonly<Record<string, string>>;

interface Series {
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Map<string, { labels: Labels; value: number }>;
  /** Histogram only: cumulative bucket counts, plus sum and count. */
  buckets?: readonly number[];
  observations?: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>;
}

const registry = new Map<string, Series>();

/** Stable key for a label set, so the same labels always hit the same series. */
function keyOf(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

/**
 * Series are resolved from the registry on every call, not captured once.
 *
 * The obvious implementation captures the series in the returned closure, and
 * it is wrong in one specific way: the application's metrics are created at
 * module load, so anything that clears the registry afterwards — `resetMetrics`
 * between tests — leaves every closure incrementing a detached object that
 * nothing renders. The counters keep working and the output silently empties.
 * Resolving by name each time costs a map lookup and removes the failure mode.
 */
function seriesFor(name: string, help: string, type: Series['type']): Series {
  let series = registry.get(name);
  if (!series) {
    series = { help, type, values: new Map() };
    registry.set(name, series);
  }
  return series;
}

export function counter(name: string, help: string): (labels?: Labels, by?: number) => void {
  seriesFor(name, help, 'counter');
  return (labels = {}, by = 1) => {
    const series = seriesFor(name, help, 'counter');
    const key = keyOf(labels);
    const existing = series.values.get(key);
    if (existing) existing.value += by;
    else series.values.set(key, { labels, value: by });
  };
}

export function gauge(name: string, help: string): (value: number, labels?: Labels) => void {
  seriesFor(name, help, 'gauge');
  return (value, labels = {}) =>
    seriesFor(name, help, 'gauge').values.set(keyOf(labels), { labels, value });
}

/** Latency buckets in seconds, chosen around the NFR-001 p95 target of 300 ms. */
const DEFAULT_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5] as const;

export function histogram(
  name: string,
  help: string,
  buckets: readonly number[] = DEFAULT_BUCKETS,
): (value: number, labels?: Labels) => void {
  const ensure = (): Series => {
    let series = registry.get(name);
    if (!series) {
      series = { help, type: 'histogram', values: new Map(), buckets, observations: new Map() };
      registry.set(name, series);
    }
    return series;
  };
  ensure();
  return (value, labels = {}) => {
    const series = ensure();
    const key = keyOf(labels);
    const entry = series.observations!.get(key)
      ?? { labels, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
    for (const [i, bound] of buckets.entries()) if (value <= bound) entry.counts[i]! += 1;
    entry.sum += value;
    entry.count += 1;
    series.observations!.set(key, entry);
  };
}

/** Escape a label value per the exposition format. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const parts = Object.entries(all).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

export function render(): string {
  const lines: string[] = [];

  for (const [name, series] of registry) {
    lines.push(`# HELP ${name} ${series.help}`);
    lines.push(`# TYPE ${name} ${series.type}`);

    if (series.type === 'histogram') {
      for (const entry of series.observations!.values()) {
        for (const [i, bound] of series.buckets!.entries()) {
          lines.push(
            `${name}_bucket${renderLabels(entry.labels, { le: String(bound) })} ${entry.counts[i]}`,
          );
        }
        lines.push(`${name}_bucket${renderLabels(entry.labels, { le: '+Inf' })} ${entry.count}`);
        lines.push(`${name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
        lines.push(`${name}_count${renderLabels(entry.labels)} ${entry.count}`);
      }
      continue;
    }

    for (const entry of series.values.values()) {
      lines.push(`${name}${renderLabels(entry.labels)} ${entry.value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Test seam. */
export function resetMetrics(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// The application's own metrics
// ---------------------------------------------------------------------------

export const httpRequests = counter(
  'spendifre_http_requests_total',
  'HTTP requests by route pattern, method and status class.',
);

export const httpDuration = histogram(
  'spendifre_http_request_duration_seconds',
  'HTTP request duration by route pattern. NFR-001 targets p95 under 300 ms.',
);

/**
 * ZT-008 alert 1. Incremented by the audit-completeness hook and by any failure
 * to write an audit event. Non-zero is an incident, not a trend.
 */
export const auditFailures = counter(
  'spendifre_audit_failures_total',
  'State-changing requests that completed without writing an audit event (FR-070).',
);

/** ZT-008 alert 1, the other half: the chain itself. 1 = intact, 0 = broken. */
export const auditChainIntact = gauge(
  'spendifre_audit_chain_intact',
  'Whether audit_verify_chain() returned null at the last check. 0 means tampering.',
);

/** ZT-008 alert 2. Row counts, not amounts — volume is the signal. */
export const exportedRows = counter(
  'spendifre_exported_rows_total',
  'Rows leaving the system through an export or backup, by kind.',
);

/** ZT-008 alert 3, plus the "someone is probing" signal. */
export const authorisationDenials = counter(
  'spendifre_authorisation_denials_total',
  'Requests refused by the authorisation guard, by reason.',
);

export const privilegeChanges = counter(
  'spendifre_privilege_changes_total',
  'Changes to who can see what, by action.',
);

/**
 * Register the scrape endpoint.
 *
 * Guarded by a bearer token rather than a session, because a scraper has no
 * session — and left unregistered entirely when no token is configured, so an
 * unconfigured deployment exposes nothing rather than exposing everything. The
 * same fail-closed shape as DEV_AUTH.
 */
export function registerMetricsEndpoint(app: FastifyInstance, token: string | undefined): void {
  if (!token) return;

  app.get(
    '/metrics',
    {
      // Declared public because a scraper carries no session; the bearer
      // token below is the actual control, and the route is not registered at
      // all without one.
      config: publicRoute,
    },
    async (request, reply) => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      // Length-independent comparison: a scrape endpoint is reachable by
      // anything that can route to the pod, so the token is worth protecting
      // from a timing oracle even though it is not a user credential.
      if (!constantTimeEquals(presented, token)) {
        return reply.status(404).send();
      }
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(render());
    },
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  // Compare hashes rather than raw bytes so differing lengths do not leak.
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
