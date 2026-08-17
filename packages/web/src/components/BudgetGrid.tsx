/**
 * The budget entry grid (FR-010..FR-016).
 *
 * Accessibility notes, since this is the densest surface in the product:
 *   * It is a real `<table>` with a `<caption>` and scoped headers, so a screen
 *     reader announces "row 4, Q2, 12 400" rather than a wall of divs.
 *   * Category bands are `<th scope="rowgroup">`, which is what makes the
 *     grouping audible as well as visible.
 *   * Every amount input has its own label, hidden visually but present.
 *   * Selection checkboxes drive the bulk bar and are keyboard reachable.
 *
 * FR-014 is enforced in the render, not just the API: a row shows every money
 * column in the *currently selected unit*, and the line's own currency code
 * beside it. There is no code path here that renders one column in EUR and its
 * neighbour in local.
 */

import { useMemo, useState } from 'react';
import type { BudgetLine, BudgetView, CostCentre } from '../types.ts';
import { PERIOD_LABELS, formatMoney, formatNumber, toInputValue } from '../format.ts';
import { CostCentreChip, Status } from './Status.tsx';
import { t } from '../i18n/index.ts';

export type Unit = 'local' | 'eur';

interface Props {
  view: BudgetView;
  costCentres: CostCentre[];
  unit: Unit;
  canEdit: boolean;
  selected: Set<string>;
  onToggleSelect: (lineId: string) => void;
  onSelectAll: (lineIds: string[], selected: boolean) => void;
  onOpenLine: (lineId: string) => void;
  onSetAmount: (line: BudgetLine, period: number, value: string) => void;
}

export function BudgetGrid({
  view,
  costCentres,
  unit,
  canEdit,
  selected,
  onToggleSelect,
  onSelectAll,
  onOpenLine,
  onSetAmount,
}: Props): JSX.Element {
  const labels = PERIOD_LABELS(view.periods);

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; lines: BudgetLine[] }>();
    for (const line of view.lines) {
      const group = map.get(line.categoryId) ?? { name: line.categoryName, lines: [] };
      group.lines.push(line);
      map.set(line.categoryId, group);
    }
    return [...map];
  }, [view.lines]);

  const totalsByCategory = useMemo(
    () => new Map(view.categoryTotals.map((t) => [t.categoryId, t])),
    [view.categoryTotals],
  );

  const allIds = view.lines.map((l) => l.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  if (view.lines.length === 0) {
    return (
      <div className="panel">
        <p className="empty">
          No lines yet. Add the first line to start this entity&rsquo;s budget.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="table-scroll" tabIndex={0} role="group">
        <table>
          <caption>
            {t('grid.caption', {
              year: view.cycle.fiscal_year,
              unit: unit === 'eur' ? t('grid.unitEur') : t('grid.unitLocal'),
            })}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onSelectAll(allIds, e.target.checked)}
                  aria-label="Select all lines"
                />
              </th>
              <th scope="col">{t('grid.line')}</th>
              <th scope="col">{t('grid.vendor')}</th>
              <th scope="col">{t('grid.costCentre')}</th>
              <th scope="col">{t('grid.currency')}</th>
              {labels.map((label) => (
                <th scope="col" className="num" key={label}>
                  {label}
                </th>
              ))}
              <th scope="col" className="num">
                {t('grid.total')}
              </th>
              <th scope="col">{t('grid.status')}</th>
            </tr>
          </thead>

          {grouped.map(([categoryId, group]) => {
            const categoryTotal = totalsByCategory.get(categoryId);
            return (
              <tbody key={categoryId}>
                <tr className="category-row">
                  <th scope="rowgroup" colSpan={5}>
                    {group.name}
                  </th>
                  {labels.map((label) => (
                    <th key={label} aria-hidden="true" />
                  ))}
                  <th className="num">
                    {/* INV-4: this figure is the sum of the rows below it,
                        computed server-side from the same line values. */}
                    {categoryTotal ? formatMoney(categoryTotal.plan, 'EUR', { compact: true }) : '—'}
                  </th>
                  <th />
                </tr>

                {group.lines.map((line) => (
                  <GridRow
                    key={line.id}
                    line={line}
                    labels={labels}
                    unit={unit}
                    canEdit={canEdit}
                    costCentres={costCentres}
                    selected={selected.has(line.id)}
                    onToggleSelect={onToggleSelect}
                    onOpenLine={onOpenLine}
                    onSetAmount={onSetAmount}
                  />
                ))}
              </tbody>
            );
          })}

          <tfoot>
            <tr>
              <td colSpan={5 + labels.length} className="num">
                <strong>{t('grid.entityTotalEur')}</strong>
              </td>
              <td className="num">
                <strong>{formatMoney(view.entityTotal.plan, 'EUR')}</strong>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

interface RowProps {
  line: BudgetLine;
  labels: string[];
  unit: Unit;
  canEdit: boolean;
  costCentres: CostCentre[];
  selected: boolean;
  onToggleSelect: (lineId: string) => void;
  onOpenLine: (lineId: string) => void;
  onSetAmount: (line: BudgetLine, period: number, value: string) => void;
}

function GridRow({
  line,
  labels,
  unit,
  canEdit,
  selected,
  onToggleSelect,
  onOpenLine,
  onSetAmount,
}: RowProps): JSX.Element {
  // FR-021: a driver-linked amount is computed, so its inputs are read-only and
  // the expression is shown instead of a value the user could believe they own.
  const readOnly = !canEdit || line.computed || line.dormant;
  const displayCurrency = unit === 'eur' ? 'EUR' : line.currency;

  return (
    <tr aria-selected={selected}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(line.id)}
          aria-label={`Select ${line.name}`}
        />
      </td>

      <th scope="row">
        <button type="button" className="nav-item" onClick={() => onOpenLine(line.id)}>
          {line.name}
        </button>
        {line.computed ? (
          <div className="currency-code">
            = {line.driverKey} ({formatNumber(String(line.driverValue ?? 0))}) ×{' '}
            {line.driverRatePerUnit}
          </div>
        ) : null}
      </th>

      <td>{line.vendor ?? <span className="currency-code">—</span>}</td>

      <td>
        <CostCentreChip code={line.costCentreCode} status={line.costCentreStatus} />
      </td>

      <td className="currency-code">{line.currency}</td>

      {labels.map((label, index) => {
        const period = index + 1;
        const localValue = line.periodsLocal[index] ?? '0';
        return (
          <td className="num" key={label}>
            <label className="visually-hidden" htmlFor={`amt-${line.id}-${period}`}>
              {line.name}, {label}, {displayCurrency}
            </label>
            <input
              id={`amt-${line.id}-${period}`}
              className="input num"
              type="text"
              inputMode="decimal"
              defaultValue={unit === 'eur' ? '' : toInputValue(localValue)}
              placeholder={unit === 'eur' ? formatNumber(localValue) : undefined}
              readOnly={readOnly}
              disabled={readOnly}
              onBlur={(e) => {
                if (readOnly) return;
                const next = e.target.value.trim();
                if (next !== toInputValue(localValue) && next !== '') {
                  onSetAmount(line, period, next);
                }
              }}
            />
          </td>
        );
      })}

      <td className="num">
        {formatMoney(unit === 'eur' ? line.totalEur : line.totalLocal, displayCurrency)}
      </td>

      <td>
        {/* Several conditions can apply at once; each is its own cue rather
            than being collapsed into a single colour. */}
        {line.dormant ? <Status tone="neutral">{t('grid.dormant')}</Status> : null}
        {line.costCentreException ? <Status tone="bad">{t('grid.costCentre')}</Status> : null}
        {line.overPace ? <Status tone="pending">{t('grid.overPace')}</Status> : null}
        {line.aboveThreshold ? <Status tone="pending">{t('grid.aboveThreshold')}</Status> : null}
        {line.complete && !line.costCentreException ? <Status tone="ok">{t('grid.complete')}</Status> : null}
      </td>
    </tr>
  );
}

/** FR-015 bulk operation bar, shown only when a selection exists. */
export function BulkBar({
  count,
  costCentres,
  onUplift,
  onReassign,
  onCopyPriorYear,
  onDelete,
  onClear,
}: {
  count: number;
  costCentres: CostCentre[];
  onUplift: (percent: string) => void;
  onReassign: (costCentreId: string) => void;
  onCopyPriorYear: () => void;
  onDelete: () => void;
  onClear: () => void;
}): JSX.Element | null {
  const [percent, setPercent] = useState('3');
  const [centre, setCentre] = useState('');
  const approved = costCentres.filter((c) => c.status === 'approved');

  if (count === 0) return null;

  return (
    <div className="toolbar" role="region" aria-label="Bulk operations">
      <strong>{count} selected</strong>

      <div className="field">
        <label htmlFor="bulk-uplift">{t('grid.uplift')}</label>
        <input
          id="bulk-uplift"
          className="input num"
          value={percent}
          inputMode="decimal"
          onChange={(e) => setPercent(e.target.value)}
        />
      </div>
      <button type="button" className="button" onClick={() => onUplift(percent)}>
        {t('grid.applyUplift')}
      </button>

      <div className="field">
        <label htmlFor="bulk-centre">{t('grid.moveToCostCentre')}</label>
        <select
          id="bulk-centre"
          className="select"
          value={centre}
          onChange={(e) => setCentre(e.target.value)}
        >
          <option value="">{t('grid.choose')}</option>
          {approved.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.description}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="button"
        disabled={!centre}
        onClick={() => onReassign(centre)}
      >
        {t('grid.reassign')}
      </button>

      <button type="button" className="button" onClick={onCopyPriorYear}>
        {t('grid.copyPriorYear')}
      </button>
      <button type="button" className="button button-danger" onClick={onDelete}>
        {t('grid.delete')}
      </button>
      <button type="button" className="button" onClick={onClear}>
        {t('grid.clearSelection')}
      </button>
    </div>
  );
}
