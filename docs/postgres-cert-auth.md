# PostgreSQL TLS & certificate authentication

Two related things: **encrypting** the application-to-database hop, and
**authenticating** without a password.

> `node-postgres` does not negotiate TLS unless asked. An unset SSL mode is a
> plaintext connection, not an opportunistic one. This surprised us during
> implementation — the first version of this codebase connected in plaintext and
> nothing complained. Hence `DB_SSL_MODE`, and a test that fails production
> startup without it.

---

## How it works

Spendifre reads `DB_SSL_MODE` and builds the `pg` pool's `ssl` option:

| Mode | `ssl` option | Defends against |
| --- | --- | --- |
| `disable` | `false` | Nothing. Local only; **refused in production**. |
| `require` | `{ rejectUnauthorized: false }` | A passive listener. **Not** an active man in the middle — any certificate is accepted. |
| `verify-full` | `{ rejectUnauthorized: true, ca? }` | Both. Validates the chain and the hostname. |

`DB_CA_CERT` accepts a PEM inline or a path to one. Absent, Node falls back to
the platform trust store — correct for Azure, wrong for a private CA.

## Step by step — local dev certificates

Only needed if you want to exercise `verify-full` locally. The stock
`postgres:16` image has no certificate, so `disable` is the normal local setting.

```bash
mkdir -p deploy/certs && cd deploy/certs

# 1. A local CA.
openssl req -new -x509 -days 3650 -nodes -out ca.crt -keyout ca.key \
  -subj "/CN=spendifre-dev-ca"

# 2. A server certificate whose CN matches the hostname you connect to.
openssl req -new -nodes -out server.csr -keyout server.key \
  -subj "/CN=localhost"
openssl x509 -req -in server.csr -days 825 -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt

# 3. Postgres requires 0600 and ownership by the postgres user.
chmod 600 server.key && chown 999:999 server.key
```

Mount them and turn TLS on:

```yaml
services:
  db:
    image: postgres:16
    volumes:
      - ./deploy/certs/server.crt:/var/lib/postgresql/server.crt:ro
      - ./deploy/certs/server.key:/var/lib/postgresql/server.key:ro
    command: >
      postgres -c ssl=on
               -c ssl_cert_file=/var/lib/postgresql/server.crt
               -c ssl_key_file=/var/lib/postgresql/server.key
```

```bash
DB_SSL_MODE=verify-full
DB_CA_CERT=./deploy/certs/ca.crt
```

Verify from inside a session:

```sql
select ssl, version, cipher from pg_stat_ssl
join pg_stat_activity using (pid) where application_name = 'spendifre-api';
```

## Certificate authentication (passwordless, on-premise)

TLS encrypts; **client certificates** authenticate. With `clientcert=verify-full`
in `pg_hba.conf`, the client presents a certificate whose CN is the database
role, and no password exists to leak:

```
# pg_hba.conf — TLS required, client certificate must match the role
hostssl  spendifre  spendifre_app  0.0.0.0/0  cert  clientcert=verify-full
```

```bash
openssl req -new -nodes -out app.csr -keyout app.key -subj "/CN=spendifre_app"
openssl x509 -req -in app.csr -days 825 -CA ca.crt -CAkey ca.key -out app.crt
```

**This is not wired into Spendifre.** The pool would need `ssl.cert` and
`ssl.key` alongside `ssl.ca`; it is a small change and is noted as a gap rather
than described as if it worked.

## First-boot / existing-volume notes

- Postgres reads `ssl_cert_file` at start, so a certificate added to a running
  container needs a restart, not a reload.
- `ssl.key` must be `0600` and owned by the postgres user (uid 999 in the
  official image) or the server refuses to start — with a message that does not
  obviously say so.
- Rotating the server certificate does not invalidate sessions; existing
  connections keep their negotiated session until they close.

## Production (Azure)

Azure Database for PostgreSQL requires TLS by default and chains to a public
root, so:

```bash
DB_SSL_MODE=verify-full     # no DB_CA_CERT needed
```

Better still, remove the password entirely: **Entra authentication** lets the
container app's managed identity fetch a token, so there is no database
credential to rotate, leak or scan for. That is the target state — see
[`secrets.md`](./secrets.md) §3.
