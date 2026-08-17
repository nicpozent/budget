/**
 * Wires metrics and tracing into the request lifecycle.
 *
 * One hook pair, deliberately: `onRequest` starts the span and the clock,
 * `onResponse` ends both. Everything else — audit failures, export volume,
 * authorisation denials — is recorded at the point where it happens, because a
 * counter incremented near the fact is a counter that stays true when the code
 * around it moves.
 *
 * Sampling is deterministic on the trace id rather than random per span, so a
 * trace is either fully sampled or fully absent. Half a trace is worse than
 * none: it looks like a gap in the system rather than a gap in the telemetry.
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.ts';
import { httpDuration, httpRequests, registerMetricsEndpoint } from './metrics.ts';
import {
  OtlpExporter,
  endSpan,
  formatTraceparent,
  parseTraceparent,
  startSpan,
  type Span,
} from './tracing.ts';

declare module 'fastify' {
  interface FastifyRequest {
    span?: Span;
    startedAt?: bigint;
  }
}

/** Deterministic sample decision from the trace id's low bits. */
function shouldSample(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  const bucket = Number.parseInt(traceId.slice(-4), 16) / 0xffff;
  return bucket < ratio;
}

export function registerObservability(
  app: FastifyInstance,
  config: AppConfig,
): { exporter: OtlpExporter | null } {
  registerMetricsEndpoint(app, config.METRICS_TOKEN);

  const exporter = config.OTLP_ENDPOINT
    ? new OtlpExporter({
        endpoint: config.OTLP_ENDPOINT,
        serviceName: config.OTLP_SERVICE_NAME,
        region: config.RESIDENCY_REGION,
      })
    : null;

  app.addHook('onRequest', async (request, reply) => {
    request.startedAt = process.hrtime.bigint();

    const parent = parseTraceparent(request.headers.traceparent as string | undefined);
    // An upstream that says "do not sample" is obeyed; a request with no
    // traceparent gets the local ratio applied to its freshly minted id.
    const span = startSpan(`${request.method} ${request.url}`, parent, parent?.sampled ?? false);
    if (!parent) span.sampled = shouldSample(span.traceId, config.TRACE_SAMPLE_RATIO);
    request.span = span;

    // Propagate downstream and expose to the client for support correlation.
    // The trace id is not a secret — it identifies a request, not a principal.
    reply.header('traceparent', formatTraceparent(span));
  });

  app.addHook('onResponse', async (request, reply) => {
    // The route *pattern*, never the resolved URL: `/api/lines/:lineId` is a
    // label, `/api/lines/8f2c…` is an identifier leaking into a metrics store
    // that SEC-011 does not cover.
    const route = request.routeOptions?.url ?? 'unmatched';
    const status = reply.statusCode;
    const labels = {
      route,
      method: request.method,
      status: `${Math.floor(status / 100)}xx`,
    };

    httpRequests(labels);

    if (request.startedAt !== undefined) {
      const seconds = Number(process.hrtime.bigint() - request.startedAt) / 1e9;
      httpDuration(seconds, { route, method: request.method });
    }

    const span = request.span;
    if (span && exporter) {
      // Named after the pattern for the same reason the metric label is.
      span.name = `${request.method} ${route}`;
      span.attributes['http.request.method'] = request.method;
      span.attributes['http.route'] = route;
      span.attributes['http.response.status_code'] = status;
      // The principal's *role* is useful for "which role is slow" and carries
      // no identity; the user id would carry identity and is not recorded.
      if (request.principal) span.attributes['spendifre.role'] = request.principal.role;
      exporter.record(endSpan(span, status >= 500 ? 'error' : 'ok'));
    }
  });

  app.addHook('onClose', async () => {
    await exporter?.close();
  });

  return { exporter };
}
