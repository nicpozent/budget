# Azure Monitor alert queries (ZT-008)

The same alerts as [`prometheus-rules.yaml`](./prometheus-rules.yaml), expressed
against Log Analytics for deployments that ship container logs rather than
scrape metrics. Both are provided because the two signals fail differently: a
metric survives a log pipeline outage, and a log carries the detail a metric
deliberately omits.

Each query is written to be pasted into a **scheduled query rule**. The
threshold and window are stated per alert; the severity maps to Azure's 0–4
scale, where 0 is critical.

Logs arrive as `ContainerLogV2` with the application's JSON in `LogMessage`.

## 1. Audit write missing — severity 0

```kusto
ContainerLogV2
| where ContainerName == "spendifre-api"
| extend log = parse_json(LogMessage)
| where tostring(log.event) == "audit.missing"
| project TimeGenerated, route = tostring(log.route), reqId = tostring(log.reqId)
```

Fire on **any** result over 5 minutes. A state change that was not recorded is
not a threshold question.

## 2. Audit chain broken — severity 0

The chain is verified by the retention job and at every backup. This catches the
report; the authoritative check is `select audit_verify_chain()`.

```kusto
ContainerLogV2
| where ContainerName == "spendifre-api"
| extend log = parse_json(LogMessage)
| where tostring(log.action) startswith "backup."
| where LogMessage contains "BROKEN at seq"
| project TimeGenerated, detail = tostring(log.detail)
```

Fire on any result over 15 minutes.

## 3. Mass export — severity 2

The row count is in the audit detail, which is why the detail is written the way
it is rather than as prose.

```kusto
ContainerLogV2
| where ContainerName == "spendifre-api"
| extend log = parse_json(LogMessage)
| where tostring(log.action) in ("report.export", "backup.create", "backup.download")
| extend rows = toint(extract(@"Exported (\d+) lines", 1, tostring(log.detail)))
| summarize total = sum(rows), events = count() by actor = tostring(log.actorRole), bin(TimeGenerated, 1h)
| where total > 50000
```

Fire when the query returns rows. Threshold set where a working day does not
reach it; tune after a month of real traffic rather than guessing again.

## 4. Privilege change — severity 3

```kusto
ContainerLogV2
| where ContainerName == "spendifre-api"
| extend log = parse_json(LogMessage)
| where tostring(log.action) in (
    "entity.create", "entity.delete",
    "governance.retention", "governance.classification",
    "governance.subject.pseudonymise",
    "approval.stage.create", "approval.stage.update", "approval.stage.reorder",
    "template.version.publish"
  )
| project TimeGenerated, action = tostring(log.action), detail = tostring(log.detail)
```

Informational. These are legitimate administrative actions; the alert exists so
they are reviewed, not so they are prevented.

## 5. Authorisation denial spike — severity 2

```kusto
ContainerLogV2
| where ContainerName == "spendifre-api"
| extend log = parse_json(LogMessage)
| where tostring(log.event) == "request.rejected" and tostring(log.code) == "forbidden"
| summarize denials = count() by bin(TimeGenerated, 5m)
| where denials > 20
```

Rule out a misconfigured client first: a CSRF or cross-origin spike is usually a
deployment mistake, and a capability spike is usually enumeration.

## 6. Ledger ingestion anomalies — severity 2

Added after FR-040. A feed that suddenly rejects everything is a schema change
upstream; a feed that suddenly accepts far more than usual is worth a look
before it lands in a board pack.

```kusto
ContainerLogV2
| where ContainerName == "spendifre-api"
| extend log = parse_json(LogMessage)
| where tostring(log.action) == "ledger.ingest"
| extend
    accepted = toint(extract(@"(\d+) accepted", 1, tostring(log.detail))),
    rejected = toint(extract(@"(\d+) rejected", 1, tostring(log.detail)))
| where rejected > accepted or accepted > 10000
```

## 7. Replayed ledger batches — severity 3

A scheduler stuck re-posting the same batch. Harmless to the data — the ingest
is idempotent — and a sign something upstream is not recording success.

```kusto
ContainerLogV2
| where ContainerName == "spendifre-api"
| extend log = parse_json(LogMessage)
| where tostring(log.action) == "ledger.replay"
| summarize replays = count() by bin(TimeGenerated, 1h)
| where replays > 3
```

## Deploying these

They are in the Bicep under [`ops/infra/`](../infra/) as
`Microsoft.Insights/scheduledQueryRules` resources, so the alert definitions
deploy with the environment rather than being clicked into a portal and lost at
the next subscription move.
