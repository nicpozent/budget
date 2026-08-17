/**
 * English — the source catalogue (NFR-010).
 *
 * Every other locale is typed against this one, so a key added here without a
 * translation is a compile error in five files rather than a silent fallback
 * nobody notices.
 */

export const EN = {
  // Shell
  'app.name': 'Spendifre',
  'app.skipToContent': 'Skip to main content',
  'app.sections': 'Sections',
  'app.loading': 'Loading…',
  'app.signOut': 'Sign out',
  'app.themeLight': 'Light theme',
  'app.themeDark': 'Dark theme',
  'app.fiscalYear': 'FY{year}',
  'app.eurAtLockedRate': 'FY{year}, EUR at the year-locked rate',
  'app.contentRegion': '{view} content',
  'app.actionFailed': 'The action failed.',

  // Sign-in
  'signIn.title': 'Spendifre',
  'signIn.blurb':
    'Sign in with your Birgma account. Access is granted by Entra ID group membership — there is no local account and no password to reset.',
  'signIn.button': 'Sign in with Microsoft Entra ID',

  // Navigation groups
  'nav.group.plan': 'Plan',
  'nav.group.analyse': 'Analyse',
  'nav.group.approve': 'Approve',
  'nav.group.govern': 'Govern',

  // Navigation items
  'nav.budget': 'Budget entry',
  'nav.consumption': 'Actuals',
  'nav.variance': 'Variance',
  'nav.trend': 'Trend',
  'nav.consolidation': 'Consolidation',
  'nav.allocations': 'Allocations',
  'nav.fxHistory': 'FX history',
  'nav.submissions': 'Submissions',
  'nav.costCentres': 'Cost centres',
  'nav.audit': 'Audit trail',
  'nav.governance': 'Data governance',
  'nav.operations': 'Operations',

  // Budget entry
  'budget.title': 'Budget entry',
  'budget.noEntity': 'No entity in scope',
  'budget.planned': '{amount} planned',
  'budget.entity': 'Entity',
  'budget.displayCurrency': 'Display currency',
  'budget.local': 'Local',
  'budget.eur': 'EUR',
  'budget.submit': 'Submit for review',

  // Trend (FR-061)
  'trend.title': 'Five-year trend',
  'trend.description':
    'Plan totals in EUR at each year’s locked rate. Prior years before FY{year} are modelled, not booked.',
  'trend.mode': 'Break down by',
  'trend.mode.total': 'Group total',
  'trend.mode.category': 'By category',
  'trend.mode.line': 'Top lines',
  'trend.allEntities': 'All entities in scope',
  'trend.series': 'Series',
  'trend.noData': 'No trend data for the current scope.',
  'trend.caption': 'Group plan total per year, and the change on the year before.',
  'trend.captionPlotted': 'Plan total per year for {label}, and the change on the year before.',
  'trend.seriesCaption':
    'Each row is one series across five years. Choose Plot to chart it above.',
  'trend.plotted': 'Plotted: {label}',
  'trend.plot': 'Plot',
  'trend.year': 'Year',
  'trend.total': 'Total (EUR)',
  'trend.change': 'Change',

  // FX history (FR-063)
  'fx.title': 'FX rate history',
  'fx.description':
    'Rate to EUR per currency across five years, with the drift between the first and last year on record.',
  'fx.currency': 'Currency',
  'fx.drift': 'Drift',
  'fx.volatility': 'Volatility',
  'fx.rate': 'Rate',
  'fx.noData': 'No FX history recorded.',
  'fx.volatilityHint':
    'Volatility is the spread between the highest and lowest rate on record, as a share of the mean.',

  // Allocations (FR-023)
  'alloc.title': 'Allocations and chargeback',
  'alloc.description':
    'Central pools charged to entities on a driver key. What an entity is charged is read-only to it (INV-6).',
  'alloc.pools': 'Central pools',
  'alloc.pool': 'Pool',
  'alloc.amount': 'Amount',
  'alloc.driver': 'Driver',
  'alloc.byEntity': 'Own, charged and total by entity',
  'alloc.entity': 'Entity',
  'alloc.own': 'Own (EUR)',
  'alloc.charged': 'Charged (EUR)',
  'alloc.total': 'Total (EUR)',
  'alloc.readOnly': 'Read-only to the receiving entity',
  'alloc.noPools': 'No central pools are configured for this year.',
  'alloc.poolsCaption': 'Each pool is charged out in full on the driver named beside it.',
  'alloc.entityCaption':
    'Own is the entity’s own plan; charged is its share of the central pools. The padlock marks a figure the entity cannot change.',


  // Budget grid and bulk operations
  'grid.line': 'Line',
  'grid.vendor': 'Vendor',
  'grid.costCentre': 'Cost centre',
  'grid.currency': 'Currency',
  'grid.total': 'Total',
  'grid.status': 'Status',
  'grid.entityTotalEur': 'Entity total (EUR)',
  'grid.dormant': 'Dormant',
  'grid.overPace': 'Over pace',
  'grid.aboveThreshold': 'Above threshold',
  'grid.complete': 'Complete',
  'grid.uplift': 'Uplift %',
  'grid.applyUplift': 'Apply uplift',
  'grid.moveToCostCentre': 'Move to cost centre',
  'grid.choose': 'Choose…',
  'grid.reassign': 'Reassign',
  'grid.copyPriorYear': 'Copy prior year',
  'grid.delete': 'Delete',
  'grid.clearSelection': 'Clear selection',

  // Line detail drawer (FR-012)
  'drawer.vendor': 'Vendor',
  'drawer.costCentre': 'Cost centre',
  'drawer.notSet': 'Not set',
  'drawer.glAccount': 'GL account',
  'drawer.justification': 'Justification',
  'drawer.phasing': 'Phasing',
  'drawer.period': 'Period',
  'drawer.plan': 'Plan',
  'drawer.recorded': 'Recorded',
  'drawer.total': 'Total',
  'drawer.capex': 'Capex',
  'drawer.approved': 'Approved',
  'drawer.rejected': 'Rejected',
  'drawer.awaitingFinanceManager': 'Awaiting Finance Manager',
  'drawer.comments': 'Comments',
  'drawer.addAComment': 'Add a comment',
  'drawer.postComment': 'Post comment',

  // Operations (ADR-0005)
  'ops.thisActionNeedsAFreshSigninBackupsAndExp':
    'This action needs a fresh sign-in. Backups and exports move the whole',
  'ops.signInAgain': 'Sign in again',
  'ops.operations': 'Operations',
  'ops.bothActionsAreRecordedInTheAuditTrailWit':
    'Both actions are recorded in the audit trail with their row counts.',
  'ops.backupHistory': 'Backup history',
  'ops.taken': 'Taken',
  'ops.region': 'Region',
  'ops.status': 'Status',
  'ops.rows': 'Rows',
  'ops.size': 'Size',
  'ops.auditChain': 'Audit chain',
  'ops.download': 'Download',
  'ops.complete': 'Complete',
  'ops.failed': 'Failed',
  'ops.intact': 'Intact',
  'ops.broken': 'Broken',
  'ops.notRecorded': 'Not recorded',
  'ops.noBackupsTakenYet': 'No backups taken yet.',

  // Status chips
  'status.notSet': 'Not set',

  // Reporting and administration views
  'views.loading': 'Loading…',
  'views.groupTotalEur': 'Group total (EUR)',
  'views.recordedSpend': 'Recorded spend',
  'views.consumed': 'Consumed',
  'views.entitiesInScope': 'Entities in scope',
  'views.categorySplit': 'Category split',
  'views.submissionStatusByEntity': 'Submission status by entity',
  'views.everyFigureIsTheSumOfThatEntitysLines':
    'Every figure is the sum of that entity’s lines.',
  'views.entity': 'Entity',
  'views.name': 'Name',
  'views.state': 'State',
  'views.planEur': 'Plan (EUR)',
  'views.spend': 'Spend',
  'views.allEntitiesInScope': 'All entities in scope',
  'views.fullyearPlan': 'Full-year plan',
  'views.spendToDate': 'Spend to date',
  'views.variance': 'Variance',
  'views.consumptionByLine': 'Consumption by line',
  'views.line': 'Line',
  'views.category': 'Category',
  'views.plan': 'Plan',
  'views.pace': 'Pace',
  'views.overPace': 'Over pace',
  'views.onPace': 'On pace',
  'views.largestMovements': 'Largest movements',
  'views.priorYear': 'Prior year',
  'views.thisYear': 'This year',
  'views.movement': 'Movement',
  'views.kind': 'Kind',
  'views.allKinds': 'All kinds',
  'views.change': 'Change',
  'views.approval': 'Approval',
  'views.workflow': 'Workflow',
  'views.governance': 'Governance',
  'views.search': 'Search',
  'views.appendonlyEntriesCannotBeEditedOrDeleted':
    'Append-only. Entries cannot be edited or deleted by anyone (FR-073).',
  'views.when': 'When',
  'views.actor': 'Actor',
  'views.role': 'Role',
  'views.action': 'Action',
  'views.detail': 'Detail',
  'views.noMatchingEvents': 'No matching events.',
  'views.noSubmissionsForThisCycleYet': 'No submissions for this cycle yet.',
  'views.approve': 'Approve',
  'views.requestMoreInformation': 'Request more information',
  'views.reject': 'Reject',
  'views.costCentreRegistry': 'Cost centre registry',
  'views.managersMayOnlyBookLinesToApprovedCentre':
    'Managers may only book lines to approved centres. Existing references to a',
  'views.code': 'Code',
  'views.description': 'Description',
  'views.status': 'Status',
  'views.decision': 'Decision',
  'views.approved': 'Approved',
  'views.pending': 'Pending',
  'views.rejected': 'Rejected',
  'views.fieldClassification': 'Field classification',
  'views.everyFieldCarriesExactlyOneClassificatio':
    'Every field carries exactly one classification (SPEC §9.1).',
  'views.field': 'Field',
  'views.class': 'Class',
  'views.personalData': 'Personal data',
  'views.confidential': 'Confidential',
  'views.retention': 'Retention',
  'views.enforcedByAScheduledJobThatWritesAnAudit':
    'Enforced by a scheduled job that writes an audit event per run, including the',
  'views.dataset': 'Dataset',
  'views.months': 'Months',

  // Session (WCAG 2.2.1, ZT-004)
  'session.title': 'Your session is about to end',
  'session.idleBody':
    'You have been inactive, so Spendifre will sign you out in {remaining}. Choose Continue to stay signed in.',
  'session.absoluteBody':
    'This session reaches its maximum length in {remaining} and cannot be extended. Save your work and sign in again.',
  'session.continue': 'Continue working',

  // Language
  'language.label': 'Language',
  'language.saved': 'Language updated.',



  // Budget state chips
  'state.draft': 'Draft',
  'state.submitted': 'Submitted',
  'state.changesRequested': 'Changes requested',
  'state.approved': 'Approved',
  'state.locked': 'Locked',

  // Grid caption and validation banner
  'grid.caption': 'FY{year} budget lines, grouped by category. Amounts shown in {unit}.',
  'grid.unitEur': 'euro at the year-locked rate',
  'grid.unitLocal': 'each line’s local currency',
  'validation.blocking': 'Blocking',
  'validation.warning': 'Warning',
  'validation.affectedLines': '({count} lines)',

  // Shared table furniture
  'table.noResults': 'Nothing to show.',
  'common.error': 'Something went wrong.',
} as const;
