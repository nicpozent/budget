# Spendifre documentation

Every document here is written against `SPEC.md`, which is the contract. Where a
document and the code disagree, the code is the defect — unless the document
says otherwise in a "Known gaps" or "Not mitigated" section, which records a
deliberate omission rather than a mistake.

Requirement identifiers (`FR-`, `SEC-`, `ZT-`, `PRIV-`, `NFR-`, `A11Y-`, `CMP-`)
are the join key. Grep for one and you will find the spec clause, the code that
implements it, the test that proves it, and the document that explains it.

## Architecture

| Document | What it answers |
| --- | --- |
| [architecture/hld.md](architecture/hld.md) | C4 context/container/component, actors and authority, quality attributes, deployment and residency topology, ADR index |
| [architecture/lld.md](architecture/lld.md) | Solution structure, request lifecycle, ERD, full endpoint map, authorisation internals, algorithms, frontend, test strategy |
| [architecture/building-blocks.md](architecture/building-blocks.md) | TOGAF architecture and solution building blocks, with traceability and status |
| [adr/](adr/) | Accepted decisions and the alternatives that lost |

## Security

| Document | What it answers |
| --- | --- |
| [security-hardening.md](security-hardening.md) | Control-by-control hardening baseline, from HTTP headers to database roles |
| [threat-model.md](threat-model.md) | STRIDE per trust boundary, LINDDUN, attack trees, MITRE ATT&CK mapping, residual risk |
| [nist-and-zero-trust.md](nist-and-zero-trust.md) | NIST CSF 2.0 coverage and SP 800-207 zero-trust tenets against CISA maturity |
| [osint-exposure.md](osint-exposure.md) | What an outside observer can learn, and what the build deliberately does not emit |
| [secrets.md](secrets.md) | Where every secret lives, how it rotates, and what happens when one leaks |
| [postgres-cert-auth.md](postgres-cert-auth.md) | Certificate authentication and TLS modes for the database connection |
| [pentest-scope.md](pentest-scope.md) | Rules of engagement, in-scope surface, and the tests worth paying for |

## Privacy and compliance

| Document | What it answers |
| --- | --- |
| [compliance-nis2-and-privacy.md](compliance-nis2-and-privacy.md) | NIS2 obligations and GDPR articles, clause by clause |
| [compliance-sweden.md](compliance-sweden.md) | Swedish and Nordic overlay: IMY, bokföringslagen, offentlighetsprincipen exposure |
| [dpia-personnel-data.md](dpia-personnel-data.md) | Data protection impact assessment for the personnel cost lines |
| [ropa.md](ropa.md) | Article 30 record of processing activities, derived from the schema |
| [lawful-basis.md](lawful-basis.md) | Lawful basis per activity, the legitimate-interests balancing test, and the purpose-limitation commitment |
| [privacy-notice.md](privacy-notice.md) | Employee-facing notice (Articles 13/14), drafted for the organisation to issue |
| [retention.md](retention.md) | Retention classes, the purge job, and how the audit chain survives a purge |

## Operations and quality

| Document | What it answers |
| --- | --- |
| [observability.md](observability.md) | Logs, metrics, traces, the SLOs they serve, and the alerts that fire |
| [accessibility.md](accessibility.md) | WCAG 2.2 AA conformance, the axe gate, and the patterns the CSP forced |
| [vpat.md](vpat.md) | VPAT 2.5 / EN 301 549 conformance report, criterion by criterion, marking what is verified and what is not |
| [application-evaluation.md](application-evaluation.md) | Scored assessment across 23 dimensions, with the evidence for each score |

## Product

| Document | What it answers |
| --- | --- |
| [user-stories.md](user-stories.md) | Every story with acceptance criteria, grouped by module and traced to requirements |
| [user-guide/](user-guide/) | How to use each feature, per role, with screenshots — [HTML](user-guide/index.html) |
| [../SoW/](../SoW/) | Statement of work and the flow diagram set |

## Regenerating

```bash
npm run flows        # SoW/flows/*.mmd -> SoW/images/*.svg
npm run screenshots  # docs/user-guide/images/*.png, per role
npm run docs:html    # Markdown -> the HTML companions
```

`npm run screenshots` boots the API against a seeded database and drives a real
browser, so it needs PostgreSQL up and `CHROMIUM_PATH` pointing at a browser.
