/**
 * SEC-001: "Every capability above has a test asserting that each denied role
 * receives 403."
 *
 * This file is that test, driven from the matrix itself rather than from a
 * hand-written list — so a capability added to SPEC §5 and encoded in
 * `PERMISSION_MATRIX` but not wired to an endpoint here fails the suite, and a
 * role quietly granted a capability fails it too.
 *
 * The assertion is deliberately one-sided per role: a denied role must receive
 * 403 (or 401/404 where the endpoint hides existence), and an allowed role must
 * receive anything *except* 403. Allowed roles are not asserted to succeed —
 * they may legitimately hit 409 or 422 on a fixture that is not set up for that
 * particular action, and pinning exact success codes here would make this an
 * integration test rather than an authorisation test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  PERMISSION_MATRIX,
  ROLES,
  can,
  type Capability,
  type Role,
} from '@spendifre/shared';
import { sql } from '../packages/api/src/db/pool.ts';
import { createHarness, grantAllPersonasOwnership, PERSONAS, type Harness } from './harness.ts';

interface Probe {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string | ((ids: Ids) => string);
  body?: unknown | ((ids: Ids) => unknown);
}

interface Ids {
  entityId: string;
  categoryId: string;
  otherEntityId: string;
  lineId: string;
  otherEntityLineId: string;
  capexLineId: string;
  costCentreId: string;
  submissionId: string;
  ruleId: string;
  fieldId: string;
  stageSubmissionId: string;
  templateVersionId: string;
  userId: string;
}

/**
 * One endpoint per capability. Where a capability guards several endpoints the
 * most privileged is chosen — if that one is properly denied, the others share
 * the same declaration.
 */
const PROBES: Record<Capability, Probe> = {
  'budget.line.edit.own': {
    method: 'POST',
    url: '/api/lines',
    body: (ids) => ({
      entityId: ids.entityId,
      categoryId: ids.categoryId,
      name: 'probe',
      costType: 'opex',
      currency: 'EUR',
    }),
  },
  // "Edit another entity's lines" — so the probe must target a line in an
  // entity the caller does not own. Only admin holds this.
  'budget.line.edit.any': {
    method: 'PATCH',
    url: (ids) => `/api/lines/${ids.otherEntityLineId}`,
    body: { name: 'probe', version: 0 },
  },
  'budget.view.any': { method: 'GET', url: '/api/reports/export.xlsx' },
  'budget.submit': { method: 'POST', url: (ids) => `/api/entities/${ids.entityId}/submit` },
  'submission.decide': {
    method: 'POST',
    url: (ids) => `/api/submissions/${ids.submissionId}/decision`,
    body: { decision: 'approve', comment: 'probe' },
  },
  'submission.requestInfo': {
    method: 'POST',
    url: (ids) => `/api/submissions/${ids.submissionId}/decision`,
    body: { decision: 'request_info', comment: 'probe' },
  },
  'submission.decideLine': {
    method: 'POST',
    url: (ids) => `/api/submissions/${ids.submissionId}/approve-all-lines`,
  },
  // A stage names exactly one role, so no single stage can be "allowed" for
  // all four capability holders — deciding one is a two-axis question, the same
  // shape as capability-versus-entity-scope. This probe isolates the capability
  // axis: an unknown stage id resolves to 404 for every role that holds the
  // capability, and the guard still returns 403 for every role that does not.
  // The stage semantics themselves (role condition, threshold, ordering,
  // segregation of duties) are asserted in test/approvals.test.ts.
  'submission.decideStage': {
    method: 'POST',
    url: (ids) => `/api/submissions/${ids.stageSubmissionId}/stage-decision`,
    body: {
      stageId: '00000000-0000-4000-8000-000000000000',
      decision: 'approved',
      comment: 'probe',
    },
  },
  'template.define': {
    method: 'PATCH',
    url: (ids) => `/api/template/fields/${ids.fieldId}`,
    body: { label: 'probe' },
  },
  'template.publish': {
    method: 'POST',
    url: (ids) => `/api/template/versions/${ids.templateVersionId}/publish`,
  },
  'approval.configure': {
    method: 'POST',
    url: '/api/approval-stages',
    body: { name: 'Probe stage', requiredRole: 'cfo', minAmountEur: '0', enabled: true },
  },
  'ledger.ingest': {
    method: 'POST',
    url: '/api/ledger/actuals',
    body: {
      externalRef: 'probe-batch',
      fiscalYear: 2026,
      sourceSystem: 'probe',
      rows: [{ lineRef: 'probe-ref', period: 1, amount: '1' }],
    },
  },
  'costCentre.create': {
    method: 'POST',
    url: '/api/cost-centres',
    body: { code: 'CC-PROBE', description: 'probe' },
  },
  'costCentre.approve': {
    method: 'POST',
    url: (ids) => `/api/cost-centres/${ids.costCentreId}/decision`,
    body: { decision: 'approved' },
  },
  'entity.manage': {
    method: 'POST',
    url: '/api/entities',
    body: { code: 'PROBE', name: 'Probe', currency: 'EUR', residency: 'eu' },
  },
  'fx.edit': {
    method: 'PUT',
    url: '/api/fx-rates',
    body: { currency: 'SEK', fiscalYear: 2026, rate: '0.088' },
  },
  'fx.view': { method: 'GET', url: '/api/fx-rates' },
  'capex.approveAssetLife': {
    method: 'POST',
    url: (ids) => `/api/lines/${ids.capexLineId}/asset-life`,
    body: { years: 5, decision: 'approved' },
  },
  'cycle.phase': { method: 'POST', url: '/api/cycle/phase', body: { phase: 'review' } },
  'cycle.exception': {
    method: 'POST',
    url: '/api/cycle/exceptions',
    body: (ids) => ({ entityId: ids.entityId, reason: 'probe', expiresInDays: 7 }),
  },
  'cycle.rules': {
    method: 'PATCH',
    url: (ids) => `/api/validation-rules/${ids.ruleId}`,
    body: { enabled: true },
  },
  'actuals.record': {
    method: 'PUT',
    url: (ids) => `/api/lines/${ids.lineId}/actuals`,
    body: { period: 1, amount: '1', version: 0 },
  },
  'allocation.edit': {
    method: 'PUT',
    url: '/api/allocations',
    body: { name: 'Probe pool', amount: '1', currency: 'EUR', driverKey: 'sites' },
  },
  'audit.viewAll': { method: 'GET', url: '/api/governance/audit-integrity' },
  'audit.viewOwn': { method: 'GET', url: '/api/audit' },
  'governance.edit': {
    method: 'PUT',
    url: '/api/governance/retention',
    body: { dataset: 'free_text', months: 36 },
  },
  'backup.run': { method: 'POST', url: '/api/admin/backups' },
  'selftest.run': { method: 'GET', url: '/api/admin/self-test' },
  // A non-existent id is fine here: a denied role is refused before the
  // handler runs, and an allowed role gets 404, which is "not 403".
  'backup.download': {
    method: 'GET',
    url: '/api/admin/backups/00000000-0000-4000-8000-000000000000/download',
  },
  // FR-080. A key that does not exist: an allowed role gets 404 from the
  // handler, a denied role never reaches it. Probing the capability, not the
  // record.
  'version.manage': { method: 'DELETE', url: '/api/versions/no-such-version' },
};

let harness: Harness;
let ids: Ids;

beforeAll(async () => {
  // Rate limiting off: this suite is about who may do what, and SEC-013 is
  // asserted separately in security.test.ts.
  harness = await createHarness({ rateLimit: 'off' });
  const { db } = harness;

  const financeUser = await db.one<{ id: string }>(sql`
    select id from users where email = 'finance@birgma.test'
  `);
  const owned = await db.one<{ entity_id: string }>(sql`
    select eo.entity_id from entity_owners eo
    join entities e on e.id = eo.entity_id
    where eo.user_id = ${financeUser!.id} and e.residency = 'eu'
    limit 1
  `);
  // An entity nobody owns, so "edit another entity's lines" is genuinely
  // out of scope for every non-admin role rather than accidentally owned by
  // whichever persona the seed's round-robin happened to assign.
  const other = await db.one<{ id: string }>(sql`
    select e.id from entities e
    where e.id <> ${owned!.entity_id} and e.residency = 'eu'
    order by e.code limit 1
  `);
  await db.query(sql`delete from entity_owners where entity_id = ${other!.id}`);
  const category = await db.one<{ id: string }>(sql`select id from categories limit 1`);
  const line = await db.one<{ id: string }>(sql`
    select id from line_items where entity_id = ${owned!.entity_id} and cost_type = 'opex' limit 1
  `);
  const otherLine = await db.one<{ id: string }>(sql`
    select id from line_items where entity_id = ${other!.id} limit 1
  `);
  const capexLine = await db.one<{ id: string }>(sql`
    select id from line_items where entity_id = ${owned!.entity_id} and cost_type = 'capex' limit 1
  `);
  const centre = await db.one<{ id: string }>(sql`
    select id from cost_centres where status = 'pending' limit 1
  `);
  const rule = await db.one<{ id: string }>(sql`select id from validation_rules limit 1`);
  const field = await db.one<{ id: string }>(sql`select id from template_fields limit 1`);
  // FR-051: a submission whose submitter holds none of the stage-approver
  // roles, so the segregation-of-duties refusal cannot mask the capability
  // check for any role the matrix says is allowed.
  const pmoUser = await db.one<{ id: string }>(sql`
    select id from users where email = 'pmo@birgma.test'
  `);
  const stageSubmission = await db.one<{ id: string }>(sql`
    insert into submissions (entity_id, fiscal_year, submitted_by)
    values (${owned!.entity_id}, 2026, ${pmoUser!.id}) returning id
  `);
  // FR-005: a draft version, so the publish probe exercises a real transition
  // for the allowed role rather than bouncing off "already published".
  const templateVersion = await db.one<{ id: string }>(sql`
    insert into template_versions (fiscal_year, version, state, note)
    values (2026, 99, 'draft', 'authz probe') returning id
  `);
  await db.query(sql`
    insert into template_fields
      (fiscal_year, template_version_id, field_key, label, field_type, required, visible, position)
    values (2026, ${templateVersion!.id}, 'probe_field', 'Probe', 'text', false, true, 0)
  `);

  // A submission to decide on, created by the finance manager so that the
  // segregation-of-duties path is exercised by the CFO probe.
  const submission = await db.one<{ id: string }>(sql`
    insert into submissions (entity_id, fiscal_year, submitted_by)
    values (${owned!.entity_id}, 2026, ${financeUser!.id}) returning id
  `);

  // Every persona owns the probe entity, so a 403 in this suite can only come
  // from the capability matrix and never from entity scope.
  await grantAllPersonasOwnership(db, owned!.entity_id);

  ids = {
    entityId: owned!.entity_id,
    categoryId: category!.id,
    otherEntityId: other!.id,
    lineId: line!.id,
    otherEntityLineId: otherLine!.id,
    capexLineId: capexLine!.id,
    costCentreId: centre!.id,
    submissionId: submission!.id,
    ruleId: rule!.id,
    fieldId: field!.id,
    stageSubmissionId: stageSubmission!.id,
    templateVersionId: templateVersion!.id,
    userId: financeUser!.id,
  };
});

afterAll(async () => {
  await harness?.close();
});

describe('SEC-001 permission matrix', () => {
  it('has a probe for every capability in the matrix', () => {
    for (const capability of CAPABILITIES) {
      expect(PROBES[capability], `no probe for ${capability}`).toBeDefined();
    }
    expect(Object.keys(PROBES).sort()).toEqual([...CAPABILITIES].sort());
  });

  for (const capability of CAPABILITIES) {
    describe(capability, () => {
      for (const role of ROLES) {
        const allowed = can(role, capability);

        it(`${role} is ${allowed ? 'allowed' : 'denied'}`, async () => {
          const probe = PROBES[capability];
          const headers = await harness.as(PERSONAS[role]);
          const url = typeof probe.url === 'function' ? probe.url(ids) : probe.url;
          const body = typeof probe.body === 'function' ? probe.body(ids) : probe.body;

          const response = await harness.app.inject({
            method: probe.method,
            url,
            headers: {
              cookie: headers.cookie,
              'x-csrf-token': headers['x-csrf-token'],
              origin: headers.origin,
              // Only declare a JSON body when there is one; an empty body with
              // a JSON content-type is a parse error, not an authz outcome.
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { payload: body }),
          });

          if (allowed) {
            // An allowed role may still fail on state (409) or payload (422);
            // what it must never receive is an authorisation refusal.
            expect(
              response.statusCode,
              `${role} should hold ${capability} but got ${response.statusCode} ${response.body}`,
            ).not.toBe(403);
          } else {
            expect(
              response.statusCode,
              `${role} must not hold ${capability} (got ${response.statusCode})`,
            ).toBe(403);
          }
        });
      }
    });
  }
});

describe('SPEC §5 matrix shape', () => {
  it('denies by default for an unknown capability', () => {
    // @ts-expect-error deliberately outside the union
    expect(can('admin', 'capability.that.does.not.exist')).toBe(false);
  });

  it('denies by default for an unknown role', () => {
    // @ts-expect-error deliberately outside the union
    expect(can('superuser', 'entity.manage')).toBe(false);
  });

  it('grants no capability to every role by accident', () => {
    // A row that is true for everyone is almost always a mistake. The two
    // legitimate cases are named explicitly so adding a third is a decision.
    const universal = CAPABILITIES.filter((c) =>
      ROLES.every((r) => PERMISSION_MATRIX[c][r as Role]),
    );
    expect(universal.sort()).toEqual(['audit.viewOwn', 'fx.view']);
  });

  it('keeps the CFO out of every editing capability', () => {
    // SPEC §12.5 records this as an open question; §5 currently encodes "no",
    // and this test is what will fail loudly if that answer changes.
    for (const capability of ['budget.line.edit.own', 'budget.line.edit.any', 'actuals.record'] as const) {
      expect(can('cfo', capability)).toBe(false);
    }
  });
});
