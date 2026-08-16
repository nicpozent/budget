/**
 * Anonymisation, seed modes, and admin operations.
 *
 * The anonymiser tests are the important ones. "We anonymised it" is a claim
 * that is trivially easy to believe and hard to check, so each test names the
 * specific re-identification route it closes and asserts on the output rather
 * than on the intent.
 */

import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymise } from '../tools/anonymise.ts';
import { syntheticDataset } from '../packages/api/src/db/dataset.ts';
import { sql } from '../packages/api/src/db/pool.ts';
import { createBackup, listBackups, readBackup } from '../packages/api/src/services/backup.ts';
import { createHarness, type AuthHeaders, type Harness } from './harness.ts';

/**
 * A miniature stand-in for the real workbook, carrying every category of
 * sensitive content the real one does: a real-looking business unit name, a
 * vendor in a line name, a person's given name in a Training line, and exact
 * amounts.
 */
const SOURCE = {
  units: [
    {
      code: 'BMI Infra',
      title: 'BMI - Infra EUR',
      cats: [
        {
          name: 'Consultancies',
          items: [
            { name: 'Partner Be-Terna', cur: 'EUR', q: [20750, 20750, 20750, 20750] },
            { name: 'Partner Advania', cur: 'EUR', q: [10000, 10000, 10000, 10000] },
          ],
        },
        {
          name: 'Training',
          items: [
            { name: 'Training Anita', cur: 'EUR', q: [500, 0, 700, 0] },
            { name: 'Training Marianna', cur: 'EUR', q: [500, 0, 1000, 0] },
          ],
        },
      ],
    },
    {
      code: 'BTS',
      title: 'Biltema Sweden SEK',
      cats: [
        {
          name: 'Licenses',
          items: [{ name: 'Citrix licensing', cur: 'SEK', q: [88000, 88000, 88000, 88000] }],
        },
      ],
    },
  ],
  fx: { EUR: 1, SEK: 0.087 },
  comments: ['Agreement signed for 3 years, paid annually. Evaluating alternatives.'],
};

const IDENTIFYING = [
  'Be-Terna', 'Advania', 'Anita', 'Marianna', 'Citrix',
  'BMI Infra', 'BTS', 'Biltema', 'BMI - Infra EUR', 'Biltema Sweden SEK',
];

describe('Anonymisation — direct identifiers (route 1)', () => {
  const fixture = anonymise(SOURCE, { key: 'ab'.repeat(32) });
  const serialised = JSON.stringify(fixture);

  it('carries no vendor name, person name, entity code or entity title', () => {
    for (const token of IDENTIFYING) {
      expect(serialised, `"${token}" survived anonymisation`).not.toContain(token);
    }
  });

  it('discards free text entirely rather than transforming it', () => {
    expect(serialised).not.toContain('Agreement signed');
    expect(serialised).not.toContain('Evaluating alternatives');
  });

  it('replaces line names with a generic label, not a pseudonym of the original', () => {
    // A consistent pseudonym would still support linkage across releases.
    for (const line of fixture.lines) {
      expect(line.name).toMatch(/^[A-Z][A-Za-z /]+ \d+$/);
    }
  });

  it('keeps the category names, which are admin-defined and not sensitive', () => {
    expect(fixture.categories.map((c) => c.name).sort())
      .toEqual(['Consultancies', 'Licenses', 'Training']);
  });
});

describe('Anonymisation — quasi-identifiers (route 2)', () => {
  const fixture = anonymise(SOURCE, { key: 'cd'.repeat(32), jitterPercent: 7, roundingUnit: 100 });

  it('carries no exact source amount', () => {
    const exact = ['20750', '10000', '88000'];
    const amounts = fixture.lines.flatMap((l) => l.quarters);
    for (const value of exact) {
      expect(amounts, `exact amount ${value} survived`).not.toContain(value);
    }
  });

  it('keeps magnitude so the data is still useful', () => {
    const licences = fixture.lines.find((l) => l.categoryName === 'Licenses');
    const amount = Number(licences!.quarters[0]);
    // Within jitter + rounding of the 88 000 original.
    expect(amount).toBeGreaterThan(80_000);
    expect(amount).toBeLessThan(96_000);
  });

  it('leaves a zero as a zero', () => {
    // Two Training quarters are genuinely zero. Inventing spend there would
    // corrupt the phasing shape the fixture exists to preserve.
    const training = fixture.lines.filter((l) => l.categoryName === 'Training');
    expect(training.flatMap((l) => l.quarters).filter((q) => q === '0').length).toBe(4);
  });

  it('rounds to the configured unit', () => {
    for (const line of fixture.lines) {
      for (const quarter of line.quarters) {
        expect(Number(quarter) % 100, `${quarter} is not a multiple of 100`).toBe(0);
      }
    }
  });
});

describe('Anonymisation — positional linkage (route 3)', () => {
  it('does not preserve source ordering', () => {
    // With a fixed key the output is stable; what must not be stable is the
    // mapping from input position to output position.
    const many = {
      ...SOURCE,
      units: Array.from({ length: 40 }, (_, i) => ({
        code: `U${i}`,
        title: `Unit ${i}`,
        cats: [{ name: 'Other', items: [{ name: `Line ${i}`, cur: 'EUR', q: [i * 1000, 0, 0, 0] }] }],
      })),
    };
    const fixture = anonymise(many, { key: 'ef'.repeat(32) });

    // If order were preserved, ENT-01 would hold the value from unit 0.
    const first = fixture.lines.find((l) => l.entityCode === 'ENT-01');
    expect(Number(first!.quarters[0])).not.toBe(0);
  });
});

describe('Anonymisation — singling out by structure (route 4)', () => {
  it('reports entities that are unique on their observable shape', () => {
    const fixture = anonymise(SOURCE, { key: '01'.repeat(32) });
    // Both fixture units are structurally unique, and the tool says so rather
    // than letting the output be called anonymous when it is pseudonymous.
    expect(fixture.meta.singletonClasses.length).toBe(2);
  });

  it('records the parameters used, so the output can be judged', () => {
    const fixture = anonymise(SOURCE, { key: '01'.repeat(32), jitterPercent: 12 });
    expect(fixture.meta.method).toBe('anonymised');
    expect(fixture.meta.jitterPercent).toBe(12);
  });

  it('does not include any fingerprint of the source', () => {
    // A digest would let someone confirm a guess about which workbook this came
    // from — the same disclosure by a longer route.
    const fixture = anonymise(SOURCE, { key: '01'.repeat(32) });
    expect(Object.keys(fixture.meta)).not.toContain('sourceHash');
    expect(JSON.stringify(fixture.meta)).not.toMatch(/hash|digest|checksum/i);
  });
});

describe('Anonymisation — keying', () => {
  it('is reproducible with a supplied key', () => {
    const a = anonymise(SOURCE, { key: '02'.repeat(32) });
    const b = anonymise(SOURCE, { key: '02'.repeat(32) });
    expect(JSON.stringify(a.lines)).toBe(JSON.stringify(b.lines));
  });

  it('is unlinkable across runs without one', () => {
    const a = anonymise(SOURCE);
    const b = anonymise(SOURCE);
    // Different random keys, so the amounts differ. The key is discarded when
    // the process exits, so no mapping back to the source survives anywhere.
    expect(JSON.stringify(a.lines)).not.toBe(JSON.stringify(b.lines));
  });
});

describe('Seed modes', () => {
  it('produces a synthetic dataset with no reference to the real extract', () => {
    const dataset = syntheticDataset();
    expect(dataset.entities.length).toBe(21);
    expect(dataset.lines.length).toBeGreaterThan(400);
    expect(dataset.provenance).toContain('synthetic');

    const serialised = JSON.stringify(dataset);
    for (const token of IDENTIFYING) {
      expect(serialised).not.toContain(token);
    }
  });

  it('refuses a fixture that is not an anonymiser output', async () => {
    // The failure this prevents is someone pointing SEED_MODE at the raw
    // workbook extract.
    const { anonymisedDataset } = await import('../packages/api/src/db/dataset.ts');
    await expect(anonymisedDataset('package.json')).rejects.toThrow(/not an anonymiser output/);
  });

  it('explains how to generate a missing fixture rather than failing bare', async () => {
    const { anonymisedDataset } = await import('../packages/api/src/db/dataset.ts');
    await expect(anonymisedDataset('db/fixtures/does-not-exist.json'))
      .rejects.toThrow(/tools\/anonymise\.ts/);
  });
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

let harness: Harness;
let admin: AuthHeaders;

beforeAll(async () => {
  harness = await createHarness();
  admin = await harness.as('admin@birgma.test');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const authed = (h: AuthHeaders, json = true) => ({
  cookie: h.cookie,
  'x-csrf-token': h['x-csrf-token'],
  origin: h.origin,
  ...(json ? { 'content-type': 'application/json' } : {}),
});

describe('Admin backup', () => {
  it('creates a backup covering every table and records the row counts', async () => {
    const manifest = await createBackup(harness.db, harness.config, {
      userId: admin.userId,
      role: 'admin',
      ownedEntityIds: [],
    });

    expect(manifest.status).toBe('complete');
    expect(Number(manifest.byteSize)).toBeGreaterThan(0);
    expect(manifest.rowCounts.line_items).toBeGreaterThan(0);
    expect(manifest.rowCounts.audit_events).toBeGreaterThan(0);
    // Live credentials are deliberately excluded.
    expect(manifest.rowCounts.sessions).toBeUndefined();
  });

  it('attests the audit chain state at capture time', async () => {
    const manifest = await createBackup(harness.db, harness.config, {
      userId: admin.userId, role: 'admin', ownedEntityIds: [],
    });
    expect(manifest.auditChainIntact).toBe(true);
    expect(Number(manifest.auditHeadSeq)).toBeGreaterThan(0);
  });

  it('writes only ciphertext to disk', async () => {
    const manifest = await createBackup(harness.db, harness.config, {
      userId: admin.userId, role: 'admin', ownedEntityIds: [],
    });

    const files = await readdir(harness.config.BACKUP_DIR);
    const file = files.find((f) => f.startsWith(manifest.id));
    expect(file).toBeDefined();

    const raw = await readFile(`${harness.config.BACKUP_DIR}/${file}`);
    const asText = raw.toString('latin1');
    // A stolen archive must be inert: no table marker, no gzip magic, nothing
    // that identifies the contents.
    expect(asText).not.toContain('line_items');
    expect(asText).not.toContain('spendifre-backup');
    expect(raw.subarray(0, 2).toString('hex')).not.toBe('1f8b');
  });

  it('round-trips to the original contents', async () => {
    const manifest = await createBackup(harness.db, harness.config, {
      userId: admin.userId, role: 'admin', ownedEntityIds: [],
    });

    const { contents } = await readBackup(harness.db, harness.config, manifest.id);
    const lines = contents.toString('utf8').trim().split('\n');
    const header = JSON.parse(lines[0]!) as { _meta: { format: string; region: string } };

    expect(header._meta.format).toBe('spendifre-backup-v1');
    expect(header._meta.region).toBe('eu');
    expect(lines.length).toBe(
      1 + Object.values(manifest.rowCounts).reduce((n, c) => n + c, 0),
    );
  });

  it('detects a tampered archive before returning anything', async () => {
    const manifest = await createBackup(harness.db, harness.config, {
      userId: admin.userId, role: 'admin', ownedEntityIds: [],
    });

    // Flip the stored digest, standing in for a modified file on disk.
    await harness.db.query(sql`
      update backups set sha256 = ${Buffer.alloc(32, 1)} where id = ${manifest.id}
    `);

    await expect(readBackup(harness.db, harness.config, manifest.id))
      .rejects.toThrow(/integrity/);
  });

  it('refuses a backup belonging to another region', async () => {
    const manifest = await createBackup(harness.db, harness.config, {
      userId: admin.userId, role: 'admin', ownedEntityIds: [],
    });
    await harness.db.query(sql`
      update backups set region = 'apac' where id = ${manifest.id}
    `);

    // Same rule as live data: a deployment does not serve another region's
    // records, and its copies are records too (CMP-140).
    await expect(readBackup(harness.db, harness.config, manifest.id))
      .rejects.toThrow(/another region/);
  });

  it('audits creation with the row count', async () => {
    const before = await harness.db.one<{ n: string }>(sql`
      select count(*)::text as n from audit_events where action = 'backup.create'
    `);
    await createBackup(harness.db, harness.config, {
      userId: admin.userId, role: 'admin', ownedEntityIds: [],
    });
    const after = await harness.db.one<{ detail: string }>(sql`
      select detail from audit_events where action = 'backup.create'
      order by seq desc limit 1
    `);
    const count = await harness.db.one<{ n: string }>(sql`
      select count(*)::text as n from audit_events where action = 'backup.create'
    `);

    expect(Number(count!.n)).toBe(Number(before!.n) + 1);
    expect(after!.detail).toMatch(/\d+ rows across \d+ tables/);
    expect(after!.detail).toContain('audit chain intact');
  });

  it('lists history newest first', async () => {
    const backups = await listBackups(harness.db);
    expect(backups.length).toBeGreaterThan(1);
    const times = backups.map((b) => new Date(b.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe('Admin backup over HTTP', () => {
  it('creates and downloads through the API', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      headers: authed(admin),
      // The client posts an empty object; a JSON content-type with no body at
      // all is a parse error, which is a different test.
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    const manifest = created.json() as { id: string };

    const download = await harness.app.inject({
      method: 'GET',
      url: `/api/admin/backups/${manifest.id}/download`,
      headers: authed(admin, false),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.body).toContain('spendifre-backup-v1');
  });

  it('audits the download separately from the creation', async () => {
    const row = await harness.db.one<{ n: string }>(sql`
      select count(*)::text as n from audit_events where action = 'backup.download'
    `);
    expect(Number(row!.n)).toBeGreaterThan(0);
  });

  it('requires fresh authentication (ZT-007)', async () => {
    // Age the session past the step-up window. A backup is a complete copy of
    // the dataset; a session left open all afternoon should not be enough.
    const stale = await harness.as('admin@birgma.test');
    await harness.db.query(sql`
      update sessions set auth_time = now() - interval '2 hours'
      where user_id = ${stale.userId}
    `);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      headers: authed(stale),
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code)
      .toBe('step_up_required');
  });
});
