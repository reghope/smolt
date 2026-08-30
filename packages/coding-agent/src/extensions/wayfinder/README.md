# Wayfinder

Plan a chunk of work too big for one agent session as a shared map of decision tickets, then resolve them one session at a time until the way to the destination is clear.

This is a code-backed evolution of the wayfinder *skill* idea. A skill is prose: the model computes the frontier by hand, honours claims on trust, and wires blocking edges by convention. Here the mechanics live in code and only the judgment stays with the model:

| Concern | Skill | This module |
| --- | --- | --- |
| Frontier (open, unblocked, unclaimed) | model re-derives it each session | computed by the store on every call |
| Claims between concurrent sessions | honour system | session-id claims with a 24h freshness window; stale claims rejoin the frontier |
| Blocking edges | body convention | validated: targets must exist, cycles rejected |
| Decisions index | hand-maintained on the map issue | derived from closed tickets, cannot drift |
| One decision per session | prose rule | enforced by the tool (`override_session_limit` for explicit user override) |
| Research after a decision | fire-and-forget subagents (host-dependent) | automatic: once the run settles, the extension compacts the session (skipped while context is small) and sends a continuation turn that works the takeable research tickets — no user input needed |
| Map completion | judgment call | refused while open tickets or fog remain |
| Instructions | loaded wholesale | tool description always available; full doctrine loads only via `/wayfinder`; a few-line status block is injected only when a map is active |
| Tracker | external issue tracker required | markdown under `<project>/.smolt/wayfinder/`, shared through the repo like code |

## Storage

```
<project>/.smolt/wayfinder/<map-slug>/
  map.md              # frontmatter: title, status, fog, outOfScope; body: ## Destination, ## Notes
  tickets/<slug>.md   # frontmatter: type, status, blockedBy, claim, gist; body: ## Question, ## Resolution
```

Plain markdown, human-editable, git-mergeable. Every operation re-reads from disk (so concurrent sessions and `git pull` are picked up immediately) and writes atomically.

## Surfaces

- **`wayfinder` tool** — chart, view, add/update/claim/release/resolve/scope_out tickets, tend fog. Registered once, so it is live in the TUI and the desktop app alike (desktop drives the same CLI over RPC).
- **`/wayfinder` command** — argument completion offers `chart` and existing map slugs. No args: charts when no map exists, works the single active map, or asks which. Sends the mode's full doctrine as the turn prompt, so instructions cost context only when used.
- **System prompt** — when an active map exists, a compact status block (doctrine + per-map frontier counts) is injected at session start and frozen for prompt-cache stability. No maps, no cost.
- **Research auto-continuation** — resolving a ticket (or creating research tickets while charting) arms a flag; at `agent_settled`, if research is takeable, the extension compacts the transcript (the map on disk is the durable memory, so the interview is disposable) and sends the research turn itself. Decisions still hard-stop: only research, which needs nothing from the user, continues unattended. Skipped in headless modes and whenever the user has already queued a message.

## Files

- `store.ts` — `WayfinderStore` (pure, injectable root dir) and `wayfinderTool` dispatcher.
- `index.ts` — extension wiring: tool, command, prompt injection, per-session decision limit. `createWayfinderExtension(api, paths)` exists for tests; the default export resolves the project root.

Tests: `test/wayfinder-store.test.ts`, `test/wayfinder-extension.test.ts`.
