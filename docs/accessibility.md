# Accessibility

Target: **WCAG 2.2 AA** (`A11Y-001`, `CMP-160`) and **EN 301 549** for the
European Accessibility Act and Swedish public procurement.

The prototype this application replaces fails AA today — body text at 9.5–11px
and status conveyed by colour alone. Both are fixed here, and both are held by
a test rather than by intention.

---

## 1. Automated coverage (CI-gated)

`test/a11y.test.ts` runs **axe-core** against the *running application in a real
browser*, signed in, across eight views: budget entry, consolidation, actuals,
variance, audit trail, data governance, cost centres and operations. Any
violation at `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`/`wcag22aa` fails the build.

A component snapshot would not catch a contrast failure or a control that loses
its accessible name once data arrives, which is why the audit runs against the
real DOM.

> **The CSP is exercised by this test as a side effect.** axe cannot be injected
> with `addScriptTag` — the policy refuses the inline script. It is evaluated
> through CDP instead, so the page under audit is the page as actually served,
> with its policy intact.

The same suite asserts, arithmetically rather than by eye:

- **Contrast** — every text token clears 4.5:1 on every surface it is used on,
  and text on an accent fill clears 4.5:1 in both themes.
- **Type scale** — the smallest token is ≥ `0.875rem` (14px). The floor is
  parsed out of `tokens.css`, so shrinking a token fails the test.

### Findings this has already produced

| Finding | Fix |
| --- | --- |
| Scrollable regions unreachable by keyboard (`scrollable-region-focusable`, serious) | `tabindex="0"` plus an inset focus ring on `.view` and `.table-scroll` |
| Light-theme accent `#0f9f76` is 3.4:1 on white — valid as a UI component, invalid as text | Added `--accent-text: #0b7a5a` (5.3:1) for accent-coloured text; the fill keeps the design's value |
| White on the light accent fill is also 3.4:1 | Both themes use the dark ink `#04231a` (5.0:1) on accent fills |

## 2. Design decisions that carry accessibility

- **Non-colour cues.** Every status chip carries a glyph as well as a hue
  (`✓ ◷ ✕ ·`), and every delta carries an arrow (`▲ ▼ =`). The glyph is
  `aria-hidden` because the adjacent label is the accessible name — it is there
  for a sighted user with a colour vision deficiency, not for a screen reader.
- **The grid is a real table** with `<caption>`, `scope="col"`,
  `scope="rowgroup"` category bands, and a visually hidden `<label>` per amount
  input, so a screen reader announces "Regional site visits, Q2, DKK" rather
  than an unlabelled box.
- **Charts are DOM, not canvas.** Bars are labelled rows with the value as text;
  the SVG is `aria-hidden`. Nothing is conveyed only by the picture.
- **Density recovered without shrinking text.** The prototype's compactness
  comes back through line-height and padding, not font size.
- **Skip link** to main content, because the sidebar precedes a long grid.
- **Visible focus everywhere** — one `:focus-visible` rule, never removed.
- **Reduced motion** respected; nothing animated is essential.

## 3. Manual screen-reader procedure (run before each release)

Automation catches roughly a third of WCAG. Run this by hand:

| # | Check | Pass criterion |
| --- | --- | --- |
| 1 | Tab from page load to the grid | Skip link appears first and works |
| 2 | Navigate the grid with a screen reader (NVDA on Windows, VoiceOver on macOS) | Row header, column header and currency are announced per cell |
| 3 | Open a line drawer with the keyboard | Focus moves into the drawer; `Escape` closes it and returns focus |
| 4 | Select lines and use the bulk bar | Checkboxes have distinct accessible names; the bar is announced as a region |
| 5 | Submit with a blocking validation error | The error is announced, not only shown |
| 6 | Switch to light theme and repeat 1–2 | No contrast regression |
| 7 | Zoom to 200% and to 400% reflow | No content lost; tables scroll within their own container |
| 8 | Windows High Contrast mode | Status glyphs still distinguish states |

## 4. Known limitations

- **No formal VPAT / EN 301 549 conformance statement.** Needed for Swedish
  public procurement if that becomes relevant.
- **Manual screen-reader testing has not yet been run** against a release by a
  person who uses one daily. Automated coverage plus the checklist above is not
  the same thing, and should not be described as if it were.
- **Strings are not externalised** (`NFR-010`), so there is no localised
  screen-reader experience yet. Formatting is locale-aware; the copy is not.
- **No user testing with assistive technology users.** The single highest-value
  next step, and worth more than another automated rule set.
