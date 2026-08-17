/**
 * Distributed tracing, exported as OTLP/HTTP JSON (row 13 of the evaluation).
 *
 * No OpenTelemetry SDK. The reasoning is ADR-0004's: the SDK plus an exporter
 * plus auto-instrumentation is a transitive tree larger than this entire
 * application's dependency set, running inside the trust boundary, to produce
 * a JSON document this file builds in about a hundred lines. The wire format is
 * the stable contract — any OTLP collector accepts what this emits.
 *
 * What is given up by not using the SDK: automatic instrumentation of `pg` and
 * `undici`, and the full context-propagation API. What is kept: W3C
 * `traceparent` in and out, so a request that arrives with a trace id from the
 * ingress joins that trace rather than starting a new one, and a span per
 * request with the database time attributed to it.
 *
 * Span attributes follow the same rule as metric labels: no user id, no entity
 * id, no resolved path, no amount. A trace is shipped to a collector outside
 * this system's access controls, so it is treated as a public surface.
 */

import { randomBytes } from 'node:crypto';

export interface SpanContext {
  traceId: string;
  spanId: string;
  /** False when the incoming traceparent asked not to be sampled. */
  sampled: boolean;
}

export interface Span extends SpanContext {
  name: string;
  parentSpanId?: string;
  startNanos: bigint;
  endNanos?: bigint;
  attributes: Record<string, string | number | boolean>;
  status: 'unset' | 'ok' | 'error';
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parse an inbound W3C traceparent, or return null when absent or malformed. */
export function parseTraceparent(header: string | undefined): SpanContext | null {
  if (!header) return null;
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  // All-zero ids are invalid per the spec and are a common sign of a broken
  // upstream rather than a trace worth joining.
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return { traceId: traceId!, spanId: spanId!, sampled: (Number.parseInt(flags!, 16) & 1) === 1 };
}

export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

const now = (): bigint => BigInt(Date.now()) * 1_000_000n;

export function startSpan(name: string, parent: SpanContext | null, sampled: boolean): Span {
  return {
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name,
    startNanos: now(),
    attributes: {},
    status: 'unset',
    sampled,
  };
}

export function endSpan(span: Span, status: 'ok' | 'error' = 'ok'): Span {
  span.endNanos = now();
  span.status = status;
  return span;
}

/**
 * Batching exporter.
 *
 * Spans are dropped rather than queued without bound when the collector is
 * unreachable: telemetry must never be the reason a request fails or a process
 * runs out of memory. The drop is counted, so "we are losing traces" is itself
 * observable rather than silent.
 */
export class OtlpExporter {
  readonly #endpoint: string;
  readonly #serviceName: string;
  readonly #region: string;
  readonly #maxQueue: number;
  #queue: Span[] = [];
  #timer: NodeJS.Timeout | undefined;
  #dropped = 0;

  constructor(options: {
    endpoint: string;
    serviceName: string;
    region: string;
    flushMs?: number;
    maxQueue?: number;
  }) {
    this.#endpoint = options.endpoint;
    this.#serviceName = options.serviceName;
    this.#region = options.region;
    this.#maxQueue = options.maxQueue ?? 2048;
    this.#timer = setInterval(() => void this.flush(), options.flushMs ?? 5000);
    // Do not hold the process open for telemetry.
    this.#timer.unref?.();
  }

  get dropped(): number {
    return this.#dropped;
  }

  record(span: Span): void {
    if (!span.sampled) return;
    if (this.#queue.length >= this.#maxQueue) {
      this.#dropped += 1;
      return;
    }
    this.#queue.push(span);
  }

  /** OTLP/HTTP JSON. The shape is the ExportTraceServiceRequest message. */
  toPayload(spans: readonly Span[]): unknown {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: this.#serviceName } },
              { key: 'deployment.region', value: { stringValue: this.#region } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'spendifre' },
              spans: spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: 2, // SPAN_KIND_SERVER
                startTimeUnixNano: String(span.startNanos),
                endTimeUnixNano: String(span.endNanos ?? span.startNanos),
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value:
                    typeof value === 'number'
                      ? { intValue: String(Math.round(value)) }
                      : typeof value === 'boolean'
                        ? { boolValue: value }
                        : { stringValue: value },
                })),
                status: { code: span.status === 'error' ? 2 : span.status === 'ok' ? 1 : 0 },
              })),
            },
          ],
        },
      ],
    };
  }

  async flush(): Promise<void> {
    if (this.#queue.length === 0) return;
    const batch = this.#queue;
    this.#queue = [];

    try {
      await fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.toPayload(batch)),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // A collector that is down must not become an application outage, and
      // must not be retried into a queue that grows without bound.
      this.#dropped += batch.length;
    }
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.flush();
  }
}
