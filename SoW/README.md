# Statement of Work

| File | What it is |
| --- | --- |
| [STATEMENT-OF-WORK.md](STATEMENT-OF-WORK.md) | The statement of work: scope, deliverables, acceptance criteria, assumptions, exclusions |
| [STATEMENT-OF-WORK.html](STATEMENT-OF-WORK.html) | The same document, rendered for circulation |
| [flows.md](flows.md) | Every flow diagram, with the narrative that explains what it shows |
| [flows-gallery.html](flows-gallery.html) | The rendered diagrams as a browsable gallery |
| [flows/](flows/) | Mermaid sources — the artefact under version control |
| [images/](images/) | Rendered SVGs, generated from `flows/` |

## The flow set

Twenty-eight diagrams in three groups.

**Product flows** (`00`–`17`) follow the money: sitemap, authentication and RBAC,
per-request authorisation, budget entry, line detail and drivers, bulk
operations, submission and approval, cost centre lifecycle, actuals consumption,
FX restatement, consolidation, capex depreciation, allocations and chargeback,
the audit hash chain, retention and data subject requests, backup, XLSX export,
and residency routing.

**Delivery flows** (`dev-01`–`dev-06`) follow the change: change lifecycle, CI
gates, seed and anonymisation, test strategy, runtime topology, local
development.

**Role journeys** (`user-01`–`user-04`) follow the person: budget owner, CFO,
administrator, finance manager.

## Regenerating

```bash
npm run flows      # flows/*.mmd -> images/*.svg
npm run docs:html  # STATEMENT-OF-WORK.md -> STATEMENT-OF-WORK.html
```

`npm run flows` shells out to the Mermaid CLI, which needs a browser;
`CHROMIUM_PATH` points it at one. Edit the `.mmd` sources, never the SVGs — the
SVGs are build output and are overwritten on the next run.
