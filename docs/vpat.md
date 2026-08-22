# Accessibility conformance report (VPAT 2.5 / EN 301 549)

Product: **Spendifre** — Birgma / Biltema Group IT budget platform
Standards evaluated: **WCAG 2.2 Level A and AA**, **EN 301 549 v3.2.1**
Report date: **2026-08-16** · Version evaluated: `claude/file-review-8a42qx`

> **This is a self-assessment, and that limits what it is worth.** Every claim
> below is backed by an automated check running in CI against a real browser, by
> arithmetic over the palette, or by reading the code. **No assistive-technology
> user has tested this product, and no external accessibility audit has been
> carried out.** Automated testing catches roughly a third of WCAG issues; the
> criteria most likely to be wrong here are the ones marked *Supports (not
> independently verified)* in §3, and they are exactly the ones a screen-reader
> user would find in an afternoon.
>
> A VPAT that overstates conformance is worse than no VPAT, because a procurement
> team relies on it. This one is written to be checkable.

> **Reading the accessibility tree is not the same as testing with a screen
> reader, and this report does not claim it is.** What was added this revision
> is a gate that asks the browser for the tree a screen reader consumes and
> asserts the properties that make a page navigable — every region and control
> announces a name, one `h1` and one `main` per view, no skipped heading level,
> and focus that moves into an overlay and returns when it closes. It found
> four things nothing else had: twenty-five scroll regions announcing "group"
> and nothing more; a line drawer whose focus call had never once executed, so
> the panel opened silently and left the user in the table behind it; nine
> empty `<th>` elements announcing a blank column header above every cell
> beneath them; and five table captions still in English.
>
> None of that is a substitute for a screen-reader user. It is the distance
> between "axe passes" and "navigable", which turned out to be four defects
> wide — and the criteria below marked *not independently verified* are still
> not independently verified.

> **One finding from this revision, because it says what a self-assessment
> misses.** Nine accessible names were hardcoded English in a six-locale
> product — the grid's select-all and per-row checkboxes, the line drawer and
> its close button, the audit search placeholder, the logo. A sighted Swedish
> user never encountered them; a Swedish screen-reader user heard every one.
> Neither existing gate could see it: axe checks that an accessible name
> *exists*, not what language it is in, and the catalogue test matched text
> between tags. They are now catalogue keys in all six locales, and a third
> gate asserts that no `aria-label`, `title` or `placeholder` in the client is
> a literal. The point is not the fix — it is that this was invisible to
> everything automated for as long as it existed.

## 1. Evaluation methods

| Method | Coverage | Where |
| --- | --- | --- |
| axe-core, WCAG 2.2 A/AA rule set, in Chromium against the running application | All 16 views, each signed in as the role that sees it | `test/a11y.test.ts`, CI-gated |
| Contrast computed arithmetically over both palettes | Every foreground/background token pair | `test/a11y.test.ts` |
| Type-scale floor parsed from the CSS tokens | Every declared size | `test/a11y.test.ts` |
| Accessible names asserted to come from the string catalogue | Every `aria-label`, `title` and `placeholder` in the client | `test/client.test.ts` |
| **Accessibility tree read from the browser** — region and control names, heading outline, landmark count | 13 views with tables | `test/screenreader.test.ts` |
| **Focus management** — where focus goes when the line drawer opens, and where it returns | The one overlay in the product | `test/screenreader.test.ts` |
| axe `best-practice` rule set, reported separately from the conformance gate | Landing view | `test/screenreader.test.ts` |
| Keyboard walkthrough | Manual, per release | [`accessibility.md`](./accessibility.md) §3 |
| Screen reader (NVDA / VoiceOver) | **Not performed** | — |
| Assistive-technology user testing | **Not performed** | — |

The axe run injects the library through `page.evaluate` rather than
`addScriptTag`, because an injected inline `<script>` is refused by the
application's CSP. That matters for the validity of this report: the audit
measures the page **as it is actually served**, not a page with the policy
relaxed to make testing convenient.

## 2. Conformance summary

| Standard | Conformance level |
| --- | --- |
| WCAG 2.2 Level A | **Supports**, with the caveat in §4 |
| WCAG 2.2 Level AA | **Supports**, with the caveat in §4 |
| EN 301 549 Chapter 9 (Web) | **Supports** |
| EN 301 549 Chapter 11 (Software) | Not applicable — web application |
| EN 301 549 Chapter 12 (Documentation) | **Partially supports** — see §5 |
| Section 508 | Not evaluated. No US procurement in scope |

## 3. WCAG 2.2 criteria

Terms are the ITI VPAT ones: *Supports*, *Partially supports*, *Does not
support*, *Not applicable*.

### 3.1 Perceivable

| Criterion | Level | Conformance | Evidence |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | Supports | Nav glyphs and chart bars are `aria-hidden`; the adjacent text carries the meaning. The brand mark has `role="img"` and a label |
| 1.2.x Time-based Media | A/AA | Not applicable | No audio or video |
| 1.3.1 Info and Relationships | A | Supports | Real `<table>` with `<caption>`, `scope` on every header, `<fieldset>`/`<legend>` on grouped controls, every input labelled. axe-verified |
| 1.3.2 Meaningful Sequence | A | Supports | DOM order is reading order; no CSS reordering |
| 1.3.3 Sensory Characteristics | A | Supports | No instruction depends on shape or position |
| 1.3.4 Orientation | AA | Supports | No orientation lock |
| 1.3.5 Identify Input Purpose | AA | Not applicable | No field collects information about the user |
| 1.4.1 Use of Color | A | Supports | Every status colour carries a glyph (`✓ ◷ ✕ ·`); the allocations padlock marks read-only figures |
| 1.4.3 Contrast (Minimum) | AA | Supports | Computed over both palettes and asserted in CI, not sampled by eye |
| 1.4.4 Resize Text | AA | Supports | `rem` throughout; no `maximum-scale` |
| 1.4.5 Images of Text | AA | Supports | No text in images. Charts are SVG rectangles with real text beside them |
| 1.4.10 Reflow | AA | Supports | Tables scroll inside their own container; the page body does not scroll horizontally |
| 1.4.11 Non-text Contrast | AA | Supports | Asserted for UI component boundaries and the chart fill at 3:1 |
| 1.4.12 Text Spacing | AA | Supports | No fixed line-height or letter-spacing that would clip |
| 1.4.13 Content on Hover or Focus | AA | Supports | No hover-triggered content. The line drawer opens on activation and is dismissible |

### 3.2 Operable

| Criterion | Level | Conformance | Evidence |
| --- | --- | --- | --- |
| 2.1.1 Keyboard | A | Supports (not independently verified) | Every control is a native `button`, `a`, `input` or `select`. Scroll regions carry `tabIndex={0}` — added because axe's `scrollable-region-focusable` caught that a keyboard user could not scroll the grid at all |
| 2.1.2 No Keyboard Trap | A | Supports (not independently verified) | No focus management beyond the drawer, which closes on its own control |
| 2.1.4 Character Key Shortcuts | A | Not applicable | No single-character shortcuts |
| 2.2.1 Timing Adjustable | A | Partially supports | The session expires on a fixed idle timeout (ZT-004) and cannot be extended in place. Security requirement in tension with this criterion; §4 |
| 2.2.2 Pause, Stop, Hide | A | Not applicable | Nothing moves or auto-updates |
| 2.4.1 Bypass Blocks | A | Supports | Skip link to `#main-content` |
| 2.4.2 Page Titled | A | Supports | Static title; the view heading is an `<h1>` per view |
| 2.4.3 Focus Order | A | Supports (not independently verified) | DOM order; no `tabindex` above 0 |
| 2.4.4 Link Purpose (In Context) | A | Supports | Links are self-describing |
| 2.4.5 Multiple Ways | AA | Partially supports | One navigation, no search across views. Defensible for a nine-item application; stated rather than claimed |
| 2.4.6 Headings and Labels | AA | Supports | Each view has one `<h1>`; panels use `<h2>` |
| 2.4.7 Focus Visible | AA | Supports | Explicit focus ring; inset on scroll regions so it is not clipped |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Supports | The drawer sits beside the grid rather than over it — it was originally below, which was a layout defect, not an accessibility one, but the fix serves both |
| 2.5.1 Pointer Gestures | A | Not applicable | No path or multipoint gestures |
| 2.5.2 Pointer Cancellation | A | Supports | Native controls; activation on up-event |
| 2.5.3 Label in Name | A | Supports | Visible text is the accessible name |
| 2.5.4 Motion Actuation | A | Not applicable | No motion actuation |
| 2.5.7 Dragging Movements | AA | Not applicable | Nothing is drag-operated. Stage reordering is a whole-list submission, not a drag |
| 2.5.8 Target Size (Minimum) | AA | Supports | No control below 24×24 CSS pixels |

### 3.3 Understandable

| Criterion | Level | Conformance | Evidence |
| --- | --- | --- | --- |
| 3.1.1 Language of Page | A | Supports | `<html lang="en">` |
| 3.1.2 Language of Parts | AA | Not applicable | Single language. When the catalogue gains a locale this becomes applicable and `lang` must follow the catalogue |
| 3.2.1 On Focus | A | Supports | Focus changes nothing |
| 3.2.2 On Input | A | Supports | Selecting an entity or a breakdown mode changes the region below it, which is the expected result of that control, and focus is not moved |
| 3.2.3 Consistent Navigation | AA | Supports | One sidebar, same order, per role |
| 3.2.4 Consistent Identification | AA | Supports | Same component, same label, throughout |
| 3.2.6 Consistent Help | A | Partially supports | No persistent help mechanism. The user guide is external to the application |
| 3.3.1 Error Identification | A | Supports | Errors render in a banner with an `✕` glyph; field-level detail arrives in the `fields` map |
| 3.3.2 Labels or Instructions | A | Supports | Every input labelled; table captions explain the figures |
| 3.3.3 Error Suggestion | AA | Supports | Validation violations name the rule and the affected line count |
| 3.3.4 Error Prevention (Legal, Financial) | AA | Supports | Submission is blocked server-side by validation rules; approval is reversible only by an audited exception, which is the intended friction |
| 3.3.7 Redundant Entry | A | Supports | Nothing is asked twice |
| 3.3.8 Accessible Authentication (Minimum) | AA | Supports | Authentication is delegated to Entra ID. **The conformance of the sign-in step is Microsoft's**, not this product's, and a procurement team should ask for it separately |

### 3.4 Robust

| Criterion | Level | Conformance | Evidence |
| --- | --- | --- | --- |
| 4.1.2 Name, Role, Value | A | Supports | Native elements throughout; `aria-pressed` on toggles, `aria-current` on the active nav item and plotted series |
| 4.1.3 Status Messages | AA | Supports | Every banner is a live region: `role="alert"` for errors, `role="status"` for informational and warning banners. Asserted in `test/client.test.ts`, because axe cannot catch this — a `<p>` with no role is valid markup |

## 4. Known non-conformances and caveats

Three, stated plainly. A fourth — 4.1.3, banners that were not announced — was
found while writing this report and fixed; it is listed as Supports above with
the test that now holds it there.

1. **No assistive-technology testing.** The largest gap in this report. Every
   "Supports (not independently verified)" row above is a code-reading claim.
   Commission a screen-reader audit before relying on this document externally.
2. **2.2.1 Timing Adjustable.** The idle session timeout cannot be extended from
   within the page. This is a deliberate security control (ZT-004) in genuine
   tension with the criterion. The mitigation available — a warning before
   expiry with an option to re-authenticate — is not implemented.
3. **2.4.5 Multiple Ways / 3.2.6 Consistent Help.** No in-application search and
   no in-application help. Both are defensible at this size and both are
   choices, not oversights.

## 5. EN 301 549 Chapter 12 (documentation and support)

| Clause | Conformance | Note |
| --- | --- | --- |
| 12.1.1 Accessibility and compatibility features | Partially supports | This report and [`accessibility.md`](./accessibility.md) describe them; they are not yet part of user-facing documentation |
| 12.1.2 Accessible documentation | Supports | The user guide is HTML and Markdown, both screen-reader accessible |
| 12.2.2 Information on accessibility and compatibility features | Partially supports | The user guide does not yet have an accessibility section |
| 12.2.3 Effective communication | **[org]** | Depends on the support channel the organisation provides |
| 12.2.4 Accessible documentation | Supports | As 12.1.2 |

## 6. Feedback

**[org]** *An accessibility statement must give users a way to report a barrier
and a commitment to respond. Record the contact address and the response time
here before this report is published or supplied to a procurement process.*
