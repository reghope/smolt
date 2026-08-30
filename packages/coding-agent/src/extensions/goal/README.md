# Goal

One standing objective the session keeps working toward on its own, until it is met, blocked, out of budget, or paused.

An ordinary turn ends when the model decides it has said enough. A goal moves that decision out of the model's hands: the objective is held by the harness, every settled turn is asked whether the objective is met, and if it is not, the session continues by itself.

The failure mode this guards against is not the model forgetting the objective. It is the model quietly shrinking it — declaring a narrower thing done and stopping. Most of what the extension does is make that harder.

| Concern | Left to the model | Here |
| --- | --- | --- |
| Carrying the objective across turns | re-read from conversation history, decays with compaction | held by the harness, re-stated verbatim in every continuation |
| Deciding the work is finished | asserted | must survive a requirement-by-requirement audit against the working tree before `update complete` is accepted |
| Declaring an impasse | asserted | refused until the same obstacle has held for three consecutive turns |
| Knowing when to stop | none | token budget, charged per turn, flips the goal to `budget_limited` |
| Spinning | none | a continuation that calls no tool suppresses the next one |
| Pause / resume / budget | — | the user's, and unreachable from the tool |

## Statuses

`active` is the only one that continues on its own.

| Status | Reached by | Leaves by |
| --- | --- | --- |
| `active` | creating a goal, `/goal resume`, raising a spent budget | any of the below |
| `complete` | the model, after the completion audit | nothing; set another goal |
| `blocked` | the model, after three consecutive turns at the same wall | `/goal resume`, which restarts the audit |
| `budget_limited` | a charge that reaches the ceiling | `/goal budget <n>` with headroom, or `/goal budget none` |
| `paused` | `/goal pause` | `/goal resume` |
| `usage_limited` | provider usage limits | `/goal resume` |

## Accounting

A turn costs `(input − cacheRead) + output`. Cached input is free to the caller, so it is free to the goal. Reasoning tokens are inside `output` and do count — thinking hard toward the objective still spends the budget on it.

A spent budget gets exactly one closing turn, which is told to summarise where the goal got to and explicitly told that a spent budget is not a finish.

## Surfaces

- `/goal <objective>` — set it, and start work immediately. On a live goal this edits the objective in place and tells the running session it has changed.
- `/goal` — status: objective, state, tokens spent and left, seconds.
- `/goal pause` · `/goal resume` · `/goal clear` · `/goal budget <tokens>|none`
- Footer status while a goal exists; a widget only for the states that need a decision from the user.
- The `goal` tool — `get`, `create`, `update` — is the model's surface. It cannot pause, resume, or set limits.

## Storage

The goal is appended to the session file as a `goal-state` custom entry on every change. Custom entries do not participate in LLM context, so the goal survives a reload or a resume without ever being re-read as conversation. Because state is restored by replaying entries along the current branch, rewinding the conversation rewinds the goal with it.

## Interaction with wayfinder

Both extensions continue a settled session on their own. `goal` is registered first, so when a goal is active its continuation is queued before wayfinder's handler runs, and wayfinder's `hasPendingMessages()` guard stands it down. With no active goal, wayfinder behaves exactly as before.

## Provenance

Ported from the semantics of Codex's `codex-rs/ext/goal`, studied and recorded in `.smolt/wayfinder/goal-extension/`. Two behaviours are deliberate approximations rather than copies:

- Codex pauses a goal when the user presses Esc, which is wired through its TUI. Here an aborted run simply leaves the goal active; `/goal pause` is the explicit control.
- Codex injects budget and objective-change notices mid-turn. Smolt has no mid-run steering hook, so both are delivered as the next turn instead.
