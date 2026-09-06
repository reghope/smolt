# Subagents

Background agent threads the model can start, watch, correct and stop.

The point of a subagent is that its context stays its own. A wide search or a self-contained build runs somewhere else, spends its own tokens, and hands back a summary — the parent never carries the transcript.

What makes these different from the fire-and-forget kind is that they are still there while they run.

| Concern | `examples/extensions/subagent` | This module |
| --- | --- | --- |
| Execution | one `smolt` process per task | a second `AgentSession` in this process |
| Startup | ~1s of process boot | milliseconds |
| While it runs | opaque; you wait | listed, readable, steerable, stoppable |
| Correcting it | restart with a better prompt | `send` queues, or `interrupt` cuts in |
| Parallelism | up to 4, all awaited together | any of them, none awaited |
| Getting the result | the tool call returns it | `wait`, or it announces itself at the next settle |
| Recursion | possible | impossible: children load no extensions, so they have no subagent tool |

## Threads

A thread has an id (`a1`) and a nickname (`amber`); both address it. Status is one of `starting`, `running`, `completed`, `errored`, `stopped`.

**A finished thread keeps its slot until it is closed.** That is deliberate: it means an unread result cannot be silently displaced by the next spawn. `close` frees the slot; `/subagents close done` clears all of them.

Threads never outlive their session — `session_shutdown` aborts and disposes every one.

## Model surface

One `subagent` tool with seven actions:

| Action | Effect |
| --- | --- |
| `spawn` (agent, task) | starts a thread, returns immediately with its id |
| `list` | agents available here, and every thread |
| `read` (id) | a running thread's transcript |
| `send` (id, text, interrupt?) | queue a correction, or cut into the current turn |
| `wait` (id, seconds?) | block until it finishes or the wait runs out |
| `stop` (id) | halt it where it is |
| `close` (id) | discard it and free the slot |

A thread that finishes while the parent is working announces itself in the parent's next turn, after the current one settles — cutting in mid-turn with an unrelated result is how a parent loses the thread of its own work.

Every thread's actions are measured (`core/action-metrics.ts`): tool executions and assistant turns become timed spans, and `list`/`read`/`/subagents` show the totals per thread — `42 actions (tool 63s, llm 41s)` — so a slow thread can be diagnosed as tool-bound or model-bound at a glance.

## Agent definitions

Markdown with frontmatter, the same shape as skills and prompts. Project (`.smolt/agents/*.md`) beats user (`~/.smolt/agent/agents/*.md`) beats built-in, so a repo can redefine `worker` for its own conventions without anyone editing their home directory.

```markdown
---
name: worker
description: Implements a scoped change end to end
model: anthropic/claude-sonnet-4-5   # optional; default is agents.defaultSubagentModel, else the parent's model
thinking: high                        # optional; default is agents.defaultSubagentThinking, else medium
tools: [read, write, edit, bash]      # optional; default is the built-in set
---

Everything below the frontmatter becomes this agent's instructions.
```

Three are built in so the feature works before anyone writes a definition:

- **default** — a general-purpose hand with the parent's tools.
- **explorer** — read, grep, find, ls, at low thinking. It cannot modify anything because it has no tool that could.
- **worker** — builds, and is told it is not alone in the codebase: stay in scope, do not reformat around the edges, do not revert changes it did not make.

## Settings

Under `agents` in `settings.json` (global and project are deep-merged):

```jsonc
{
  "agents": {
    "enabled": true,
    "maxConcurrentThreadsPerSession": 4,
    // What a thread runs on when its definition does not say. The model
    // defaults to the parent's; thinking defaults to medium rather than the
    // parent's level, which is often the user's ceiling for their own work
    // and had threads spending most of their budget thinking.
    "defaultSubagentModel": "anthropic/claude-sonnet-4-5",
    "defaultSubagentThinking": "medium",
    // Child sessions are temporary (in-memory) by default, so threads never
    // clog the session list or session search. Set true to write them to
    // disk like any other session.
    "persistChildSessions": false
  }
}
```

## What a thread spends

A thread runs on the same lean child loader as battletest's testers and research's investigators (`battletest/spawn.ts`, `battletest/lean.ts`): no extensions, no skills catalogue (its whole task is in the brief), every tool result capped at 10,000 tokens, old results shed in batches with the calls that produced them. The project's context files (AGENTS.md and kin) ride only on a thread that can edit — `worker`, `default`, anything with `edit` or `write` in its tools — because they are conventions for whoever changes the repository; an `explorer` never does. Measured on this repository, the full loader had put six thousand tokens of skills and conventions on every turn of every thread, against about twelve hundred now for an explorer. `read` shows the tail of a transcript (the last dozen entries), not the whole of it, since everything it returns sits in the parent's context for good.

## Surfaces

- `/subagents` — every thread and its state. `/subagents agents` lists definitions; `/subagents stop <id|all>`; `/subagents close <id|done>`.
- Footer shows running and finished counts; a widget lists the threads while any exist.

## Provenance

Ported from Codex's subagents, specced in `.smolt/wayfinder/subagents-extension/` (`codex-subagents-spec.md` and `execution-mechanism-decision.md`).

Deliberate differences from Codex, all recorded during the research:

- Codex has five model tools; this is one tool with actions, matching how `wayfinder` and `goal` are shaped here.
- Codex caps recursion with `max_depth`. Here children load no extensions, so depth is fixed at one by construction.
- Codex agents are TOML; these stay markdown-with-frontmatter, which is what the rest of Smolt uses.
- Codex's `interrupt_message` has no counterpart: steering writes a real message into the child's transcript, so the child already sees it.
- Codex surfaces approvals from background threads. Smolt has no interactive tool-approval layer — the per-agent tool list is the permission surface.

The older synchronous `examples/extensions/subagent` is left in place as an example of the child-process approach; it is not loaded.
