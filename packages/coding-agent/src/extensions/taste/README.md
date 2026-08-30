# Taste

Design doctrine that arrives on its own, and a finish it can refuse.

A skill is passive. It waits to be invoked, and the turn that most needed it is the turn nobody thought to invoke it on. This does two things a skill cannot:

- **It arms itself.** Any prompt that reads as design work puts the whole doctrine into the system prompt for the rest of the session.
- **It holds a gate.** A session that wrote files which render, and never reviewed them, does not get to end quietly. The agent is sent back with the checklist.

| Concern | Skill | This module |
| --- | --- | --- |
| Getting invoked | user remembers | heuristic lexicon on the raw input, plus any attached image |
| Staying in force | re-invoked per turn, or forgotten | sticky for the session, so a logic turn mid-design does not drop it |
| Amount served | whatever fits | always whole; slicing the doctrine is what damages results |
| Being applied at the end | a checklist the model may skip | a follow-up turn the model cannot skip |
| Checklist honesty | self-reported | mechanical rules computed from the files; a pass verdict cannot override a mechanical failure |
| Browser-dependent checks | claimed | recorded as SKIP with a reason, never as PASS |
| Dashboards | out of scope (upstream Section 13) | in scope, via the dense-UI supplement |

## What the gate actually knows

The review splits the doctrine's Section 14 matrix three ways, and is explicit about which is which.

**Computed, not trusted** — read from the file's own text, and enough on their own to fail a review:

| id | Rule |
| --- | --- |
| `em-dash` | zero em-dashes in rendered text (Section 9.G) |
| `viewport-stability` | `min-h-[100dvh]`, never `h-screen` |
| `scroll-listener` | no `window.addEventListener("scroll")` |
| `ai-tells` | no Jane Doe, Acme, Lorem ipsum, "Quietly in use at" |
| `default-serif` | not Fraunces or Instrument Serif |
| `scroll-cue` | no "Scroll to explore" |
| `section-numbering` | no `00 / INDEX` eyebrows |
| `ai-purple` | no default violet-to-indigo gradient |
| `eyebrow-density` | at most one eyebrow per three `<section>` |

Comment-only lines are exempt from the copy rules: doctrine is about what renders.

**Left to the model, with evidence required** — everything else in Section 14 plus the dense-UI additions. The gate prompt states that a claim without evidence is a FAIL.

**Skipped, and said so** — horizontal overflow at 390/1280, WCAG AA contrast, and hero-fits-viewport. These need a rendered page, and this repo carries no browser. They are returned as explicit skips with the reason, so nothing is silently marked passed.

## The loop

1. A design prompt arms the doctrine.
2. Writes to files that render are tracked — `write`, `edit`, and a best-effort scan of `bash`/`powershell` for redirects and `sed -i`.
3. On settle with files pending, the gate sends a `[taste gate]` follow-up naming them.
4. `taste_review` returns the mechanical results, the browser skips, and the instruction to work the checklist.
5. `taste_review` with a verdict passes only if the verdict is `pass` **and** no mechanical check failed.
6. Writing to a file after a pass re-arms it. A passing review is not a session-wide licence.

The gate re-sends at most twice per pending set. Past that it stops pushing and leaves a persistent widget plus one error notice — a user who deliberately wants to ship unreviewed is not trapped in a loop.

## Surfaces

- `/taste` — status. `/taste on` · `/taste off` (session only, never writes config) · `/taste review` (ignores the bite cap; a person asked) · `/taste reset`.
- Footer reads `taste: armed`; a widget appears only when files are pending.
- Config, read at `session_start`, project overriding global:

```jsonc
// .smolt/taste.json  (or ~/.smolt/agent/taste.json)
{
  "enabled": true,
  "extraGlobs": ["src/tokens/*.ts"],   // project files that count as UI
  "checklistWaivers": ["eyebrow-density"]
}
```

## Provenance

`doctrine/taste-skill.md` is vendored verbatim from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), file `skills/taste-skill/SKILL.md`, pinned at commit `3c7017d636c3a4aad378433ea6d0cfa6c921da4a` (2026-05-26). MIT licensed, Copyright (c) 2026 Leonxlnx; the licence text is kept alongside it as `doctrine/LICENSE.taste-skill`.

It is vendored rather than fetched so behaviour is deterministic and offline, and kept as a file rather than a TypeScript string so an upstream update is a clean diff.

`doctrine/dense-ui.md` is this project's own supplement. Upstream Section 13 rules dashboards and dense product UI out of scope; the supplement puts them back in, says which marketing instincts to drop for them (density is the point; repetition is correct; chrome is a cost), and adds twelve checklist items of its own.

Design decisions behind all of this are recorded in `.smolt/wayfinder/taste-extension/`.
