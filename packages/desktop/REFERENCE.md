# Claude Code Desktop: a feature map, and where Smolt stands

A complete inventory of the reference application — every surface, menu, and
option — with, for each, what `@smolt/desktop` now does and what it
deliberately does not. Written as a working spec: the "Smolt" lines are the
honest state of this package, not aspirations.

Sources: the official desktop reference and its Desktop-specific pages
(quickstart, scheduled tasks, iOS simulator, WSL, Linux), read in full.

---

## 1. Application shell

| Element | Reference | Smolt |
| --- | --- | --- |
| Tabs | **Chat**, **Cowork**, **Code** | Single surface, equivalent to Code |
| Platforms | macOS (universal), Windows x64 + ARM64, Linux beta (apt/deb) | Electron; developed and verified on Windows |
| Requirement | Pro/Max/Team/Enterprise subscription; Git required on Windows | Any provider key or subscription the agent supports |
| Install | Signed installers; Linux via Anthropic apt repo | Built from the workspace |

**Chat** is conversation without file access. **Cowork** runs longer agentic
work in a sandboxed VM (QEMU/KVM on Linux, needing hardware virtualisation,
`/dev/kvm` group membership and `vhost_vsock`). **Code** is the coding surface
and the only one mapped in depth below.

*Smolt*: no tab switcher. Its side chat (below) covers the "ask without
touching the main thread" case that Chat serves; Cowork has no counterpart.

---

## 2. Starting a session

Four things are configured before the first message:

1. **Environment** — Local, Cloud, an SSH connection, or (Windows) a WSL
   distribution.
2. **Project folder** — the working directory; cloud sessions may add multiple
   repositories, each with its own branch selector.
3. **Model** — from the dropdown beside send; changeable mid-session.
4. **Permission mode** — from the mode selector; changeable mid-session.

*Smolt*: local only, one folder (the process cwd), model and mode both
switchable mid-session from the composer.

### Environments in detail

- **Local** — runs on the machine. The app does not inherit a full shell
  environment: on macOS it reads the shell profile for `PATH` and a fixed set
  of variables; on Windows it inherits user/system variables but not
  PowerShell profiles. A **local environment editor** (environment dropdown →
  hover Local → gear) stores encrypted variables applied to every local
  session and preview server.
- **Cloud** — Anthropic-managed infrastructure; continues with the app closed;
  monitorable from claude.ai/code and mobile. Custom cloud environments carry
  their own network access levels and variables.
- **SSH** — remote Linux/macOS machine. Dialog fields: **Name**, **SSH Host**,
  **SSH Port** (default 22), **Identity File**. Claude Code is installed on the
  remote automatically on first connect. Supports permission modes, connectors,
  plugins, MCP.
- **WSL** — session runs inside a WSL 2 distribution with Linux paths. Trust is
  granted per distribution *and* folder. Not available: integrated terminal,
  connectors, plugins, session forking, file browser, `@` file suggestions.

*Smolt*: local only. Cloud, SSH and WSL are absent — each is an execution
backend rather than a UI feature, and would need its own transport.

---

## 3. The prompt box

| Feature | Reference | Smolt |
| --- | --- | --- |
| Send / newline | Enter / Shift+Enter | Same |
| Interrupt | Stop button | Stop button, Esc |
| Steering | Type mid-run; read after the current action | Queued-message banner showing count, text, and a discard control |
| `+` menu | Attachments, skills, connectors, plugins | Attachments and slash commands |
| `@mention` | Filename autocomplete (not in cloud/WSL) | Not built |
| Attachments | Images, PDFs; drag-and-drop | Images: paste, drag-and-drop, file picker, thumbnails |
| Slash commands | `/` opens built-ins, skills, templates, plugin skills | `/` opens whatever the agent reports |
| Dictation | Present (absent on Linux) | Records and transcribes; device picker; hold-to-record |

---

## 4. Permission modes

The reference ladder, with settings keys:

| Mode | Key | Behaviour |
| --- | --- | --- |
| Manual | `default` | Asks before editing files or running commands |
| Accept edits | `acceptEdits` | Auto-accepts edits and common filesystem commands; asks for other commands |
| Plan | `plan` | Explores and proposes; no source edits |
| Auto | `auto` | Runs everything with background safety classifiers |
| Bypass permissions | `bypassPermissions` | No prompts at all; equivalent to `--dangerously-skip-permissions` |

A mode chosen in the selector is remembered per folder and beats
`permissions.defaultMode`, except Plan which is session-only. Cloud sessions
support Accept edits, Plan and Auto. `dontAsk` is CLI-only. Admins can remove
Auto (`disableAutoMode`) or Bypass
(`permissions.disableBypassPermissionsMode`).

*Smolt*: **all five implemented and enforced on the `tool_call` event** —
Manual, Accept edits, Auto, Bypass, Plan. Because Smolt has no classifier,
Auto was given a real check of its own: it stops before commands that cannot be
undone (recursive force deletes, force pushes, hard resets, `git clean`,
`mkfs`, `dd` to a device, dropping a database object, fork bombs, `chmod 777`
on a root path, piping a download to a shell, shutdown, and Windows
equivalents) and asks; Bypass skips even that. Modes that ask use a
request/reply file pair between the agent process and the window; an
unanswered request refuses after five minutes rather than hanging. A
destructive call cannot be answered "always allow", and its card is drawn in
the error colour naming the reason.

---

## 5. Panes and layout

Reference panes: **chat, diff, browser, terminal, file, plan, tasks,
subagent**, plus the **iOS Simulator** on macOS. Panes are dragged by their
header to reposition, dragged by an edge to resize, closed with `Cmd/Ctrl+\`,
and opened from the **Views** menu.

*Smolt*: chat, changes (diff), terminal, and side chat. Changes and side chat
share a right-hand rail, stacking to half-height each when both are open.
Panes are toggled from title-bar icons rather than dragged; there is no
free-form layout.

### 5.1 Browser pane

- Starts a dev server and opens the app; works for frontend and backend.
- **Auto-verify**: after each edit Claude screenshots, inspects the DOM, clicks,
  fills forms and fixes what it finds. On by default; disabled per project with
  `"autoVerify": false` or from the server dropdown.
- Opens static HTML, PDFs, images and video from the project.
- Server dropdown: start/stop servers, **Persist sessions** (keeps cookies and
  local storage across restarts), edit configuration, stop all.
- Tabbed external browsing (`Cmd/Ctrl+Shift+B`). Uses a clean profile with none
  of your logins — the Chrome extension is the tool for acting as you.
- Safety: classifiers review write actions on external pages in every mode; a
  domain allowlist applies outside Auto and Bypass. First action on a site
  prompts **Allow once / Always allow / Deny**, per site including subdomains.
  Never purchases, creates accounts, or solves CAPTCHAs.
- Admin controls: `browserExternalPageTools: "disabled"` removes Claude's tools
  on external pages; `disableBrowserExternalNavigation: true` blocks external
  navigation entirely (localhost previews unaffected).

*Smolt*: not built. This is the largest single gap and the most substantial
piece of remaining work — it needs an embedded browser view, a server
supervisor, and a tool surface for the agent to drive the page.

### 5.2 Diff view

Change indicator (`+12 -1`) opens a file list with per-file diffs. Clicking a
line opens a comment box; `Cmd/Ctrl+Enter` submits all comments at once and
Claude revises. **Review code** asks Claude to review its own diff, leaving
inline comments — scoped to compile errors, definite logic errors, security
issues and obvious bugs, explicitly not style or lint.

*Smolt*: changes pane lists files with per-file hunks, colourised, plus a
composer bar showing project, branch and `+n −m` with a way straight in. Line
comments and Review code are not built.

### 5.3 Terminal

Opens in the session's working directory sharing the agent's environment;
`Ctrl+\``; multiple tabs; "Open in terminal" from a folder's context menu.
Local sessions only.

*Smolt*: terminal pane runs commands in the session directory with a stop
control.

### 5.4 File pane

Click a path to open; spot-edit and **Save**; warns and offers override or
discard if the file changed on disk; click the header path to copy it.
Right-click any path anywhere for **Attach as context**, **Open in** (VS Code,
Cursor, Zed), **Show in Finder/Explorer**, **Copy path**.

*Smolt*: not built; files are opened by asking the agent.

### 5.5 Tasks and subagent panes

Tasks lists background work in the session — subagents, background shells,
dynamic workflows — and each entry opens its output or can be stopped.

*Smolt*: not built.

### 5.6 iOS Simulator (macOS)

Opens automatically when Claude builds, installs, launches or checks an app.
Requires Xcode 26.x (27 unsupported — it replaces Simulator with Device Hub).
Drives the simulator directly, so it needs neither computer use nor screen
permissions. Interactive: tap and swipe, hardware shortcuts (`Cmd+Shift+H`,
`Cmd+L`, volume), rotate (`Cmd+→`), device menu, screenshot (`Cmd+S`) and
recording (`Cmd+R`) saved to the Desktop, **Attach/Detach simulator**, and a
stream row tuning frame rate, resolution, encoding and an FPS readout. One
device per session, up to four panes; devices Claude booted are shut down when
the app quits, the session is archived, or ten minutes after detaching.
Consent is per device, once, covering control and screenshots; opening a URL
and building follow the session's permission mode. Disabled by
`disableMobileSimulatorTools` or `requireCoworkFullVmSandbox`.

*Smolt*: not built (macOS-only feature).

---

## 6. View modes and shortcuts

**Transcript view**: Normal (tool calls collapsed into summaries), Verbose
(every call and intermediate step), Summary (final responses and changes only).
`Ctrl+O` cycles.

*Smolt*: consecutive tool calls fold into one summary line — the call's own
description when it has one, otherwise "Used 5 tools" / "Ran a command, used 2
tools" — expanding to individual calls. `Ctrl+O` expands or collapses all tool
output. There is no three-way mode switch.

Reference shortcuts (macOS; Ctrl on Windows):

`Cmd+/` shortcuts · `Cmd+N` new session · `Cmd+W` close · `Ctrl+Tab` /
`Ctrl+Shift+Tab` cycle sessions · `Cmd+Shift+]` / `[` cycle · `Esc` stop ·
`Cmd+Shift+D` diff · `Cmd+Shift+B` browser · `Cmd+Shift+S` select element ·
`` Ctrl+` `` terminal · `Cmd+\` close pane · `Cmd+;` side chat · `Ctrl+O` view
modes · `Cmd+Shift+M` mode menu · `Cmd+Shift+I` model menu · `Cmd+Shift+E`
effort menu · `1`–`9` select in an open menu.

*Smolt* implements: `Ctrl+/`, `Ctrl+N`, `Ctrl+Tab`/`Ctrl+Shift+Tab`, `Esc`,
`Ctrl+Shift+D`, `` Ctrl+` ``, `Ctrl+;`, `Ctrl+O`, `Ctrl+Shift+M`,
`Ctrl+Shift+I`, `Ctrl+Shift+E`, `1`–`9`, plus its own `Ctrl+B` (sidebar),
`Ctrl+K` (search sessions), `Ctrl+M` (dictate), `Ctrl+,` (settings), and
`↑`/`↓` prompt history.

**Usage ring** beside the model picker shows context usage for the session and
plan usage for the period.

*Smolt*: token counts in the composer; a usage card on the home screen.

---

## 7. Sessions

- **Parallel sessions** from the sidebar; `Cmd/Ctrl+N`. Each git session gets
  its own **worktree**, stored under `<project>/.claude/worktrees/` with a
  configurable location and branch prefix; `.worktreeinclude` copies gitignored
  files such as `.env` into new worktrees.
- **Split view**: `Cmd/Ctrl`-click a session to open a second pane.
- Sidebar **filters** by status, project and environment, and **groups** by
  project. Rename from the session title.
- **Archive** from the sidebar hover icon; **auto-archive after PR merge or
  close** in settings, for finished local sessions.
- Compaction is automatic when context fills; `/compact` triggers it early.
- OS notification when a session finishes while you are elsewhere.

*Smolt*: sessions listed from disk, scoped to the project and grouped by date
(Today / Yesterday / Previous 7 days), searchable by title and first message,
renameable. Worktree isolation is implemented (create, enter, remove, restart
the agent inside). No split view, filters, archive, or auto-archive.

### 7.1 Side chat

`Cmd/Ctrl+;` or `/btw` — reads the main thread but adds nothing back. Local,
SSH and WSL only; never saved to disk.

*Smolt*: implemented, as a second agent, in the right rail.

### 7.2 Working across sessions

Claude can list other Code-tab sessions, read what they have been doing,
message them, rename and archive them. It sees only sessions the app runs
(local, SSH, WSL) — never cloud, CLI or IDE sessions — defaults to the 20 most
recent, skips archived, and never lists the asking session. Messages arrive as
a labelled card linking back; a busy session receives it after its current
work. Safety: archiving always asks, even in Auto and Bypass; unattended
sessions can neither send nor receive; inbound controls (`crossSessionInbound`)
are honoured; messages are quoted and attributed.

**Task chips**: when Claude notices out-of-scope work it offers it as a chip
that starts a new session in its own worktree.

*Smolt*: not built.

### 7.3 Cloud, continuing elsewhere, Dispatch

**Continue in** (VS Code icon, bottom right): push to **Claude Code on the
Web** — branch pushed, conversation summarised, cloud session created, local
session optionally archived, requires a clean tree — or open the project in an
IDE. **Dispatch** (Cowork) can spawn Code sessions from a phone; they appear
with a Dispatch badge, notify on completion, and their computer-use approvals
expire after 30 minutes.

*Smolt*: not built.

---

## 8. Extending

- **Connectors** — `+` → Connectors; MCP servers with a graphical setup
  (Calendar, Slack, GitHub, Linear, Notion…). Managed in Settings → Connectors.
  Local and SSH only.
- **Skills** — `/` or `+` → Slash commands; built-ins, personal skills in
  `~/.claude/skills/`, project skills, plugin skills. SSH reads the remote
  home; cloud loads account skills.
- **Plugins** — `+` → Plugins; browser over configured marketplaces, enable /
  disable / uninstall, scoped to user, project or local. Not in cloud or WSL.
- **Customize** in the sidebar manages connectors, skills and plugins in one
  place, synced through the account.

*Smolt*: slash commands from the agent (skills, templates, extension commands).
No connector UI, plugin browser, or Customize surface; MCP and plugins are
configured in files.

### 8.1 Preview servers — `.claude/launch.json`

| Field | Meaning |
| --- | --- |
| `name` | Unique identifier |
| `runtimeExecutable` | Command (`npm`, `yarn`, `node`) |
| `runtimeArgs` | Arguments to it |
| `port` | Listening port, default 3000 |
| `cwd` | Working directory, `${workspaceFolder}` for the root |
| `env` | Extra variables (not secrets — the file is committed) |
| `autoPort` | `true` find a free port, `false` fail, unset ask and remember |
| `program` / `args` | Run a script with `node` directly |
| `url` | Open a specific address instead of `localhost:<port>` |

A localhost `url` must be the bare origin with a matching port; external
addresses prompt on first open. A `url` with no command attaches to a server
you already run. `autoVerify` sits at the top level.

*Smolt*: not built (no browser pane). The file format is worth keeping
compatible if that pane is ever added.

### 8.2 Scheduled tasks / Routines

Sidebar → **Routines** → New routine → Local. Fields: **Name** (kebab-cased,
used as the folder), **Description**, **Instructions** (with mode, model,
folder and worktree pickers), **Schedule**. Presets: Manual, Hourly, Daily
(time picker, 9am default), Weekdays, Weekly (time and day); anything else by
asking in plain language.

Runs on the machine, checked every minute while the app is open, with a small
deterministic stagger. A run appears under **Scheduled** in the sidebar with a
notification. Missed runs: on wake, one catch-up for the most recent missed
time within seven days. **Keep computer awake** prevents idle sleep. Per-task
permission mode; always-allow answers are remembered per task and revocable.
Detail page: **Run now**, Active/Paused, Edit, run history including skips and
why, allowed permissions, Delete (optionally removing
`~/.claude/scheduled-tasks/<name>/SKILL.md`). A running task can reschedule
itself through `update_scheduled_task`.

*Smolt*: not built.

---

## 9. Settings

Reference groups: General, Account, Privacy, Billing, Usage, Capabilities,
Memory, **Claude Code**, Cowork, Claude in Chrome; then **Desktop app**:
General, Extensions, Developer; then Customize. The Claude Code panel carries a
guest-pass card, "Classify session states", "Switch models when a message is
flagged", and **Code appearance** (a light and a dark theme picker).

*Smolt*: a panel with a search box and a nav column — **Session** (General,
Model) and **App** (Appearance, About). General holds session name,
auto-compaction, auto-retry, queued-message delivery, worktrees, compact and
export. Model holds a filterable model list and effort. Appearance holds a
System/Light/Dark theme and a serif-prose switch. About holds the working
directory, version and shortcuts. The panel is a fixed size and scrolls.

The account-shaped items — Account, Billing, Usage-as-plan, guest passes,
referrals — have no counterpart and are **not built by choice**: they are the
front end of a hosted subscription that does not exist behind Smolt, and
mocking them would put fabricated account state in the product.

---

## 10. Computer use

Research preview, macOS and Windows, Pro/Max only, off by default. Enabled in
Settings → General (Desktop app); macOS additionally needs **Accessibility**
and **Screen Recording**. Claude prefers, in order: a connector, Bash, Claude
in Chrome, the iOS Simulator pane, and only then screen control.

Per-app tiers, fixed by category: **View only** (browsers, trading platforms),
**Click only** (terminals, IDEs), **Full control** (everything else).
Approval is per app per session — 30 minutes in Dispatch-spawned sessions.
Broad-reach apps carry an extra warning. Settings offer **Denied apps** and
**Unhide apps when Claude finishes**.

*Smolt*: no screen control. It does have a cross-platform **screenshot** tool
(macOS `screencapture`, Windows PowerShell, Linux grim/spectacle/
gnome-screenshot/scrot/import/xwd) returning an image the model can read.

---

## 11. Enterprise

- **Admin console**: Code in the desktop, Code in the web, Remote Control,
  Disable bypass permissions.
- **Managed settings**: `permissions.disableBypassPermissionsMode`,
  `disableAutoMode`, `autoMode`, `browserExternalPageTools`,
  `disableMobileSimulatorTools`, `disableBrowserExternalNavigation`,
  `sshConfigs`, `sshHostAllowlist`, `disableDesktopLocalSessions`,
  `managedMcpServers`. Which reach a session depends on where it runs — local
  files apply locally and over SSH (read from the remote), cloud sessions read
  server-managed settings.
- **Device management**: macOS via `com.anthropic.claudefordesktop` (Jamf,
  Kandji); Windows via `SOFTWARE\Policies\Claude`.
- **Network**: `anthropic.com`, `claude.ai`, `claude.com`, `claude.app`,
  `*.claudeusercontent.com`, `*.claudemcpcontent.com`, HTTPS/443, with a
  narrower host list available; artifacts additionally reach Google Fonts and
  four CDNs.
- **Deployment**: macOS `.dmg` via MDM; Windows MSIX with silent install.
- SSO (SAML/OIDC) for Enterprise.

*Smolt*: none of this exists, and none of it is UI — it is the administration
layer of a distributed product.

---

## 12. Coming from the CLI

Desktop runs the same engine; both can run at once on one project, sharing
`CLAUDE.md`, MCP servers, hooks, skills and `settings.json`, while keeping
separate session history. `/desktop` moves a CLI session across. Desktop also
loads MCP servers from `claude_desktop_config.json`, which the standalone CLI
does not.

Not available in Desktop: third-party model providers by default, inline code
suggestions, agent teams, `--print`/SDK scripting, and terminal-dialog commands
(`/permissions` replies that it is unavailable; `/config` opens Settings).

*Smolt*: the desktop package embeds the same agent as the CLI over its RPC
mode, and shares the agent directory, so memory, skills and sessions are common
to both.

---

## 13. Troubleshooting surfaces

Version via **About**; 403s usually fixed by signing out and in; blank screen by
restart, update, firewall and Event Viewer; "Failed to load session" from a
missing folder, absent Git LFS or permissions; missing tools from `PATH` not
being inherited; Git and Git LFS required on Windows; MCP server checks on
Windows; force-quit paths; and `git fetch origin <branch>` for a cloud-created
branch that does not exist locally.

*Smolt*: surfaces agent start-up errors in the composer notice; no dedicated
troubleshooting UI.

---

## Summary of what Smolt does not have

Grouped by why, because the reasons differ:

**Not built, and buildable** — browser/preview pane with auto-verify, file
pane, tasks and subagent panes, diff line comments and Review code, scheduled
tasks, cross-session awareness, split view, session filters and archiving,
connector and plugin UI, `@mention` autocomplete, three-way transcript modes.

**Not applicable to a local single-machine tool** — cloud and SSH and WSL
environments, Continue-in-web, Dispatch, enterprise administration, iOS
Simulator (macOS only).

**Deliberately not built** — the Chat and Cowork tabs and every account-shaped
surface (Account, Billing, plan usage, guest passes, referrals). These are the
front end of a hosted subscription; Smolt has no accounts, so building them
would mean displaying invented state.
