// dsh-workspace-scope-selection — host half.
//
// Mounted as a normal plugin row in the profile composition (see
// cordis.patch.yml). It adds a FOURTH permission option to the harness:
// `selected-workspace-write` — write access inside the session workspace
// PLUS a user-selected set of directories, chosen in the web UI by walking
// the directory tree and toggling what is included.
//
// The harness core knows three modes (`read-only`, `workspace-write`,
// `danger-full-access`); this plugin extends that vocabulary at runtime
// without touching the installed packages:
//
// - It registers `selected-workspace-write` in `ctx.permissionPresets.presets`
//   (sandbox `selected-workspace-write` + approval `ask`), so the composer
//   permission chip, the `/permission` popup, and the `/permission` command
//   all offer and display it — the `permissions` projection derives options
//   and the current value straight from the preset table.
// - The session's selected directories are durable session state: one
//   log-only `workspace-scope/selection` event carrying the whole roots
//   array (last one wins), folded back on resume exactly like `sandbox/mode`.
//   The type is registered into `KNOWN_SESSION_EVENT_TYPES` while the plugin
//   is loaded, so the persistence read path accepts logs that carry it.
// - `ctx.sandboxPolicy.resolve()` is patched so a session in the new mode
//   resolves with `extraWritableRoots` attached; the `sandbox:policy` prompt
//   contribution is patched to render the new mode's text (the core renderer
//   would throw on an unknown mode).
// - Enforcement is patched at the two choke points every family shares:
//   `ctx.fs.checkedTarget` (the in-process fs fence) and `ctx.sandbox.confine`
//   (bash, persistent terminals, and pwsh all wrap argv through the same
//   provider). `confine` translates the new mode to `workspace-write` for the
//   base workspace/temp grants, then splices the extra-root grants into the
//   selected runner's dialect (bwrap binds, Landlock `--rw`, Seatbelt
//   subpaths). Windows ACL and custom `runnerCommand` deployments keep the
//   workspace/temp grants and deny the extra roots (fail closed).
// - The escalation ladder is widened: under the new mode a denied operation
//   may still escalate to `danger-full-access` through the ordinary
//   approval flow.
// - A `/workspace-scope` command (set / clear / info / list) is the write
//   path and host-side listing fallback, and a `workspace-scope` session
//   projection pushes the current selection to the browser.
//
// The web client half (lib/client.js) renders the editor: when the mode is
// active, a dock bar above the composer shows the selection and opens the
// directory-tree picker.

import { FsError } from "@deepseek-ai/dsh-fs";
import { WIDER_MODES } from "@deepseek-ai/dsh-sandbox";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  MODE,
  SELECTION_EVENT,
  ancestryCrumbs,
  augmentConfinedArgv,
  canonicalPath,
  isPathUnder,
  listDirectoryLevel,
  normalizeRoots,
  normalizeSelectionRoots,
  renderSelectedPolicyText,
  selectionOf,
  selectedRootsOf,
  tempWritableRoots,
} from "./core.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-workspace-scope-selection";

/** Required host services (cordis fiber inject). */
export const inject = [
  "sandboxPolicy",
  "sandbox",
  "fs",
  "systemPrompt",
  "permissionPresets",
  "commands",
  "sessionProjections",
  "sessions",
];

/** The preset table entry this plugin advertises (sandbox mode + approval policy). */
export const PRESET = Object.freeze({
  sandbox: MODE,
  approval: "ask",
  name: "Selected Workspace Write",
  description:
    "Write inside the session workspace plus a user-selected set of directories; wider retries require approval.",
});

/**
 * The session's workspace root: its immutable header cwd, or the deployment
 * fallback for sessions without one.
 * @param session - the live session.
 * @param fallback - `ctx.sandboxPolicy.workspaceRoot`.
 * @returns the workspace root for the session.
 */
function workspaceRootOf(session, fallback) {
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : fallback;
}

/**
 * Patch `ctx.sandboxPolicy.resolve`: when the resolved mode is the new mode,
 * attach the session's selected roots as `extraWritableRoots` so every
 * enforcing consumer (fs fence, bash provider, terminal) sees them. Core
 * modes pass through untouched.
 * @param service - the sandbox-policy service instance.
 * @returns the restore disposer.
 */
function patchResolve(service) {
  const original = service.resolve.bind(service);
  service.resolve = (request = {}) => {
    const resolved = original(request);
    if (resolved.mode !== MODE) return resolved;
    const session = request.session;
    if (session === void 0) {
      return { ...resolved, extraWritableRoots: [resolved.workspaceRoot] };
    }
    const selection = selectionOf(session.events);
    // The workspace is an ORDINARY member of the selection: it is writable
    // exactly when it is in the list. With no recorded selection the default
    // is workspace-writable.
    const roots = selection.workspace && !selection.roots.includes(resolved.workspaceRoot)
      ? [resolved.workspaceRoot, ...selection.roots]
      : selection.roots;
    return {
      ...resolved,
      extraWritableRoots: roots,
    };
  };
  return () => {
    service.resolve = original;
  };
}

/**
 * Patch the `sandbox:policy` prompt contribution: the core renderer throws
 * on the new mode ("unreachable sandbox mode"), so the global layer's entry
 * text is swapped for one that renders the new mode and delegates to the
 * original text for every core mode. The entry object is mutated in place
 * (the layer's NamedEntries table is read by `Map` merge, so a replaced
 * `text` is what every request sees) and restored on dispose.
 * @param systemPrompt - the system-prompt service instance.
 * @param resolvePolicy - the patched policy resolver.
 * @returns the restore disposer.
 */
function patchPolicyContext(systemPrompt, resolvePolicy) {
  const contexts = systemPrompt?.layers?.global?.contexts;
  const entry = contexts?.data?.get("sandbox:policy");
  if (entry === void 0 || typeof entry.text !== "function") return () => {};
  const originalText = entry.text;
  entry.text = (context) => {
    const session = context.agent?.session;
    if (session === void 0) return "";
    const policy = resolvePolicy({ session });
    return policy.mode === MODE ? renderSelectedPolicyText(policy) : originalText(context);
  };
  return () => {
    entry.text = originalText;
  };
}

/**
 * Patch the fs fence (`ctx.fs.checkedTarget`): under the new mode the core
 * allow-list is empty (unknown mode), so containment is checked against the
 * platform temp areas PLUS the selected roots — the writable set IS the
 * selection (the workspace root included when selected), mirroring the core
 * fence's canonicalize-then-contain sequence and its structured
 * `FS_SANDBOX_DENIED` refusal. Core modes delegate to the original fence.
 * @param fs - the sandboxed filesystem service instance.
 * @param resolvePolicy - the patched policy resolver.
 * @returns the restore disposer.
 */
function patchFsFence(fs, resolvePolicy) {
  if (fs === void 0 || typeof fs.checkedTarget !== "function") return () => {};
  const original = fs.checkedTarget.bind(fs);
  fs.checkedTarget = async (target, sandboxPolicy) => {
    const policy = sandboxPolicy ?? resolvePolicy();
    if (policy.mode !== MODE) return original(target, sandboxPolicy);
    const fresh = await fs.resolve(target.displayPath);
    const roots = tempWritableRoots();
    for (const root of policy.extraWritableRoots ?? []) roots.push(root);
    for (const root of roots) {
      if (await isPathUnder(fresh.targetKey, root)) return fresh;
    }
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under selected-workspace-write mode`,
      "FS_SANDBOX_DENIED",
    );
  };
  return () => {
    fs.checkedTarget = original;
  };
}

/**
 * Patch `ctx.sandbox.confine`: under the new mode the writable set IS the
 * selection — the base is a `read-only` translation and the platform temp
 * areas plus every selected root (the workspace root included when
 * selected) are spliced into the selected runner's dialect. Other modes
 * delegate to the original provider untouched.
 * @param provider - the local sandbox provider instance.
 * @returns the restore disposer.
 */
function patchConfine(provider) {
  if (provider === void 0 || typeof provider.confine !== "function") return () => {};
  const original = provider.confine.bind(provider);
  provider.confine = (argv, policy) => {
    if (policy.mode !== MODE) return original(argv, policy);
    const extra = (policy.extraWritableRoots ?? []).filter(
      (root) => typeof root === "string" && root.length > 0,
    );
    const base = original(argv, { ...policy, mode: "read-only" });
    return augmentConfinedArgv(base, extra, tempWritableRoots());
  };
  return () => {
    provider.confine = original;
  };
}

/** A session projection schema shaped like the core zod usage: a `parse` face. */
const workspaceScopeSchema = {
  parse(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("workspace-scope projection must be an object");
    }
    const roots = Array.isArray(value.roots)
      ? value.roots.filter((root) => typeof root === "string")
      : [];
    return {
      workspaceRoot: typeof value.workspaceRoot === "string" ? value.workspaceRoot : "",
      roots,
      workspace: value.workspace !== false,
    };
  },
};

/**
 * One `/workspace-scope` command invocation: the write path for the
 * selection (`set` / `clear`), the read face (`info`), and the host-side
 * listing fallback (`list`) for compositions whose directory picker is the
 * native capability rather than `browse`.
 * @param invocation - the command invocation (agent + rawInput).
 * @param ctx - the plugin context (for the policy fallback root).
 * @returns the command result (a promise for the async `list` verb).
 */
async function handleWorkspaceScope(invocation, ctx) {
  const session = invocation.agent.session;
  const raw = invocation.rawInput.trim();
  const space = raw.indexOf(" ");
  const verb = space === -1 ? raw : raw.slice(0, space);
  const rest = space === -1 ? "" : raw.slice(space + 1).trim();
  const workspaceRoot = workspaceRootOf(session, ctx.sandboxPolicy?.workspaceRoot);
  const selection = selectionOf(session.events);
  const effectiveRoots = selection.workspace && !selection.roots.includes(workspaceRoot)
    ? [workspaceRoot, ...selection.roots]
    : selection.roots;
  // The workspace root is an ordinary member of the selection: the recorded
  // `workspace` marker is derived from the roots themselves.
  const appendSelection = (nextRoots) => {
    session.append(SELECTION_EVENT, {
      roots: nextRoots,
      workspaceRoot,
      workspace: nextRoots.includes(workspaceRoot),
    });
  };
  switch (verb) {
    case "":
      return {
        kind: "success",
        text: `workspace-scope: ${effectiveRoots.length} selected root(s)${effectiveRoots.includes(workspaceRoot) ? " (workspace writable)" : " (workspace read-only)"}; verbs: set <json> | clear | info | list <path>`,
      };
    case "set": {
      let parsed;
      try {
        parsed = JSON.parse(rest);
      } catch {
        return { kind: "error", text: "workspace-scope: \"set\" expects a JSON array of absolute directory paths (the workspace root included when it should be writable)" };
      }
      try {
        // Array form: the FULL selection — the workspace root included when
        // it should be writable. Object form { roots, workspace } is
        // accepted for compatibility and normalized to the same list.
        let rootInput;
        if (Array.isArray(parsed)) {
          rootInput = parsed;
        } else if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.roots)) {
          const rawRoots = normalizeRoots(parsed.roots, canonicalPath);
          rootInput = parsed.workspace === false
            ? rawRoots.filter((root) => root !== workspaceRoot)
            : rawRoots.includes(workspaceRoot) ? rawRoots : [workspaceRoot, ...rawRoots];
        } else {
          return { kind: "error", text: "workspace-scope: \"set\" expects a JSON array of absolute directory paths (the workspace root included when it should be writable)" };
        }
        const normalized = normalizeRoots(rootInput, canonicalPath);
        appendSelection(normalized);
        return {
          kind: "success",
          text: `workspace-scope: ${normalized.length} root(s) selected${normalized.includes(workspaceRoot) ? ", workspace writable" : ", workspace read-only"}`,
        };
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
    }
    case "clear":
      appendSelection([]);
      return { kind: "success", text: "workspace-scope: selection cleared (workspace read-only)" };
    case "info":
      return {
        kind: "success",
        text: JSON.stringify({ workspaceRoot, roots: effectiveRoots }),
      };
    case "list": {
      if (rest === "" || !rest.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(rest)) {
        return { kind: "error", text: "workspace-scope: \"list\" expects an absolute directory path" };
      }
      try {
        return {
          kind: "success",
          text: JSON.stringify(await listDirectoryLevel(rest)),
        };
      } catch (error) {
        return {
          kind: "error",
          text: `workspace-scope: cannot list ${rest}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    default:
      return {
        kind: "error",
        text: `workspace-scope: unknown verb "${verb}" (verbs: set | clear | info | list)`,
      };
  }
}

/**
 * Plugin body: extend the permission vocabulary and enforce it. Every patch
 * is restored by the returned disposer, so unloading (or HMR) leaves the
 * core services exactly as they were.
 * @param ctx - the plugin context carrying the host services.
 * @returns the combined disposer.
 */
export function apply(ctx) {
  const disposers = [];
  const resolvePolicy = (request = {}) => ctx.sandboxPolicy?.resolve(request);

  // 1. The mode resolver: attach selected roots under the new mode.
  const sandboxPolicy = ctx.get("sandboxPolicy");
  if (sandboxPolicy !== void 0) disposers.push(patchResolve(sandboxPolicy));

  // 2. The prompt contribution: render the new mode instead of throwing.
  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== void 0 && sandboxPolicy !== void 0) {
    disposers.push(patchPolicyContext(systemPrompt, (request) => sandboxPolicy.resolve(request)));
  }

  // 3. The fs fence: contain writes under workspace + selected roots.
  const fs = ctx.get("fs");
  if (fs !== void 0) disposers.push(patchFsFence(fs, resolvePolicy));

  // 4. The process sandbox: grant the extra roots in each runner dialect.
  const provider = ctx.get("sandbox");
  if (provider !== void 0) disposers.push(patchConfine(provider));

  // 5. The escalation ladder: under the new mode a denial may still escalate
  //    to full access through the ordinary approval flow.
  if (WIDER_MODES[MODE] === void 0) {
    WIDER_MODES[MODE] = ["danger-full-access"];
    disposers.push(() => {
      delete WIDER_MODES[MODE];
    });
  }

  // 6. The persistence vocabulary: `Session.append` offers no way to stamp
  //    the envelope's `ignorable` marker, so a recorded selection event is a
  //    required event — a harness build that does not recognize the type
  //    refuses to reconstruct the log (SessionFormatUnsupportedError on
  //    history load). Register the type while the plugin is loaded; the
  //    exported set is the same instance the persistence read path consults.
  if (!KNOWN_SESSION_EVENT_TYPES.has(SELECTION_EVENT)) {
    KNOWN_SESSION_EVENT_TYPES.add(SELECTION_EVENT);
    disposers.push(() => {
      KNOWN_SESSION_EVENT_TYPES.delete(SELECTION_EVENT);
    });
  }

  // 7. Advertise the fourth option in the permission surface. The preset
  //    table is read dynamically by `derive`/`selectFor`, so the composer
  //    chip, the /permission popup, and the /permission command all offer
  //    and display "Selected Workspace Write" without any core change.
  const permission = ctx.get("permissionPresets");
  if (permission !== void 0 && !Object.hasOwn(permission.presets, MODE)) {
    permission.presets[MODE] = { ...PRESET };
    disposers.push(() => {
      delete permission.presets[MODE];
    });
  }

  // 8. The write path and the read face for the selection.
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "workspace-scope",
      description: "Manage the selected-workspace-write directory selection",
      input: { hint: "<set|clear|info|list>" },
      handler: (invocation) => handleWorkspaceScope(invocation, ctx),
    });
  });
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: "workspace-scope",
      schema: workspaceScopeSchema,
      init: () => ({ workspaceRoot: "", roots: [], workspace: true }),
      apply: (state, event) => {
        if (event.type !== SELECTION_EVENT) return state;
        const workspaceRoot = typeof event.data?.workspaceRoot === "string" ? event.data.workspaceRoot : state.workspaceRoot;
        const workspace = event.data?.workspace !== false;
        return {
          workspaceRoot,
          // Normalize so the folded roots ARE the writable set: the session
          // workspace root is a member exactly when the workspace is writable.
          roots: normalizeSelectionRoots(event.data?.roots, workspaceRoot, workspace),
          workspace,
        };
      },
      view: (state) => state,
      stateVersion: 1,
    });
  });

  return () => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        disposers[index]();
      } catch {
        /* restore is best-effort on teardown */
      }
    }
  };
}

export { ancestryCrumbs, listDirectoryLevel, workspaceRootOf };
