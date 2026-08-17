/**
 * Metrics and tracing (ZT-008, row 13).
 *
 * The point of these is not that the numbers are right — it is that the
 * *labels* are safe. A metrics endpoint is scraped by infrastructure that
 * SEC-011 does not cover, and a trace is shipped to a collector outside this
 * system entirely. Both are treated as public surfaces, and the tests that
 * matter most below are the ones asserting nothing identifying reaches them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  counter, gauge, histogram, render, resetMetrics,
} from '../packages/api/src/observability/metrics.ts';
import {
  OtlpExporter, endSpan, formatTraceparent, parseTraceparent, startSpan,
} from '../packages/api/src/observability/tracing.ts';
import { createHarness, type Harness } from './harness.ts';

describe('metrics exposition', () => {
  beforeEach(() => resetMetrics());

  it('renders a counter with its help and type', () => {
    const hits = counter('probe_total', 'Probe counter.');
    hits({ route: '/api/lines' });
    hits({ route: '/api/lines' });
    hits({ route: '/api/entities' });

    const output = render();
    expect(output).toContain('# HELP probe_total Probe counter.');
    expect(output).toContain('# TYPE probe_total counter');
    expect(output).toContain('probe_total{route="/api/lines"} 2');
    expect(output).toContain('probe_total{route="/api/entities"} 1');
  });

  it('treats label order as irrelevant to series identity', () => {
    const hits = counter('order_total', 'Ordering.');
    hits({ a: '1', b: '2' });
    hits({ b: '2', a: '1' });
    // Two increments of one series, not one each of two.
    expect(render()).toContain('order_total{a="1",b="2"} 2');
  });

  it('renders cumulative histogram buckets that end at the observation count', () => {
    const observe = histogram('latency_seconds', 'Latency.', [0.1, 0.5, 1]);
    observe(0.05);
    observe(0.4);
    observe(2);

    const output = render();
    expect(output).toContain('latency_seconds_bucket{le="0.1"} 1');
    expect(output).toContain('latency_seconds_bucket{le="0.5"} 2');
    expect(output).toContain('latency_seconds_bucket{le="1"} 2');
    // The +Inf bucket must equal the total count, or the histogram is invalid.
    expect(output).toContain('latency_seconds_bucket{le="+Inf"} 3');
    expect(output).toContain('latency_seconds_count 3');
  });

  it('escapes label values so a quote cannot break the format', () => {
    const hits = counter('escape_total', 'Escaping.');
    hits({ route: 'a"b\\c' });
    expect(render()).toContain('escape_total{route="a\\"b\\\\c"} 1');
  });

  it('replaces a gauge rather than accumulating it', () => {
    const set = gauge('intact', 'Chain intact.');
    set(1);
    set(0);
    expect(render()).toContain('intact 0');
    expect(render()).not.toContain('intact 1');
  });
});

describe('W3C trace context', () => {
  it('joins an inbound trace rather than starting a new one', () => {
    const parent = parseTraceparent(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
    expect(parent).not.toBeNull();

    const span = startSpan('GET /api/me', parent, true);
    expect(span.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span.parentSpanId).toBe('00f067aa0ba902b7');
    // A child span gets its own id — reusing the parent's would collapse the
    // two into one in the collector.
    expect(span.spanId).not.toBe('00f067aa0ba902b7');
  });

  it('rejects malformed and all-zero trace ids', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    // All-zero is invalid per the spec and usually means a broken upstream.
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('honours an upstream decision not to sample', () => {
    const parent = parseTraceparent(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
    );
    expect(parent!.sampled).toBe(false);
  });

  it('round-trips through formatting', () => {
    const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });
});

describe('OTLP export', () => {
  const exporter = new OtlpExporter({
    endpoint: 'http://127.0.0.1:1/v1/traces',
    serviceName: 'spendifre-api',
    region: 'eu',
    flushMs: 3_600_000,
  });

  it('builds a payload a collector would accept', () => {
    const span = endSpan(startSpan('GET /api/me', null, true));
    span.attributes['http.route'] = '/api/me';
    span.attributes['http.response.status_code'] = 200;

    const payload = exporter.toPayload([span]) as Record<string, any>;
    const emitted = payload.resourceSpans[0].scopeSpans[0].spans[0];

    expect(emitted.traceId).toHaveLength(32);
    expect(emitted.spanId).toHaveLength(16);
    // Nanosecond timestamps must be strings: they exceed Number.MAX_SAFE_INTEGER
    // and would lose precision as JSON numbers.
    expect(typeof emitted.startTimeUnixNano).toBe('string');
    expect(emitted.status.code).toBe(1);
    expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'service.name', value: { stringValue: 'spendifre-api' },
    });
  });

  it('drops rather than queues without bound when the collector is unreachable', async () => {
    const small = new OtlpExporter({
      endpoint: 'http://127.0.0.1:1/v1/traces',
      serviceName: 'x', region: 'eu', flushMs: 3_600_000, maxQueue: 3,
    });
    for (let i = 0; i < 10; i += 1) small.record(endSpan(startSpan('probe', null, true)));
    // Telemetry must never be the reason a process runs out of memory.
    expect(small.dropped).toBe(7);
  });

  it('ignores unsampled spans entirely', () => {
    const small = new OtlpExporter({
      endpoint: 'http://127.0.0.1:1/v1/traces',
      serviceName: 'x', region: 'eu', flushMs: 3_600_000, maxQueue: 1,
    });
    small.record(endSpan(startSpan('probe', null, false)));
    small.record(endSpan(startSpan('probe', null, false)));
    expect(small.dropped).toBe(0);
  });
});

describe('the /metrics endpoint', () => {
  let guarded: Harness;
  let open: Harness;
  const TOKEN = 'metrics-token-long-enough-to-pass';

  beforeAll(async () => {
    guarded = await createHarness({ rateLimit: 'off', env: { METRICS_TOKEN: TOKEN } });
    open = await createHarness({ rateLimit: 'off' });
  }, 120_000);

  afterAll(async () => {
    await guarded?.close();
    await open?.close();
  });

  it('is not registered at all without a token', async () => {
    // Fail closed: an unconfigured deployment exposes nothing rather than
    // everything. Same shape as DEV_AUTH.
    const response = await open.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
  });

  it('answers 404, not 401, without the bearer token', async () => {
    const response = await guarded.app.inject({ method: 'GET', url: '/metrics' });
    // 404 rather than 401: an unauthenticated caller learns nothing about
    // whether metrics are enabled here.
    expect(response.statusCode).toBe(404);
  });

  it('serves the exposition format with the token', async () => {
    await guarded.app.inject({ method: 'GET', url: '/healthz' });

    const response = await guarded.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('spendifre_http_requests_total');
  });

  it('labels routes by pattern, never by resolved identifier', async () => {
    const headers = await guarded.as('finance@birgma.test');
    const entity = await guarded.db.one<{ id: string }>(
      // A real id, so a leak would be visible in the output.
      (await import('../packages/api/src/db/pool.ts')).sql`select id from entities limit 1`,
    );

    await guarded.app.inject({
      method: 'GET',
      url: `/api/budget/${entity!.id}`,
      headers: { cookie: headers.cookie },
    });

    const response = await guarded.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    // This is the test that matters: the pattern is a label, the id is not.
    expect(response.body).toContain('/api/budget/:entityId');
    expect(response.body).not.toContain(entity!.id);
  });

  it('exposes no user identity in any label', async () => {
    const headers = await guarded.as('cfo@birgma.test');
    await guarded.app.inject({
      method: 'GET', url: '/api/entities', headers: { cookie: headers.cookie },
    });

    const response = await guarded.app.inject({
      method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.body).not.toContain(headers.userId);
    expect(response.body).not.toContain('cfo@birgma.test');
  });

  it('returns a traceparent so a support request can be correlated', async () => {
    const response = await guarded.app.inject({ method: 'GET', url: '/healthz' });
    // The trace id identifies a request, not a principal, so it is safe to
    // hand to a user who is reporting a problem.
    expect(response.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[01]{2}$/);
  });
});
