/**
 * A horizontally scrollable table region (A11Y-001, WCAG 1.3.1 / 2.1.1).
 *
 * Three attributes that have to travel together, and did not.
 *
 * `tabIndex` because a scroll container a keyboard user cannot focus is a
 * region they cannot scroll, and therefore columns they cannot read (axe:
 * `scrollable-region-focusable`). A focusable container needs a role, so
 * `role="group"`. And a role needs an accessible name — which is the part
 * twenty-five hand-written copies of this markup all omitted, so a screen
 * reader announced "group", said nothing else, and left the user to guess
 * which of the four tables on the page they had just entered.
 *
 * axe cannot see it: an unnamed `group` is valid ARIA. It was found by reading
 * the accessibility tree the browser actually exposes, which is what
 * `test/screenreader.test.ts` now does on every view.
 *
 * The name is the table's own caption, referenced by id rather than passed
 * twice, so the announced name and the visible caption cannot drift apart.
 */

import { useId, type ReactNode } from 'react';

export function TableScroll({
  caption,
  children,
}: {
  /** The table's caption. Visible, and the region's accessible name. */
  caption: ReactNode;
  /** `thead`, `tbody`, `tfoot` — everything inside `<table>` below the caption. */
  children: ReactNode;
}): JSX.Element {
  const captionId = useId();
  return (
    <div className="table-scroll" tabIndex={0} role="group" aria-labelledby={captionId}>
      <table>
        <caption id={captionId}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}
