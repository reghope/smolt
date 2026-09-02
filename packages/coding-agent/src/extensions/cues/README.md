# Cues

House notes that enter the prompt only when their subject comes up.

Standing guidance in the system prompt is paid for on every request of every
session, including the ones that never touch its subject. A cue is the same
note with a condition on it: "a new web app defaults to Vite with React
Router" is worth saying to somebody starting a web app and worth nothing to
everybody else.

## How a cue arms

Every user message is matched against the cue table. A cue arms when:

- one of its `trigger` phrases appears, **and**
- one of its `with` phrases appears too, when it has any, **and**
- none of its `unless` phrases appear.

`unless` is the important half. It is how a cue stays out of a conversation
that has already settled the question it exists to answer — the web-stack cue
does not arm on "build a web app with Next.js", nor on a prompt that names
Vite, because in both the answer is already given.

Phrases match whole words, so `spa` does not fire on "space invaders".

Once armed, a cue stays armed for the session: the web app is still being
built three turns later.

## Writing one

Drop a markdown file in `~/.smolt/agent/cues/`. The file name is the cue's id,
and a file replaces a built-in of the same name.

```markdown
---
summary: Which test runner this house uses
trigger: [test, tests, spec]
with: [write, add, new]
unless: [jest, mocha]
---
## Tests
New test files go under `test/` and run with vitest.
```

A cue with no trigger, or no note under the frontmatter, is dropped rather
than half-run: a cue without a trigger is standing context in disguise, which
is the thing this module exists to avoid.

`/cues` lists every cue with its source and whether it is armed yet.

The directory is read once per session, so a cue added mid-session belongs to
the next one — the same way memory and skills behave.

## The cost worth knowing

An armed cue changes the system prompt, which invalidates the cached prefix
for the rest of the session. Triggers are therefore written to fire on the
message that opens a subject rather than on a passing mention of it much
later; a cue that arms on turn twenty pays a full re-read to save a few
hundred tokens, which is a bad trade.

## Module boundary

Only the public extension surface (`on` / `registerCommand` / `sendMessage`)
plus `yaml` and Node built-ins. Its single type-only import of `ExtensionAPI`
is the one line a standalone install changes — copy the folder into
`~/.smolt/agent/extensions/`, point the type import at `smolt`, and it loads
like any other extension.

Tests live in `test/cues.test.ts`.
