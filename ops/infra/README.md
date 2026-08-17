# Infrastructure

One deployment per residency region (SPEC §9.4). The parameter files differ in
`residency` and `location`; the template does not branch on them beyond backup
geo-redundancy, which is deliberate — an EU and an APAC deployment should be the
same system in two places, not two systems.

| File | What it is |
| --- | --- |
| `main.bicep` | The whole environment: identity, Key Vault, VNet, PostgreSQL, storage, logs, container app, alerts |
| `eu.bicepparam` | EU parameters. Copy for `ch`, `apac`, `cn` |
| `../alerts/` | The ZT-008 alert rules, in Prometheus and KQL form |

## What this template will not do

**It does not create the Entra app registration.** That needs a directory
administrator and a redirect URI that depends on the FQDN this template outputs,
so it is a two-step by nature. `docs/secrets.md` has the steps.

**It does not seed secrets.** `backup-encryption-key`, `telemetry-salt` and
`metrics-token` must exist in the vault before the first deployment. They are
generated once, by a human, and never leave the vault:

```bash
az keyvault secret set --vault-name spendifre-eu-kv \
  --name backup-encryption-key --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name spendifre-eu-kv \
  --name telemetry-salt --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name spendifre-eu-kv \
  --name metrics-token --value "$(openssl rand -base64 32)"
```

Losing `backup-encryption-key` makes every existing backup permanently
unreadable. Purge protection is on for that reason.

**It does not grant the database role.** The managed identity needs a PostgreSQL
role created inside the database, which is a data-plane operation:

```sql
select * from pgaadauth_create_principal('spendifre-eu-id', false, false);
grant spendifre_app to "spendifre-eu-id";
```

**It does not run migrations.** They execute as `spendifre_migrator`, a
different role from the application (SEC-021), from a job — not from the running
service. Keeping that out of the template preserves the privilege boundary the
directory layout already mirrors.

## Deploying

```bash
az deployment group create \
  --resource-group rg-spendifre-eu \
  --template-file main.bicep \
  --parameters eu.bicepparam \
  --parameters imageDigest="ghcr.io/nicpozent/spendifre@sha256:<verified digest>"
```

The digest comes from the release pipeline, which verifies the signature and the
provenance attestation before emitting it. Deploying a tag instead would mean
running an image nobody verified.

## Not covered

- **No `cn` deployment exists.** `CMP-140` is unresolved, and a template that
  quietly made one would be answering a legal question with Bicep.
- **No DR runbook.** Restore is implemented and tested (`tools/restore.ts`), but
  the RTO and RPO commitments are still `CMP-107` open items.
