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

Tests live in `test/learning-*.test.ts` (memory, skills, sessions, and
extension wiring — 130 tests).
