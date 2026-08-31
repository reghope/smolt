# Changelog

## [Unreleased]

### Fixed

- Fixed the Changes pane claiming "This chat hasn't changed anything yet" in folders that are not git repositories; it now says why the tree cannot be diffed instead of denying the chat's edits.
- Fixed renaming a chat silently doing nothing: the rename flows used `window.prompt`, which Electron does not implement. Chat renames (sidebar menu, composer command, titlebar) and worktree naming now use an in-app prompt dialog.
- Fixed the slash-command palette ignoring Escape and outside clicks; Escape no longer also stops a running turn while the palette is up.
- Fixed all icon-only buttons being unnamed for screen readers; titles now double as accessible names.
- Fixed the tool group summary lying in past tense while a call in the group awaited approval ("Running…", not "Ran…"), and "used 1 tool" over a group that expands to a different number of rows (a lone tool is now named).
- Fixed transient confirmations (export success) appearing in a different corner than every other toast; all toasts anchor bottom-right.
- Fixed Settings → About showing two unlabelled version numbers that could disagree; the app version and the release feed version are now labelled and distinguished.
