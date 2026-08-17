# dsh-workspace-scope-selection

A fourth permission option for DeepSeek Harness sessions: **Selected
Workspace Write**. The built-in options are rigid — a session can write only
inside its workspace (`workspace-write`), or everywhere (`danger-full-access`).
This plugin adds a middle ground: pick the option, open the workspace's
directory tree, and toggle exactly which directories the agent may write to,
in addition to the workspace itself.

## What you get

- The composer permission chip and the `/permission` popup gain a fourth
  option, **Selected Workspace Write**.
- Picking the option in the access chip opens the scope editor **directly**
  — no intermediate bar or notification.
- While the session runs under the option, a small **Edit scope** button
  sits right next to the access chip in the composer and opens the same
  editor.
- The editor walks the directory tree (breadcrumbs up to the filesystem
  root, so you can also grant directories outside the workspace) and toggles
  which directories are included. Checked directories — and everything
  beneath them — become writable by the agent. The workspace itself is
  always writable.
- The selection is durable session state: it survives restarts (replayed
  from the session log like `sandbox/mode`), stays with the session, and is
  enforced by both the filesystem tools and the shell/terminal sandboxes.

## How it works

The harness core knows three sandbox modes and enforces them through its own
vocabulary (`SandboxMode`, `writableRoots`, the fs fence, the bash provider).
This plugin extends that vocabulary at runtime without touching the
installed packages:

| Piece | What the plugin does |
|---|---|
| Mode | Adds `selected-workspace-write` as a session switch, carried by the existing log-only `sandbox/mode` event. |
| Preset | Registers the option in `ctx.permissionPresets.presets` (`sandbox: selected-workspace-write` + `approval: ask`), so the composer chip, the `/permission` popup, and the `/permission` command all offer and display it — the `permissions` projection derives options from the preset table. |
| Selection state | One log-only `workspace-scope/selection` event carrying the whole roots array (last one wins), folded back on resume; a `workspace-scope` session projection pushes it to the browser. |
| Policy resolution | Patches `ctx.sandboxPolicy.resolve()` to attach `extraWritableRoots` when the resolved mode is the new mode; patches the `sandbox:policy` prompt contribution so the model sees the new mode's text (the core renderer throws on unknown modes). |
| Filesystem enforcement | Patches `ctx.fs.checkedTarget` (the in-process fence) to contain writes under the workspace/temp roots **plus** the selected roots, with the same structured `FS_SANDBOX_DENIED` refusal and the same escalation hint. |
| Process enforcement | Patches `ctx.sandbox.confine` (the one provider bash, persistent terminals, and pwsh all wrap through): the new mode is translated to `workspace-write` for the base workspace/temp grants, then the extra roots are spliced into the selected runner's dialect — bwrap `--bind` pairs, Landlock `--rw` grants, Seatbelt `(subpath …)` forms. |
| Escalation | Widens the ladder (`WIDER_MODES`): under the new mode a denied operation can still escalate to `danger-full-access` through the ordinary approval flow. |
| Write path | A `/workspace-scope` command (`set` / `clear` / `info` / `list`) validates, canonicalizes, dedupes, and caps the roots (max 128), and serves as the host-side directory-listing fallback. |

### Enforcement coverage

- **Filesystem tools** (`write` / `edit`): full containment under workspace +
  selected roots + platform temp areas.
- **Bash one-shot commands and background jobs** (bwrap / Landlock on Linux,
  Seatbelt on macOS): workspace + selected roots writable, everything else
  read-only.
- **Persistent terminals**: same confined argv path as bash.
- **Windows (ACL runner) and custom `runnerCommand` deployments**: the
  workspace and temp areas stay writable; extra selected roots are **denied**
  (fail closed) — the option degrades to `workspace-write` there.
- **Danger-full-access escalations** still work from the new mode.

## Install

From a local checkout, use the **`file:` protocol** — this matters:

```sh
dsh plugin --profile web add file:/path/to/dsh-workspace-scope-selection
```

The plugin imports the harness's own packages (`@deepseek-ai/dsh-fs`,
`@deepseek-ai/dsh-sandbox`), which resolve through the shared
`$DSH_HOME/profiles/node_modules` fallback — and that fallback only works
when the plugin's module lives *inside* the profile tree. With the `file:`
protocol, pnpm's hoisted linker materializes the package as a real directory
(hardlinked to your checkout, so edits still propagate) inside the profile's
`node_modules`, so the imports resolve. A bare `dsh plugin add /path` (no
`file:`) records a `link:` dependency instead — a symlink pointing back to
your checkout — and Node then resolves the imports from the checkout's real
location, which fails with `ERR_MODULE_NOT_FOUND` at boot. If you already
installed it that way, fix with:

```sh
dsh plugin --profile web remove dsh-workspace-scope-selection
dsh plugin --profile web add file:/path/to/dsh-workspace-scope-selection
```

Then **restart the web server** (stop the `dsh web` process and run `dsh web`
again) so the loader picks up the new plugin row and the client bundle.

## Usage

1. Open a conversation, click the permission chip in the composer (or run
   `/permission`), and pick **Selected Workspace Write**.
2. The scope editor opens immediately. Walk the directory tree — the tree
   starts at the session's workspace, and the breadcrumbs let you navigate
   up to any parent, so directories outside the workspace can be granted
   too.
3. Check the directories the agent may write to. Unchecking a directory
   removes it from the selection; a directory that is only *covered* by a
   checked ancestor shows a "via parent" mark — uncheck the ancestor to
   remove the whole subtree.
4. **Done**. The agent's next write to a selected directory succeeds without
   approval; anything outside the workspace and the selection still needs an
   approval-gated escalation, exactly like `workspace-write`.
5. Later, reopen the editor with the **Edit scope** button next to the
   access chip in the composer.

The selection persists per session. Switching the session away from
Selected Workspace Write keeps the selection stored, so returning to the
option restores it.

## Uninstall

```sh
dsh plugin --profile web remove dsh-workspace-scope-selection
```

and restart `dsh web`. Sessions that already switched to the mode stop
getting the extra roots (the events remain in their logs but nothing folds
them anymore).

## Limitations and notes

- **Deployments that mount `dsh-invariants`**: the shipped profiles do not
  compose the invariant registry, so the extended mode passes freely. A
  deployment that explicitly mounts it must blocklist the sandbox-policy
  companion (`invariants.package_blocklist: ['^@deepseek-ai/dsh-sandbox-policy$']`),
  because the core companion validates `sandbox/mode` against the closed
  three-mode vocabulary.
- **The General-settings Permission row** (default for *new* sessions) is
  schema-bound and still lists the three built-in options; the new option is
  a per-session switch via the composer chip, the `/permission` popup, or
  `/permission selected-workspace-write`.
- **Roots are an include list, not a deny list**: you cannot express "everything
  except this subdirectory". Unchecking a parent removes its whole subtree.
- **Symlinks** are resolved when a root is selected and when a target is
  checked, so the granted paths are canonical (same policy as the core fence).
- **Windows** currently grants only the workspace + temp areas for this mode
  (the ACL runner materializes one workspace grant; extra roots are denied).
- The plugin patches service instances at load and restores them on unload;
  HMR of this plugin reloads cleanly.

## Development

The host logic is split into a dependency-free module (`lib/core.js`) so the
unit tests run without the harness module graph:

```sh
node --test test/core.test.mjs
```

`lib/client.js` is a hand-written module-loader bundle (no build step),
following the same pattern as `dsh-in-convo-mode-change` / `dsh-rewind`. It
requires only `react` and `react-dom` (both shell statics). The editor is
portaled to `document.body` because the composer seat is sticky inside its
own stacking context — an in-place fixed overlay would be clipped or buried.
