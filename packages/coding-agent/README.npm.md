<p align="center">
  <a href="https://github.com/reghope/smolt">
    <img alt="smolt logo" src="https://raw.githubusercontent.com/reghope/smolt/main/assets/smolt.svg" width="112">
  </a>
</p>

<h1 align="center">smolt</h1>

<p align="center"><em>The coding agent that keeps what it learns.</em></p>

---

smolt is a minimal terminal coding agent with one addition that compounds: it remembers. Curated memory, self-authored skills, and full-text recall over every past session — so Tuesday's dead end never costs you Thursday.

## Install

```bash
npm install -g --ignore-scripts @smolt/cli
```

## Use

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or run /login inside smolt
smolt
```

Bring any of 15+ providers — Anthropic, OpenAI, Google, and friends — and switch models mid-session with `/model`. Local models work too, via the built-in llama.cpp integration (`/llama`).

## Commands

Type `/` in the editor. The essentials:

| Command | What it does |
|---------|--------------|
| `/login` | Authenticate a provider (subscription or API key) |
| `/model` | Switch models mid-session (Ctrl+S saves a default) |
| `/thinking` | Adjust the thinking level |
| `/resume` | Pick up a previous session |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Branch a new session from an earlier message |
| `/compact` | Compress context, optionally with custom instructions |
| `/share` | Upload the session as a private gist with a viewable link |
| `/export` | Save the session to HTML or JSONL |
| `/settings` | Themes, message delivery, preferences |
| `/hotkeys` | Every keyboard shortcut |

Skills appear as `/skill:name`, prompt templates as `/templatename`, and extensions can register their own commands. `!command` runs a shell command and feeds the output to the model; `@` fuzzy-searches project files.

## How the self-learning works

Three tools the agent uses on its own, nudged every few turns to persist anything durable:

- **memory** — two plain-text files under `~/.smolt/memories/`: `MEMORY.md` for project facts and quirks, `USER.md` for how you like to work. Both are injected at session start as a frozen snapshot, so they never churn your prompt cache. A hard character budget forces curation — the agent adds, rewrites, and prunes entries instead of hoarding them.
- **skill_manage** — when the agent solves something gnarly, it can write the working path down as a real skill (`SKILL.md` plus supporting files) in the standard skills directory. Next session it discovers and follows its own instructions like any hand-written skill.
- **session_search** — full-text search (SQLite FTS5) across everything it has ever done in your projects, including command output. It can find "that error we hit last month", scroll the surrounding conversation, and read the fix.

Why this is good: agents normally start every session at zero. smolt's knowledge compounds instead — the model stops re-deriving your build quirks, re-hitting known dead ends, and re-asking how you like things done. And because memory is just two Markdown files, you can open them, read exactly what the agent believes, and edit or delete anything. No vector database, no embeddings, no cloud — it all lives in your home directory.

## Lightweight and modular

- **~2 MB unpacked, one dependency** (an image-processing native module). No install scripts, no telemetry, no phone-home.
- **Four core tools** — `read`, `write`, `edit`, `bash` — and a deliberately minimal system prompt. Everything else is layered on top.
- **Extensions all the way down.** Skills, prompt templates, themes, and custom tools are plug-in pieces; the self-learning module is itself just an extension built on the public extension API — you could lift the folder out or swap in your own.
- **Four modes**: interactive TUI, print (one-shot scripting), RPC, and an SDK for embedding.

Full documentation lives in the [GitHub repository](https://github.com/reghope/smolt).

---

MIT

<p align="center"><em>A young salmon at the stage where it adapts to new water.</em></p>
