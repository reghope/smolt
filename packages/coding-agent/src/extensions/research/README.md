# Research

Send a team of investigators after a subject and get back the answer, with the evidence: findings graded by confidence and carrying their sources, a map of the questions the subject decomposed into, and a synthesized report that leads with the answer.

`/research <subject>` is built on the same foundation as `/battletest` and looks and behaves the same way: a run, a live roster in the footer and widget, background agent sessions with their own browsers and diaries, a supervising parent that waits the run out, triages as it goes, rules on clearance requests, and synthesizes at the end. Where a tester files tickets, a researcher files **findings**; where battletest's cross-run ledger remembers problems, research keeps a **question map** — the part of wayfinder worth keeping.

## What a researcher does

Each researcher is told to stop at nothing short of the answer, and given a ladder to climb when a route is blocked:

1. **`search`** (DuckDuckGo, then Bing, through their HTML front-ends; no API key) to find where things live.
2. **`fetch`** the raw page as a crawler sees it — as readable text, raw HTML, pretty JSON, the page's links, the script bundles it loads (then fetch those and read the code), or just the headers. A blocked response is flagged, not swallowed.
3. **`browse`**: a private headless Chrome/Edge on its own port and profile, driven over raw CDP (`battletest/cdp.ts`). Beyond battletest's user actions it can read the rendered **`text`** and live **`html`** of a page, list its **`links`**, and — the network sleuth's tool — report every **`network`** request the page has made (method, URL, status, type), which is how the API behind a UI is reconstructed. Every navigation returns a screenshot.
4. **`browse` action `relaunch` with `headed: true`**: when a site refuses the headless browser (a bot check keyed on the headless build), the researcher restarts it as a **visible window** on the same profile and carries on. The headless launch also drops the `HeadlessChrome` token from the user agent, which is what the simplest checks key on. Nothing solves or bypasses a CAPTCHA, ever — a wall like that is recorded as a dead end and the ladder goes *around* it.
5. **The shell**: `curl` with browser headers, `git clone` of public repositories into the researcher's scratch directory, downloaded and unpacked packages, grepping bundles, following `//# sourceMappingURL` to a source map's `sourcesContent`, `web.archive.org` for old versions, running code to reproduce and measure.
6. **Cross-checking**: a claim in a blog post is `unverified` until the code, the traffic, or an independent source agrees; disagreeing sources become a `contradiction` finding.

A lead is exhausted only when the diary says why, and a route that could not be taken is a `dead-end` finding, so the supervisor can send someone else down it.

## Angles

Non-deterministic like battletest's personas: **angles are dealt without replacement** — source-diver, observer, network-sleuth, documentarian, historian, community-listener, comparator, verifier, experimenter, cartographer — and **traits are rolled per researcher**: tenacity (dogged / relentless / obsessive, which also sets the action budget: ~70 / 100 / 140), rigor (accepting / careful / forensic: how much proof a finding needs), and scope (narrow / balanced / wide).

`/research <subject>` with no count hands team selection to the supervising agent, which scouts the subject for a minute and **picks one to three angles from the deck for that subject** — a site's mechanism gets an observer, a network-sleuth and a source-diver; a technology gets a documentarian, a source-diver and an experimenter; a market gets a documentarian, a community-listener and a comparator; contested claims earn a verifier — each optionally narrowed with a focus (`network-sleuth: the checkout flow`), and optionally seeding the question map with up to six sharp sub-questions. There is no generic generalist seat: every researcher is an angle chosen for a reason. `/research 3 researchers into <subject>` deals three angles from the deck. `using <provider> <model>` puts every researcher on a named model, exactly as battletest parses it.

Researchers run at **medium thinking** by default (a per-run override wins): unlike clicking through screens, deciding what to chase and what counts as proof is judgment, and low thinking gave up early. They run with `edit` excluded and standing orders never to touch the project; everything they clone or build lives under `<os-tmp>/smolt-research/<run>/<researcher>/`.

## The question map

Kept from wayfinder, with the bookkeeping in code and the judgment with the model:

- **Questions** are sharp sub-questions whose answers would settle part of the subject; vague hunches are **fog** on the run.
- **Blocking edges** are validated (targets must exist, cycles are rejected).
- **Claims**: a researcher claims a question before working it; a fresh claim by someone else means "take another" (claims go stale after two hours).
- **The frontier** — open, unblocked, unclaimed — is computed by the store on every call, never tracked by hand.
- **Answers** carry the substance and the URLs that back it, plus a one-line gist for the report's index; answering reports what it just unblocked. A question no legitimate route can reach is closed as a `dead-end` with the record of what was tried.

## Waves — how a run stops at nothing

When every researcher has finished, the supervisor judges the map. If takeable questions remain, it dispatches **the next wave** (`research` action `continue`, with angles picked for the open questions and dead ends) instead of writing a partial report, up to four waves per run; a fresh team, dealt afresh, primed with the settled answers and the open frontier. The report is written when the map is settled, when what remains is out of scope or a wall no legitimate route gets around, or when the wave limit is reached — and it says which.

A new run on a related subject is handed the reports of earlier runs in its briefs, so the team builds on what the project already learned rather than re-confirming it.

## Findings

One finding per distinct thing learned, with **confidence** (`confirmed`: seen directly, or two independent primary sources; `likely`; `unverified`; `contradicted`), **kind** (`fact`, `mechanism`, `source`, `observation`, `lead`, `dead-end`, `contradiction`), a **topic**, the **evidence quoted**, and its **sources**. A filing without sources is accepted but warned about: a finding without sources is an opinion. As in battletest, one thing is one finding across the whole team — a filing that reads like an existing one (same topic, mostly the same title words) is bounced with the original's slug and the researcher appends what is new (`## Also seen`) and moves on. Finding statuses: `open`, `verified`, `refuted`, `duplicate`.

## Safety

The same self-judged doctrine as battletest, aimed at research: no logins, accounts, credentials, or payments; no solving, bypassing, or automating past CAPTCHAs, bot checks, paywalls, or authentication; nothing submitted that reaches a real person; no collecting personal information about individuals; nothing destructive or disruptive, including load that could hurt a site (one request at a time to a host, back off on rate limits). Reading what a site serves any visitor, in a visible browser if it insists on one, is research. Gray-zone actions go through the same **clearance loop**: the researcher pauses, the supervisor rules with action `decide` (deny when in doubt), an unanswered request denies itself after five minutes.

## Storage

```
<project>/.smolt/research/<run-slug>/
  run.md                    # frontmatter: title, status, wave, fog, researchers; body: ## Subject, ## Notes
  notes/<researcher>.md     # append-only diary, one per researcher, in their voice
  findings/<slug>.md        # frontmatter: title, researcher, confidence, kind, topic, status, sources, question
                            # body: ## What we found, ## Evidence, ## Sources, ## Also seen
  questions/<slug>.md       # frontmatter: title, status, blockedBy, claimedBy, askedBy, gist, answeredBy
                            # body: ## Question, ## Answer
  report.md                 # synthesized after the run: ## Answer first
  metrics/<researcher>.jsonl (+ .summary.json)
  performance.json          # every researcher's score, spend, and brief; the wave's best
<project>/.smolt/research/form.jsonl   # one compact line per researcher per run
```

## Surfaces

- **`/research` command** — `<subject>` plans a team and starts a run; `<count> researchers [using model] into <subject>` deals that many; `status`, `stop`, `resume [run]`, `continue [run]`, `report [run]`, `list`.
- **`research` tool** (parent session) — `list`, `view`, `view_finding`, `view_question`, `add_finding`, `update_finding`, `add_question`, `update_question`, `answer`, `update_run`, `write_report`, `wait`, `decide`, `wrap_up`, `start`, `continue`, `resume`.
- **`notebook` tool** (researcher sessions only) — `note`, `finding`, `append`, `question`, `claim`, `release`, `answer`, `clearance`. Bound to its run and researcher, so attribution cannot drift.
- **`browse`, `fetch`, `search` tools** (researcher sessions only).
- **Settle safety net** — a finished wave that the kickoff turn did not synthesize is picked up at `agent_settled`, and a pending clearance pulls an idle parent back.
- **No system-prompt block** — deliberately. Research runs are one-off questions, and announcing the latest one to every fresh session once had a Telegram chat greet the user with another chat's subject. Earlier runs are reachable on request (`list`, `view`), and a new run on a related subject gets their reports in its briefs.
- **Footer/widget** — `research: 2/3 researching, 7 findings, 3/8 questions` plus a per-researcher line; the desktop expands a line's `N findings` into the list, exactly as it does battletest's tickets.

## Files

- `angles.ts` — angle deck, trait pools, `generateResearchers(count, rng)`, `generateResearchTeam(picks, rng)`, `parseAnglePick("network-sleuth: the checkout flow")`.
- `store.ts` — `ResearchStore` (pure, injectable root) and the `researchTool` dispatcher: runs, diaries, findings, the question map, performance, reports.
- `web.ts` — dependency-free `fetchPage` (text/html/json/links/scripts/headers), bot-wall detection, `webSearch` with the DuckDuckGo and Bing parsers; `fetchImpl` injectable.
- `index.ts` — wiring: command, the four researcher tools, the parent tool, waves, settle continuation. `createResearchExtension(api, paths, spawner?, browseFactory?, fetchImpl?, labeler?)` exists for tests.
- Shared with battletest: `battletest/spawn.ts` (the child-session spawner), `battletest/cdp.ts` (the browser driver, with `headed`, `userAgent`, and `captureNetwork` options), `battletest/parse.ts` (invocation and model-override parsing).

Tests: `test/research-store.test.ts`, `test/research-web.test.ts`, `test/research-extension.test.ts`.
