# Dense UI supplement

The vendored doctrine is written for marketing surfaces, and its Section 13 rules dashboards, admin panels, data tables and dense product UI **out of scope**. This supplement overrides that: dense product UI is in scope, and the pre-flight gate applies to it.

Read the whole doctrine first. Where it and this supplement disagree, this wins for dense surfaces only. Marketing pages keep the doctrine unchanged.

## What carries over unchanged

These are not marketing rules; they are rules about not looking generated. They apply everywhere:

- Zero em-dashes in rendered text.
- One theme for the whole surface. No section flips to inverted mid-page.
- One accent, one radius system, one type scale, used identically throughout.
- No AI tells: Inter-by-default, the violet-to-indigo gradient, three equal cards, Jane Doe, Acme.
- Contrast that passes WCAG AA, in both themes.
- Motion that can be justified in one sentence, and is wrapped for reduced motion.
- Real content over placeholder decoration.

## What changes

**Density is the point, not a failure.** The doctrine's instinct — more whitespace, fewer elements, cards omitted in favour of spacing — is correct for a landing page and wrong for a console. A dashboard exists so someone can see a lot at once. Judge it by how much a reader can take in without scrolling or clicking, not by how calm the screenshot looks.

**Information hierarchy replaces narrative hierarchy.** A landing page leads a reader down a story. A dense surface is read by scanning: the eye lands on the anomaly. So:

- The most decision-relevant number is the largest thing on screen.
- Everything at the same level of importance is the same size, weight and colour. Two numbers that matter equally must not compete.
- Colour carries state — good, warning, bad, inert — and nothing else. A colour used decoratively in a dashboard makes every genuine state signal weaker.

**Repetition is correct here.** The doctrine's zigzag cap and layout-repetition rule exist because a marketing page that repeats bores. A table of twenty rows that all look identical is doing its job. Consistency in a dense surface is a feature; do not break rhythm for variety.

**Chrome is a cost.** Every border, shadow, panel and card is space taken from the data and one more thing to look at. Prefer alignment and spacing to boxes. When a border is doing real work — separating two genuinely different regions — keep it; when it is outlining something already obvious, remove it.

## Additions to the pre-flight check

Run these alongside the doctrine's Section 14 matrix when the surface is dense product UI:

- [ ] **Scan target**: the number or state a reader opens this screen to find is the most prominent thing on it.
- [ ] **Equal things look equal**: no two peers differ in size, weight or colour without a reason you can state.
- [ ] **Colour means state**: every non-neutral colour on the surface maps to a defined state. No decorative accent.
- [ ] **Chrome audit**: every border, card and shadow separates two things that are genuinely different. Anything else is deleted.
- [ ] **Density honest**: the screen shows what a reader needs at once; nothing important is a click away that could have been on screen.
- [ ] **Empty, loading, error, and partial** states exist for every region that fetches.
- [ ] **Table discipline**: numeric columns right-aligned and tabular-figured; no `border-t` + `border-b` on every row; sort and filter state visible without opening a menu.
- [ ] **Long lists**: a virtualised or paged component past ~50 rows, not a growing DOM.
- [ ] **Keyboard**: every action reachable without a pointer, with a visible focus ring that passes contrast in both themes.
- [ ] **Truncation**: no data silently clipped. Either it wraps, or it truncates with the full value available.
- [ ] **Time and units** labelled: no bare number whose unit or period a reader has to infer.
- [ ] **Refresh legible**: if the data is live, when it last updated is on screen.

## Where this leaves Section 13

Data tables, admin panels and dense product UI are in scope. The doctrine's other exclusions still stand: code editors, native mobile, and realtime collaboration UIs are different problem classes, and this supplement does not pretend otherwise.
