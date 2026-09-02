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
- **session_search** — search over all prior sessions, four shapes:
  discovery (adaptive hydration with bookends), scroll, read, browse. Tool
  results are indexed under role `tool`, reachable via `role_filter`.
  Lexical (FTS5, plain-scan fallback) fused with semantic when the
  semantic-recall extension is on, which it is by default. The two
  retrievers fail in opposite directions — FTS5
  quotes and ANDs every term, so *"reconnect flaky websocket"* returns
  nothing for a session that said *"ECONNRESET on the rpc client, added
  backoff"*, while vectors match the meaning and are vague about literals.
  Neither replaces the other, so both ranked lists are fused with
  Reciprocal Rank Fusion and a chunk found by both outranks one found by
  either. Every result carries `matched_by`: `fts`, `vector`, `both`, or
  `title`.
- **embeddings** (`embeddings.ts`, `semantic.ts`) — on by default. A small
  sentence-embedding model (`Xenova/bge-small-en-v1.5`, 384-wide, ~34 MB)
  runs in this process through transformers.js: the weights download once
  into `~/.smolt/agent/models` and no text leaves the machine. The library
  is never imported statically — this folder's boundary stays Node
  built-ins — but located at load, from `SMOLT_EMBEDDINGS_MODULE` (the
  desktop app names its own bundled copy to every agent it spawns) or the
  package installed beside smolt, and imported on first use. No module
  means no embedder, and search stays lexical. It is listed in settings as
  an extension of its own, `semantic-recall`, so the model can be switched
  off without losing memory, skills, or lexical search: the extension does
  no work in the session beyond building the embedder and handing it to the
  learning extension, which loads next. `/embeddings` reports what runs,
  whether the weights are on disk, how many vectors are stored, and how the
  last index run went. `~/.smolt/agent/embeddings.json` adjusts it:
  `{ "engine": "server", "baseUrl": "http://127.0.0.1:8080", "model":
  "bge-small", "apiKeyEnv": "" }` swaps in an OpenAI-compatible
  `/v1/embeddings` server (llama.cpp, Ollama, a hosted gateway; a file that
  names a `baseUrl` without an `engine` is read as this, so older configs
  keep working), and `minScore`, `modelsDir`, `modulePath`, `batchSize`,
  `backfillPerSession` tune the rest. A key is named by environment
  variable, never stored in the file. Vectors are returned unit-normalized,
  which makes cosine similarity a dot product downstream. `minScore` is
  model-specific: 0.55 for the default model (measured: unrelated messages
  score 0.35–0.55 against each other, related ones 0.64 and up), 0.25 for a
  server model until it is tuned — raise it if unrelated sessions surface,
  lower it if nothing does.
- **vectors** (`vectors.ts`) — vector storage in `state.db` under
  self-versioned `vec_*` tables with additive migrations. The session
  index migrates by drop-and-rebuild, which is free when rebuilding means
  re-running an FTS insert; rebuilding vectors means re-embedding every
  message, so a schema bump must never trigger it. SQLite is the container,
  not the search engine: the scan is a dot product over one contiguous
  Float32Array, built once per process, and the cost that shows up first is
  deserializing BLOBs rather than the arithmetic. A changed model id — or a
  changed vector width under the same id — discards the index, because
  vectors from two models are not comparable. Backfill runs detached at
  session start, is incremental per file and per message (content-hashed),
  caps itself per session so a first run cannot stall a start, and prunes
  vectors for session files that no longer exist. A file whose size and
  mtime match its last complete run is skipped without being read. Only
  `user` and `assistant` messages are embedded; tool output is most of the
  volume and little of the meaning, and FTS5 still indexes it. A message
  longer than the model's window (about 1800 characters) becomes several
  chunks, cut at paragraph, line, or sentence boundaries and capped at
  eight per message, stored and replaced as one set; a hit deep inside a
  long reply carries its own snippet, and two chunks of one message count
  as one result.
  A search returns nothing below `minScore` rather than the nearest
  neighbour: full-text search returns nothing when nothing matches, but a
  nearest-neighbour search always has a nearest neighbour, and without a
  floor rank fusion would treat that as a real hit.
- **hindsight** — observed (measured, not self-reported) learning about
  tool usage. Every tool call is recorded with duration and outcome,
  failures are normalized into error classes, and retries are linked to
  the failure they retried. Nonzero exits that are a command's normal
  answer (grep finding nothing, diff finding differences) are recorded as
  the successes they are rather than polluting the exit-nonzero class, and
  every stored argument is redacted first — rows reach the system prompt,
  so credentials must never reach a row. Two read paths: a "Tool field
  notes" block (recurring failure patterns with real counts) folded into
  the frozen prompt block at session start, and a reactive remedy hint
  appended to a failing tool result the moment a known error class with an
  established fix recurs (at most once per tool+class per session). Both
  aggregate machine-caused classes (ebusy, eacces, network, missing
  binaries) across every project and everything else within the current
  cwd, and both quote observed durations when advising on a timeout. Rows
  live in
  `state.db` but in self-versioned `hindsight_*` tables with additive
  migrations — the session index's drop-and-rebuild never touches them,
  which also means `state.db` is no longer safe to delete casually: it
  holds source-of-truth telemetry and expensive-to-rebuild vectors
  alongside the rebuildable index. Config
  via `~/.smolt/agent/hindsight.json`: `{ "enabled": true,
  "notesBudgetChars": 1200, "minSamples": 5 }`. `hindsight.ts` is also a
  complete standalone extension (default export) when copied out alone.
- **skill attribution** — loading a skill is a `read` of a `SKILL.md`, so
  hindsight already records it. Keyed by basename, every skill on the
  machine collapsed into one bucket; keyed by directory (`battletest/
  SKILL.md`) it becomes the one measured signal of whether an authored
  skill was ever worth reading. `/skills` pairs the skills on disk against
  those counts and names the ones nothing has ever loaded. Human-facing on
  purpose: retiring a skill is destructive, and "idle for a while" is not
  evidence enough to hand an agent a reason to delete its own work — a
  skill for a rare task can be right and idle.
- A periodic nudge (every 8 turns) reminds the model to persist anything
  durable.

## Module boundary

This folder only uses the public extension surface (`session_start` /
`turn_start` / `turn_end` / `session_shutdown` / `before_agent_start` events,
`registerTool`, and `registerCommand`) plus `typebox`, `yaml`, and Node
built-ins — including global `fetch`, which is how the embedding client
reaches a server without pulling in `@smolt/ai`, and a computed import of
transformers.js for the local engine, which is optional at runtime. Its single type-only import of
`ExtensionAPI` is the one line a standalone install changes — copy the
folder into `~/.smolt/agent/extensions/` (or any extensions dir), point the
type import at `smolt`, and it loads like any other
extension. In-tree it is registered as a built-in in
`../index.ts`.

Tests live in `test/learning-*.test.ts` (memory, skills, sessions,
hindsight, vectors, and extension wiring). The vector tests use a loopback
HTTP server for the embedding client and a concept-keyword fake embedder for
hybrid search, so nothing reaches an external network.
