# Battletest

Send a team of simulated users through the app and get back what real users would have found: bugs, UI inconsistencies, UX friction, performance complaints, and wording that reads wrong — as tickets, plus a synthesized report.

Project-agnostic by design: a web app gets browsed, a desktop/Electron app gets driven over CDP, a CLI or TUI gets its binary run and its commands worked through, and a library gets tested the way its user tests it — as a developer following the quickstart and judging install friction, time to first success, and how the errors read. Testers use whatever the project offers.

`/battletest <count> [focus]` deals `count` personas and spawns each as its own background agent session (the same in-process `AgentSession` mechanism as the subagents module). Each tester drives the app through its own **`browse` tool** — a private headless Chrome/Edge on its own port and profile, driven over raw CDP (`cdp.ts`, dependency-free: global fetch + Node 22 WebSocket), locked to the persona's viewport. One browse call is one user action (`goto`/`click`/`type`/`press`/`scroll`/`eval`/`viewport`), and every action returns a viewport-sized JPEG screenshot inline plus the page URL/title and console errors — so acting and seeing are the same call, and no tester wastes its budget hand-building a browser harness. A URL in the focus is resolved once and injected into every brief (test the deployed site, launch nothing); otherwise testers work out the launch from the repo. Everything happens **in character**, with a running diary and a ticket filed the moment a problem is hit. When the last tester finishes, the parent session dedupes the tickets and writes the report.

## Personas

Non-deterministic by design — two runs never field quite the same team, the way a real user base is never the same twice:

- **Archetypes are dealt without replacement**, so a run of N testers covers N distinct angles: first-timer, power-user, skimmer, auditor, accessibility-advocate, performance-hawk, wordsmith, chaos-monkey, everyday-regular, skeptic.
- **Traits are rolled per tester** on top: patience (low/medium/high), expertise (novice/comfortable/expert), temperament (forgiving/blunt/exacting), thoroughness (skims/balanced/exhaustive).
- **Viewports are dealt in a fixed cycle** (desktop, mobile, desktop, tablet), so any run of two or more testers includes a phone-sized screen and any run of four or more a tablet. Mobile testers emulate 375x812 with touch and judge everything at that size; tablet testers work at 768x1024; desktop testers still narrow the window at least once mid-session.

The persona shapes what a tester tries, how long it persists, how it phrases findings — and travels with every note and ticket, so the report can say *who* felt what.

Testers run with `edit` excluded and standing orders never to touch source: they are users, and users cannot fix the app. `write` stays available for scratch CDP driver scripts inside their own profile directory.

Tester sessions are full `AgentSession`s, so the normal context rules apply unchanged: threshold auto-compaction between legs and overflow recovery (compact + retry) mid-run, per the user's `compaction` settings — a marathon tester cannot run itself out of context. They are also **temporary chats**: in-memory, never written to the session directory, so a run leaves the desktop sidebar, `/resume`, and session search exactly as it found it — the ChatGPT temporary-chat model, where the transcript is scratch and the artifact (diaries, tickets, report) is what persists. `agents.persistChildSessions: true` in settings.json restores persistent child sessions.

Testers are also under a standing safety doctrine, self-judged so an unattended run never stops to ask a human: no purchases or payment details, no real accounts or credentials, nothing submitted that reaches a real person or service, and nothing destructive — no deleting or corrupting data the app manages, even where the UI offers it. A tester walks a risky flow to its last safe step (the checkout it never places, the delete dialog it never confirms), records what it saw there, and moves on.

`/battletest` with no count doesn't guess a team size: it hands the decision to the supervising agent, which scouts the project for a minute and starts 1-3 testers — a **balanced generalist** who goes over everything (enough for most projects), plus up to two **specialists** aimed wherever this project concentrates its risk, each defined by a short focus phrase. An explicit count (`/battletest 5`) still deals that many archetypes from the deck.

When a run finishes, `performance.json` in the run folder records how each tester did — severity-weighted ticket score, actions, tokens, wall clock, and the full brief they ran under — and names the top performer; `form.jsonl` at the battletest root accumulates one compact line per tester per run. That's the raw material for picking future teams on track record rather than at random.

Runs are kept fast without blunting them: testers run at **low thinking** by default (measured: the model's deliberation was ~70% of a long run's wall clock; a per-run model/thinking override still wins). Each brief carries a **coverage plan** (a short breadth pass, then a deep dive on that tester's slice of the app's areas, so ten testers don't re-test the same front page) and an **action budget** scaled to the thoroughness trait (~40/70/110 browse actions) with a novelty stop rule — and the budget is enforced: a tester 20% past it gets an automatic supervisor steer to file and finish. Briefs also ban long sleeps (poll in ≤5s beats) and encourage chaining quick shell commands into one call. Tester shell calls carry a hard default timeout (three minutes), so one hung command costs minutes rather than the rest of the run. The parent triages incrementally between waits — marking duplicates as they land so synthesis is mostly done before the last tester finishes — and can send stragglers a `wrap_up` steer (tool action, or automatic judgment late in a run) telling them to file what they have and close out.

For the gray zone there is a **clearance loop**: a tester unsure whether an action crosses the line calls `testlog` action `clearance` (the exact action plus the risk) and its session pauses; the parent's `wait` returns early with the request, the supervising agent rules with action `decide` (allow/deny plus one line of guidance, denying when in doubt), and the tester obeys the ruling. The outright-forbidden list is never escalated — always denied. An unanswered request denies itself after a timeout (default 5 minutes), and if the parent goes idle with a request pending, an `agent_settled` nudge pulls it back — so no human is ever prompted and no tester ever hangs.

## Storage

```
<project>/.smolt/battletest/<run-slug>/
  run.md                  # frontmatter: title, status, personas; body: ## Focus
  notes/<persona>.md      # append-only diary, one per tester, in their voice
  tickets/<slug>.md       # frontmatter: title, persona, severity, category, area, status
                          # body: ## What happened, ## Expected, ## Steps to reproduce
  report.md               # synthesized after the run
  metrics/<persona>.jsonl # every timed action as it happened (tool spans + model thinking)
  metrics/<persona>.summary.json  # totals: actions, tool vs llm time, per-tool, slowest spans
```

Tester scratch (browser user-data, driver files) lives under `<os-tmp>/smolt-battletest/<run>/<persona>/`, never inside the project: browser profiles are tens of thousands of files and gigabytes of cache, which in-repo got scanned by git surfaces, synced by cloud folders, and once ballooned the desktop app to 9GB. The OS owns cleaning its temp dir.

Every tester action is measured (`core/action-metrics.ts`): each tool execution and each assistant turn becomes a timed span, streamed to the run's metrics JSONL as it happens and frozen into a summary when the tester finishes. The wait roster and synthesis read them, and the report carries a **Run performance** section naming the bottlenecks — which tool ate the run, whether tools or the model dominated, and the pathological outliers.

Plain markdown, human-editable, git-mergeable — the same tracker shape as wayfinder, so anyone who can read one can read the other. Severities: `blocker`, `major`, `minor`, `polish`. Categories: `bug`, `ui`, `ux`, `performance`, `copy`, `accessibility`, `other`. Ticket statuses: `open`, `fixed`, `wont-fix`, `duplicate` (with `duplicateOf`).

## Surfaces

- **`/battletest` command** — `<count> [focus]` starts a run (1–25 testers, default 3); `status`, `stop`, and `report [run]` manage it. Starting a run sends the parent a kickoff turn: hold with the tool's `wait` action until every tester finishes, then synthesize.
- **`battletest` tool** (parent session) — `list`, `view`, `view_ticket`, `add_ticket`, `update_ticket`, `write_report`, `wait`. Later sessions use the same tool to triage and to mark tickets `fixed` as they land.
- **`testlog` tool** (tester sessions only, injected via `customTools`) — `note` appends to that tester's diary; `ticket` files a problem; `append` adds observations to another tester's ticket. Bound to its run and persona, so attribution cannot drift. One problem is one ticket across the whole team: a filing that reads like an existing ticket (same area, mostly the same title words) is bounced with the original's slug and orders to stand down — the tester appends anything new to the original (`## Also seen` section) and moves to uncovered territory, rather than burning budget re-proving a known bug. `force: true` files anyway when it really is a different problem.
- **Settle safety net** — if the kickoff turn is interrupted and the run finishes while the parent idles, the extension sends the synthesis prompt itself at `agent_settled` (same shape as wayfinder's research continuation). Skipped in headless modes and when the user has queued a message.
- **Footer/widget** — `battletest: 2/4 testing, 7 tickets` plus a per-tester line while a run exists.

## Files

- `personas.ts` — archetype deck, trait pools, `generatePersonas(count, rng)` (rng injectable for tests).
- `store.ts` — `BattleTestStore` (pure, injectable root) and the `battleTestTool` dispatcher.
- `cdp.ts` — the headless-browser driver behind the `browse` tool: launch (Chrome, then Edge), navigation, input dispatch, viewport emulation, JPEG screenshots, console-error capture. `BrowseDriverFactory` is the injectable seam.
- `index.ts` — wiring: command, all three tools (`battletest`, `testlog`, `browse`), the tester spawner (injectable, same pattern as subagents), settle continuation. `createBattleTestExtension(api, paths, spawner?, browseFactory?)` exists for tests.

Tests: `test/battletest-store.test.ts`, `test/battletest-extension.test.ts`.
