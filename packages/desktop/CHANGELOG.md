# Changelog

## [Unreleased]

### Added
- If llama.cpp is set up and a llama-server binary plus GGUF models are found on the machine, settings get a Launch server button that starts the router and refreshes the model list.

### Fixed
- The branch chip on a new chat renders instantly from a cached branch list instead of popping in after the IPC round-trip.

### Changed

- An advisor note in the transcript now starts expanded, so its text is read without a click; collapsing one keeps it collapsed, and collapse-all still shuts them.
- The context-window figures now keep up: every finished request and tool result asks for a fresh reading (throttled to one every two seconds), and an open popover re-reads every three seconds, so a turn in progress moves the bar and an advisor's spend appears when its review ends rather than the next time the popover is opened.
- The context-window popover draws the same bar whether the breakdown is open or folded: one segment per part in the part's colour, with the auto-compaction tick, instead of a plain green fill once the breakdown is folded. The green fill remains only for a chat whose agent reports no parts.
- The auto-compaction and auto-retry switches and the Compact now button are no longer duplicated in the context-window popover; they live in Settings only.
- The advisor and research spend that was listed under a separate "Also spending on this chat" heading now sits in the main context-window list, under the free space.
- Each context file in the context-window breakdown is now a link that opens the file, named by file and folder rather than a truncated path; the footnote about estimation is gone.
- The context-window popover now shows a second, magnified bar of what is in use while the window is mostly free, so the parts can be told apart at 2% just as at 60%; the tool and context-file groups start folded instead of open.
- Dictation is transcribed in one pass when the microphone closes instead of continuously while it records; the model is now Whisper-small (a step up in accuracy from Moonshine-base, ~250 MB downloaded once), and the mic button shows a rolling waveform while recording instead of a live level meter. The send button stays available while dictating: clicking it stops the transcription, waits for the words to land, then sends.

### Fixed

- Fixed the Changes pane claiming "This chat hasn't changed anything yet" in folders that are not git repositories; it now says why the tree cannot be diffed instead of denying the chat's edits.
- Fixed renaming a chat silently doing nothing: the rename flows used `window.prompt`, which Electron does not implement. Chat renames (sidebar menu, composer command, titlebar) and worktree naming now use an in-app prompt dialog.
- Fixed the slash-command palette ignoring Escape and outside clicks; Escape no longer also stops a running turn while the palette is up.
- Fixed all icon-only buttons being unnamed for screen readers; titles now double as accessible names.
- Fixed the tool group summary lying in past tense while a call in the group awaited approval ("Running…", not "Ran…"), and "used 1 tool" over a group that expands to a different number of rows (a lone tool is now named).
- Fixed transient confirmations (export success) appearing in a different corner than every other toast; all toasts anchor bottom-right.
- Fixed Settings → About showing two unlabelled version numbers that could disagree; the app version and the release feed version are now labelled and distinguished.
