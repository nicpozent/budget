# Observability

Spendifre emits **structured logs, an audit trail and security telemetry**
today. Distributed tracing over OTLP is **specified but not shipped** — this
page is honest about which is which, because an observability document that
describes instrumentation you do not have is worse than none.

---

## 1. What is instrumented today

| Signal | Source | Status |
| --- | --- | --- |
| **Request logs** | Fastify + Pino, JSON, one line per request with method, route, status and duration | Shipped |
| **Correlation** | `genReqId` mints a UUID per request; every log line for that request carries `reqId` | Shipped |
| **Authorisation denials** | Every 4xx from the guard logs `event: request.rejected` with a `code` and the internal `reason` | Shipped |
| **Domain audit** | `audit_events` — actor, role, action, target, entity, detail, kind; append-only and hash-chained | Shipped |
| **Audit chain integrity** | `audit_verify_chain()` exposed at `GET /api/governance/audit-integrity` | Shipped |
| **CSP violations** | `POST /api/security/csp-report`, logged as `event: csp.violation` | Shipped |
| **Audit completeness** | A 2xx state-changing request that wrote no audit event logs `event: audit.missing` at error level | Shipped |
| **Health** | `GET /healthz` — status only, no version or dependency detail | Shipped |
| **Traces / metrics over OTLP** | — | **Not shipped** (see §5) |

## 2. Log hygiene

Credentials are redacted at the logger, not at the call site, so a new log
statement cannot leak them by omission:

```ts
redact: {
  paths: ['req.headers.cookie', 'req.headers.authorization',
          'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
  remove: true,
}
```

Two related rules that matter as much:

- **Error responses carry a safe message; the detail goes only to the log.** No
  stack trace, SQL text, driver message or received value is ever serialised
  into a response body.
- **Free text is length-bounded and control characters are rejected** at the
  boundary — a log-injection defence, not an XSS one.

## 3. The events worth alerting on

`ZT-008` names three. None of them is wired to a SIEM yet; the events exist and
the rules are specified.

| Alert | Signal | Why |
| --- | --- | --- |
| **Audit-write failure** | `event: audit.missing`, or `audit-integrity` returning a non-null sequence | A state change that was not recorded, or a chain that no longer verifies. The highest-severity signal in the system. |
| **Mass export** | `action: report.export` or `backup.create` / `backup.download` in `audit_events`, thresholded on the row count in `detail` | The shape of exfiltration. Deliberately low-frequency, so any spike is real. |
| **Privilege change** | `action: entity.create`, `governance.retention`, `governance.classification`, `governance.subject.pseudonymise` | Someone changing who can see what, or removing a person from the record. |

Two more worth adding:

| Alert | Signal |
| --- | --- |
| Repeated authorisation denial | `event: request.rejected, code: forbidden` clustered by `reqId` actor — someone probing endpoints |
| Step-up refusals | `code: step_up_required` in volume — either a UX problem or someone replaying an old session |

## 4. Useful queries

```sql
-- Is the audit chain intact? null = yes.
select audit_verify_chain();

-- Export volume by actor over the last 30 days.
select u.display_name, count(*), max(ae.occurred_at)
from audit_events ae join users u on u.id = ae.actor_user_id
where ae.action in ('report.export','backup.create','backup.download')
  and ae.occurred_at > now() - interval '30 days'
group by 1 order by 2 desc;

-- Approval activity for a cycle — the ICFR evidence query (CMP-151).
select ae.occurred_at, u.display_name, ae.action, ae.detail
from audit_events ae join users u on u.id = ae.actor_user_id
where ae.kind = 'approval' order by ae.seq;
```

## 5. OTLP tracing — the gap, and exactly how to close it

Not shipped. What is missing and what it would take:

**Missing:** distributed traces (incoming HTTP, outbound Entra calls, database
queries), runtime metrics, and log/trace correlation in a backend.

**To add**, keeping it off by default so it costs nothing until configured:

1. Add `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`
   and `@opentelemetry/exporter-trace-otlp-proto`.
2. Start the SDK in `main.ts` **before** `buildApp`, gated on
   `OTEL_EXPORTER_OTLP_ENDPOINT` being set.
3. Set `enhancedDatabaseReporting: false` on the `pg` instrumentation — SQL
   statement text must not reach the tracing backend, because bound parameters
   in this system are budget figures and vendor names.
4. Emit a domain counter alongside `writeAudit` — `spendifre.audit.events`,
   tagged by `kind` and `action` — so activity dashboards do not require
   querying the audit table.

Standard configuration would then apply:

| Variable | Purpose |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector endpoint; presence switches telemetry on |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` or `http/protobuf` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers |
| `OTEL_SERVICE_NAME` | `spendifre-api` |

**Why it was not built:** it is deployment-shaped work with no test that can
prove it correct in this environment, and shipping an untested exporter is worse
than a documented gap. It is the top item in the observability roadmap.

## 6. SLOs worth defining before go-live

`NFR-006` sets 99.5% availability during the collection window. The supporting
indicators:

| SLI | Target | Source |
| --- | --- | --- |
| Availability | 99.5% in the collection window | Front Door health probe |
| Grid latency | p95 < 1s for a 500-line entity (`NFR-001`) | `GET /api/budget/:entityId` duration |
| Authorisation denial rate | Baseline, alert on deviation | `request.rejected` count |
| Audit-write failure | **Zero** | `audit.missing` count |
| Chain integrity | Always intact | `audit_verify_chain()` scheduled check |
