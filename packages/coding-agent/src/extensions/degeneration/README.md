# Degeneration guard

Watches the assistant's stream for repetition collapse — the same sentence
or fragment looping over and over, a failure mode of small models deep in
agentic contexts. On a trip it aborts the response mid-stream and retries
the identical request once (a fresh sample almost always escapes the
attractor); if the retry degenerates too, the run stops with a visible
`auto_retry_end` failure instead of streaming garbage until a human aborts.

- **detector.ts** — pure, conservative detection: ≥ `minRepeats` (default
  10) consecutive identical prose-like lines, a template loop (3x that many
  consecutive lines sharing one long stem with a varying slot — "…should do
  more Materials Science work." / "…Nanotechnology work."), or a periodic
  tail of exact fragment repetitions; short units, letterless dividers, and
  distinct code lines never count. Throttled to re-check every ~400
  streamed chars.
- **index.ts** — the policy: per-turn retry budget, once-per-response
  tripping, wired to core's `smolt.abortResponse(reason, {retry})`
  primitive (a deterministic abort + re-issue that bypasses the host's
  interactive abort handling; this extension is why the primitive exists).

Config: `~/.smolt/agent/degeneration.json` —
`{ "enabled": true, "maxRetries": 1, "minRepeats": 10 }`.

## Module boundary

Only the public extension surface (`on`, `abortResponse`) plus Node
built-ins. Its single type-only import of `ExtensionAPI` is the one line a
standalone install changes — copy the folder into
`~/.smolt/agent/extensions/` and it loads like any other extension.
In-tree it is registered as a built-in in `../index.ts`.

Tests: `test/degeneration-detector.test.ts` (detector, config, policy) and
`test/agent-session-degeneration.test.ts` (end-to-end against the faux
streaming provider — which ignores abort signals, proving the retry keys on
the guard's request rather than on `stopReason: "aborted"`).
