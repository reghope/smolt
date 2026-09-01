# Self-learning module

A self-contained extension giving the agent durable memory across sessions:

- **memory** — curated `MEMORY.md` / `USER.md` under `~/.smolt/memories/`,
  injected into the system prompt as a frozen snapshot at session start
  (prefix-cache stable). §-delimited entries, add/replace/remove plus an
  atomic batch `operations` shape checked against the final char budget,
  external-drift and unreadable-file guards, per-turn consolidation cap.
- **skill_manage** — agent-authored skills (`SKILL.md` + supporting files)
  written into the normal skills directory, picked up by standard skill
  discovery. Frontmatter validation, size limits, path and delete safety.
- **session_search** — FTS5 full-text search over all prior sessions
  (plain-scan fallback), four shapes: discovery (adaptive hydration with
  bookends), scroll, read, browse. Tool results are indexed under role
  `tool`, reachable via `role_filter`.
- **hindsight** — observed (measured, not self-reported) learning about
  tool usage. Every tool call is recorded with duration and outcome,
  failures are normalized into error classes, and retries are linked to
  the failure they retried. Two read paths: a "Tool field notes" block
  (recurring failure patterns with real counts) folded into the frozen
  prompt block at session start, and a reactive remedy hint appended to a
  failing tool result the moment a known error class with an established
  fix recurs (at most once per tool+class per session). Rows live in
  `state.db` but in self-versioned `hindsight_*` tables with additive
  migrations — the session index's drop-and-rebuild never touches them,
  which also means `state.db` is no longer safe to delete casually: it now
  holds source-of-truth telemetry alongside the rebuildable index. Config
  via `~/.smolt/agent/hindsight.json`: `{ "enabled": true,
  "notesBudgetChars": 1200, "minSamples": 5 }`. `hindsight.ts` is also a
  complete standalone extension (default export) when copied out alone.
- A periodic nudge (every 8 turns) reminds the model to persist anything
  durable.

## Module boundary

This folder only uses the public extension surface (`session_start` /
`turn_start` / `turn_end` / `before_agent_start` events and `registerTool`)
plus `typebox`, `yaml`, and Node built-ins. Its single type-only import of
`ExtensionAPI` is the one line a standalone install changes — copy the
folder into `~/.smolt/agent/extensions/` (or any extensions dir), point the
type import at `smolt`, and it loads like any other
extension. In-tree it is registered as a built-in in
`../index.ts`.

Tests live in `test/learning-*.test.ts` (memory, skills, sessions,
hindsight, and extension wiring).
