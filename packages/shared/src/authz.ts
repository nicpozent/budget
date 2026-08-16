/**
 * The normative permission matrix from SPEC §5, encoded as data.
 *
 * This module is the single source of truth for authorisation. It is pure — no
 * database, no request object — so the matrix can be property-tested directly
 * and every denied (role, capability) pair asserted to 403 (SEC-001).
 *
 * Two axes, deliberately separate:
 *   1. capability — may this role perform this action at all?
 *   2. entity scope — on which entities may it perform it?
 * A role that holds a capability still fails authorisation if the target entity
 * is outside its scope (SEC-010, SEC-011).
 *
 * Where SPEC §4 ("all technology budgets, all entities" for CIO/CTO/Infra) and
 * the §5 matrix ("edit another entity's lines —") can be read as conflicting,
 * §5 is labelled normative and least privilege wins: those roles read across all
 * entities and write only to their own. See docs/adr/0003-permission-matrix.md.
 */

export const ROLES = [
  'admin',
  'cfo',
  'finance_manager',
  'cio',
  'cto',
  'infra_manager',
  'security_manager',
  'arch_manager',
  'pmo',
] as const;

export type Role = (typeof ROLES)[number];

/** Entra ID group -> role. Roles come from group claims only (ZT-002). */
export const ENTRA_GROUP_TO_ROLE: Readonly<Record<string, Role>> = Object.freeze({
  'SG-Spendifre-Admin': 'admin',
  'SG-Spendifre-CFO': 'cfo',
  'SG-Spendifre-Mgr-Finance': 'finance_manager',
  'SG-Spendifre-CIO': 'cio',
  'SG-Spendifre-CTO': 'cto',
  'SG-Spendifre-Mgr-Infra': 'infra_manager',
  'SG-Spendifre-Mgr-Security': 'security_manager',
  'SG-Spendifre-Mgr-Arch': 'arch_manager',
  'SG-Spendifre-Mgr-PMO': 'pmo',
});

export const CAPABILITIES = [
  'budget.line.edit.own',
  'budget.line.edit.any',
  'budget.view.any',
  'budget.submit',
  'submission.decide',
  'submission.requestInfo',
  'submission.decideLine',
  'template.define',
  'costCentre.create',
  'costCentre.approve',
  'entity.manage',
  'fx.edit',
  'fx.view',
  'capex.approveAssetLife',
  'cycle.phase',
  'cycle.exception',
  'cycle.rules',
  'actuals.record',
  'allocation.edit',
  'audit.viewAll',
  'audit.viewOwn',
  'governance.edit',
  // Operational capabilities. SPEC §5 does not enumerate these; they are an
  // extension recorded in docs/adr/0005-operations.md, granted to Admin alone
  // and treated as step-up actions because a backup is a copy of everything —
  // every figure, every comment, and the whole audit trail.
  'backup.run',
  'backup.download',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** `true` = allowed, `false` = denied. Read-only cells in SPEC §5 are modelled
 *  as a denied write capability plus an allowed `*.view` capability, so that
 *  "R" can never be mistaken for a write grant. */
type Row = Readonly<Record<Role, boolean>>;

const row = (allowed: readonly Role[]): Row =>
  Object.freeze(
    Object.fromEntries(ROLES.map((r) => [r, allowed.includes(r)])) as Record<Role, boolean>,
  );

const ALL_MANAGERS: readonly Role[] = [
  'finance_manager',
  'cio',
  'cto',
  'infra_manager',
  'security_manager',
  'arch_manager',
  'pmo',
];

/** Roles that may read every entity's budget (SPEC §5 "View another entity's budget"). */
const CROSS_ENTITY_READERS: readonly Role[] = [
  'admin',
  'cfo',
  'finance_manager',
  'cio',
  'cto',
  'infra_manager',
];

export const PERMISSION_MATRIX: Readonly<Record<Capability, Row>> = Object.freeze({
  'budget.line.edit.own': row(['admin', ...ALL_MANAGERS]),
  'budget.line.edit.any': row(['admin']),
  'budget.view.any': row(CROSS_ENTITY_READERS),
  'budget.submit': row(ALL_MANAGERS),
  'submission.decide': row(['cfo']),
  'submission.requestInfo': row(['cfo']),
  'submission.decideLine': row(['cfo']),
  'template.define': row(['admin']),
  'costCentre.create': row(['admin']),
  'costCentre.approve': row(['cfo']),
  'entity.manage': row(['admin']),
  'fx.edit': row(['admin']),
  'fx.view': row([...ROLES]),
  'capex.approveAssetLife': row(['finance_manager']),
  'cycle.phase': row(['cfo', 'finance_manager']),
  'cycle.exception': row(['cfo', 'finance_manager']),
  'cycle.rules': row(['cfo', 'finance_manager']),
  'actuals.record': row(['admin', ...ALL_MANAGERS]),
  'allocation.edit': row(['admin']),
  'audit.viewAll': row(['admin', 'cfo']),
  'audit.viewOwn': row([...ROLES]),
  'governance.edit': row(['admin', 'cfo']),
  'backup.run': row(['admin']),
  'backup.download': row(['admin']),
});

export function can(role: Role, capability: Capability): boolean {
  // Deny by default: an unknown role or capability is a denial, never a throw
  // that a caller might catch and treat as success (SEC-010).
  const matrixRow = PERMISSION_MATRIX[capability];
  if (!matrixRow) return false;
  return matrixRow[role] === true;
}

export type EntityScope = 'all' | 'own';

/** Which entities a role may *read*. */
export function readScope(role: Role): EntityScope {
  return CROSS_ENTITY_READERS.includes(role) ? 'all' : 'own';
}

/** Which entities a role may *write* to. */
export function writeScope(role: Role): EntityScope {
  return role === 'admin' ? 'all' : 'own';
}

export interface Principal {
  readonly userId: string;
  readonly role: Role;
  /** Entity IDs the principal owns. Derived server-side from the session, never
   *  from the request body (SEC-011). */
  readonly ownedEntityIds: readonly string[];
}

/** True if `principal` may read data belonging to `entityId`. */
export function canReadEntity(principal: Principal, entityId: string): boolean {
  if (readScope(principal.role) === 'all') return true;
  return principal.ownedEntityIds.includes(entityId);
}

/** True if `principal` may write data belonging to `entityId`. */
export function canWriteEntity(principal: Principal, entityId: string): boolean {
  if (writeScope(principal.role) === 'all') return true;
  return principal.ownedEntityIds.includes(entityId);
}

/**
 * Actions that are irreversible or privilege-affecting and therefore require a
 * fresh authentication before they are accepted (ZT-007).
 */
export const STEP_UP_CAPABILITIES: readonly Capability[] = Object.freeze([
  'submission.decide',
  'cycle.phase',
  'cycle.exception',
  'governance.edit',
  'entity.manage',
  // A backup is a complete copy of the dataset and a download moves it out of
  // the system boundary. Both warrant fresh authentication (ZT-007) and both
  // are the shape ZT-008 asks us to alert on.
  'backup.run',
  'backup.download',
]);

export function requiresStepUp(capability: Capability): boolean {
  return STEP_UP_CAPABILITIES.includes(capability);
}

/**
 * Roles for which Conditional Access must require a managed, compliant device
 * and phishing-resistant MFA (ZT-002, ZT-003). Enforced in Entra policy; the
 * application re-checks the resulting claims so a misconfigured policy fails
 * closed rather than silently granting access.
 */
export const PRIVILEGED_ROLES: readonly Role[] = Object.freeze([
  'admin',
  'cfo',
  'finance_manager',
]);

export function isPrivileged(role: Role): boolean {
  return PRIVILEGED_ROLES.includes(role);
}
