# dsh-workspace-scope-selection

A fourth permission option for DeepSeek Harness sessions: **Selected Workspace
Write**. Instead of "only the workspace" or "everything", you pick exactly
which directories the agent may write to — the workspace itself included.

## What you get

- The composer permission chip (and `/permission`) gains a **Selected
  Workspace Write** option.
- Picking it opens a directory-tree editor right away. **The checked state IS
  the writable scope**: check directories to make them writable; the session
  workspace sits at the top, checked by default — uncheck it to make the
  workspace read-only. Everything unchecked is denied (or needs your
  approval).
- A small **Edit scope** button next to the access chip reopens the editor.
- The selection is per-session and survives restarts.

## Install

```sh
dsh plugin --profile web add file:/path/to/dsh-workspace-scope-selection
```

Use the `file:` protocol (not a bare path — that records a `link:` symlink
and the plugin fails to load). Then **restart `dsh web`**.

## Usage

1. Click the permission chip (or `/permission`) → **Selected Workspace Write**.
2. In the editor, check the directories the agent may write to. Unchecking a
   parent removes its whole subtree; a directory included via a checked
   parent shows a "via parent" mark.
3. Click **Done**. The selection applies immediately.

## How it works

- The plugin adds a `selected-workspace-write` sandbox mode and enforces it
  in both the filesystem tools and the shell/terminal sandboxes: only the
  selected directories (plus platform temp areas) are writable.
- The selection is stored in the session log and replayed on resume.
- Outside the selection, writes are denied and can be escalated with your
  approval, like any other sandboxed operation.

## Notes

- The General-settings Permission row still lists the three built-in options;
  this one is a per-session switch via the chip or `/permission`.
- Windows grants the workspace + temp areas only (selected extra roots are
  denied there).
- Writes outside the selection always require an approved escalation.

## Uninstall

```sh
dsh plugin --profile web remove dsh-workspace-scope-selection
```

then restart `dsh web`.

## Development

```sh
node --test test/core.test.mjs
```

`lib/client.js` is a hand-written module-loader bundle (no build step).
