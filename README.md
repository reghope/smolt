<p align="center">
  <img alt="smolt logo" src="assets/smolt.svg" width="112">
</p>

# Smolt

Smolt is a fork of the [Pi agent harness](https://github.com/earendil-works/pi) — a minimal, self-extensible coding agent. The CLI is `smolt`, config lives in `~/.smolt/`, and everything else works the way Pi does.

> A *smolt* is a young salmon at the stage where it adapts to new water and leaves the river it was born in.

Upstream is by Mario Zechner and the Pi contributors, MIT licensed. This fork keeps that license and that credit; see [Pi's documentation](https://pi.dev/docs/latest) for anything not covered here, or just ask the agent to explain itself.

## Packages

| Package | Description |
|---------|-------------|
| **[coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[agent](packages/agent)** | Agent runtime with tool calling and state management |
| **[ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[tui](packages/tui)** | Terminal UI library with differential rendering |
| **[telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, typed schemas |
| **[desktop](packages/desktop)** | Minimalist desktop app (Electron + TypeScript) over the agent's RPC mode |

## Self-learning

Smolt keeps what it learns. Three built-in tools close the loop:

- **memory** — two files under `~/.smolt/memories/` are injected into the system prompt, frozen at session start so the prompt prefix stays cache-stable: `MEMORY.md` (environment facts, project conventions, tool quirks, learned techniques, ~800 tokens) and `USER.md` (who you are and how you like to work, ~500 tokens). Entries are §-delimited; the agent curates them itself with add/replace/remove, or a batch `operations` array applied atomically against the final char budget (so one call can prune stale entries and add new ones together). Writes are guarded against external drift and unreadable files, and mid-session edits appear next session.
- **skill_manage** — when the agent works out a non-trivial procedure, recovers from dead ends to a working path, or gets corrected, it records a skill (`SKILL.md` with YAML frontmatter and *When to Use / Procedure / Pitfalls / Verification* sections, description ≤60 chars) under `~/.smolt/agent/skills/`, with supporting files in `references/`, `templates/`, `scripts/`, or `assets/`. Skills load on demand via the normal progressive-disclosure skill system.
- **session_search** — full-text search (SQLite FTS5, plain-scan fallback) across all prior sessions with four calling shapes: *discovery* (query → deduped sessions, top result fully hydrated with bookends and a ±5 message window), *scroll* (anchored ±N window inside a session), *read* (whole session, bounded for large ones), and *browse* (recent sessions). Every shape returns actual messages, not summaries.

A periodic nudge reminds the agent to persist anything durable it learned during long sessions.

## Permissions & Containerization

Smolt has no built-in permission system for restricting filesystem, process, network, or credential access. It runs with the permissions of the user and process that launched it.

For stronger boundaries, containerize or sandbox it. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `smolt` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole process in a local container for simple isolation.
- **OpenShell**: run the whole process in a policy-controlled sandbox.

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh             # Run tests (skips LLM-dependent tests without API keys)
./smolt-test.sh       # Run smolt from sources (can be run from any directory)
```

To use the local build as your `smolt` command:

```bash
npm link --workspace packages/coding-agent
```

## Supply-chain hardening

Inherited from upstream, and worth keeping:

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- CI installs with `npm ci --ignore-scripts`, and a scheduled workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT — see [LICENSE](LICENSE). Copyright remains with the original Pi authors for the inherited code.
