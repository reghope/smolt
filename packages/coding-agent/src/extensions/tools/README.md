# Tools

The built-in tools with leaner habits. Reading code efficiently turns out
to be less a matter of the read tool than of three things around it:

- **A token budget on every tool result**, applied at the boundary where
  the result enters history: 10,000 tokens by default, four bytes a token,
  keeping the first half and the last half and dropping the middle behind
  `…N tokens truncated…`. A `tool_result` hook over every tool, `budget.ts`.
- **Prompt lines**: prefer `rg`; no python to dump larger chunks of a file;
  parallelize reads; don't re-read after an edit; don't dump large output
  into the answer.
- **Optionally no read tool at all.** In shell mode the read tool is
  switched off and files are read with `sed -n`, `nl`, `cat` and `rg`; the
  one thing a shell cannot do — attach an image — keeps a tool, `view_image`.

In tool mode the read tool is the built-in with its guidance inverted (when
you already know which part of the file you need, only read that part);
everything it does is inherited. An optional first look — an unranged read
returns only the first N lines — measured well on a small model but is a
stricter cap than the default, so it is off unless configured.

Config: `~/.smolt/agent/tools.json` —
`{ "read": "tool" | "shell", "outputTokenLimit": 10000, "firstLookLines": null }`.

## Module boundary

- **budget.ts** — the truncation: `truncateMiddleByTokens`,
  `applyOutputBudget`.
- **read.ts** — the read definition, its guidance text, the optional first
  look, and the `images.autoResize` settings reader (core hands the built-in
  that setting; an extension has no settings handle, so this reads the same
  files, project over global).
- **index.ts** — config, `view_image`, the hooks, registration.

Known edges: in shell mode the default system prompt omits its skills
section (core lists skills only when a read tool is active). SDK hosts that
supply their own read operations are replaced by the local read while the
extension is on; switch it off in settings to keep theirs.

Tests: `test/tools-extension.test.ts`, `test/tools-budget.test.ts`.
