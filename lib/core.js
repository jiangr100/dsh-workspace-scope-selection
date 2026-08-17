// dsh-workspace-scope-selection — shared pure helpers (host half).
//
// This module is deliberately free of @deepseek-ai imports: everything here
// is plain Node + plain logic, so the unit tests in test/core.test.mjs can
// import it without the harness module graph. The Cordis plugin body
// (lib/index.js) composes these helpers with the live host services.
//
// What lives here:
// - the mode/event vocabulary (the fourth sandbox mode and the session event
//   that carries the selected roots);
// - the durable fold of the selection from a session log;
// - root validation/canonicalization for the `/workspace-scope set` verb;
// - the containment check the fs fence uses for the new mode;
// - the argv augmentation that grants the extra roots in each sandbox
//   runner dialect (bwrap / Landlock / Seatbelt);
// - the model-facing policy text for the new mode;
// - the host-side directory listing fallback (one level).

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** The fourth sandbox mode this plugin adds. */
export const MODE = "selected-workspace-write";
/** Session event carrying the whole selection (last one wins). */
export const SELECTION_EVENT = "workspace-scope/selection";
/** Upper bound on how many roots one session selection may name. */
export const MAX_ROOTS = 128;
/** Upper bound on one fallback directory listing level. */
export const MAX_LISTING_ENTRIES = 500;

/**
 * Resolve a granted root to the path enforcement actually compares:
 * canonical (symlinks resolved), or the spelling as-is when the path does
 * not exist yet (a missing root matches nothing until it exists — the
 * conservative outcome; inventing a fallback would grant a path the caller
 * never named). Mirrors `canonicalPath` in @deepseek-ai/dsh-sandbox.
 * @param path - the root as selected by the user.
 * @returns the canonical path, or the spelling as-is when resolution fails.
 */
export function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The session's selected roots: the `workspace-scope/selection` event with
 * the highest seq, or `[]` when the session never recorded one. The event
 * carries the WHOLE post-change state (never a delta), so this fold is a
 * plain last-wins scan.
 * @param events - session events in log order.
 * @returns the selected roots (canonical absolute paths).
 */
export function selectedRootsOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === SELECTION_EVENT) {
      const roots = event.data?.roots;
      if (Array.isArray(roots)) return roots.filter((root) => typeof root === "string");
      return [];
    }
  }
  return [];
}

/**
 * Validate and normalize one `/workspace-scope set` payload: an array of
 * absolute directory paths, deduplicated after canonicalization, sorted for
 * stable logs, bounded by {@link MAX_ROOTS}. Throws on malformed input so
 * the command handler can report a precise error.
 * @param input - the raw JSON-parsed roots value.
 * @param canonical - path canonicalizer (defaults to {@link canonicalPath}).
 * @returns the normalized roots.
 */
export function normalizeRoots(input, canonical = canonicalPath) {
  if (!Array.isArray(input)) {
    throw new Error(`workspace-scope: "set" expects a JSON array of absolute directory paths`);
  }
  if (input.length > MAX_ROOTS) {
    throw new Error(`workspace-scope: at most ${MAX_ROOTS} directories may be selected, got ${input.length}`);
  }
  const seen = new Set();
  const roots = [];
  for (const candidate of input) {
    if (typeof candidate !== "string" || candidate.trim() === "" || !isAbsolute(candidate)) {
      throw new Error(`workspace-scope: ${JSON.stringify(candidate)} is not an absolute directory path`);
    }
    const resolved = canonical(candidate);
    if (resolved.length === 0 || seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots.sort();
}

/**
 * Lexical containment: whether `path` equals `root` or lies beneath it by
 * separator-aware prefix comparison. Case handling follows the host
 * filesystem convention (case-insensitive on Windows).
 * @param path - the (canonical) target path.
 * @param root - the (canonical) writable root.
 * @param caseSensitive - whether lexical comparison preserves case.
 * @returns whether the path is the root or a descendant of it.
 */
export function isLexicallyUnder(path, root, caseSensitive = process.platform !== "win32") {
  const comparableTarget = caseSensitive ? path : path.toLowerCase();
  const comparableRoot = caseSensitive ? root : root.toLowerCase();
  if (comparableTarget === comparableRoot) return true;
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparableTarget.startsWith(prefix);
}

/**
 * Containment with a filesystem-identity fallback: the lexical fast path
 * covers normal canonical spellings; when spellings differ (Windows aliases,
 * casing), walk the target's existing ancestors and compare device/inode
 * identity with the root. Same algorithm as the core fs fence so the plugin
 * grants and the core grants cannot drift.
 * @param path - the canonical target path.
 * @param root - the canonical writable root.
 * @param caseSensitive - lexical case handling (see {@link isLexicallyUnder}).
 * @param stat - `node:fs/promises` stat (injectable for tests).
 * @returns whether the target is the root or a descendant of it.
 */
export async function isPathUnder(path, root, caseSensitive = process.platform !== "win32", stat = undefined) {
  if (isLexicallyUnder(path, root, caseSensitive)) return true;
  const statFn = stat ?? (await import("node:fs/promises")).stat;
  let rootInfo;
  try {
    rootInfo = await statFn(root, { bigint: true });
  } catch {
    return false;
  }
  let ancestor = path;
  for (;;) {
    let ancestorInfo;
    try {
      ancestorInfo = await statFn(ancestor, { bigint: true });
    } catch {
      ancestorInfo = void 0;
    }
    if (ancestorInfo !== void 0 && ancestorInfo.dev === rootInfo.dev && ancestorInfo.ino === rootInfo.ino) {
      return true;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}

/** Quote one path as an SBPL string literal (Seatbelt profile syntax). */
export function sbplString(path) {
  return `"${path.replaceAll("\\", String.raw`\\`).replaceAll("\"", String.raw`\"`)}"`;
}

/**
 * Splice extra writable-root grants into a confined argv produced for a
 * `workspace-write` policy, in the runner dialect detected from `argv[0]`:
 * - bwrap: `--bind <root> <root>` pairs before the `--` separator;
 * - Landlock launcher: `--rw <root>` flags before the `--` separator;
 * - sandbox-exec (Seatbelt): `(subpath …)` forms spliced into the existing
 *   `(allow file-write* …)` SBPL form (the LAST such form — the literal
 *   `/dev/null` form comes first);
 * - anything else (a custom `runnerCommand`, the Windows ACL runner): the
 *   argv is returned unchanged, so extra roots fail closed (denied) rather
 *   than being silently granted or silently ignored.
 *
 * The base confined result still grants the workspace root and platform temp
 * areas (it was built for `workspace-write`), so an unrecognized dialect
 * degrades to plain workspace-write behavior, never to full access.
 *
 * @param confined - the provider's confined result for the workspace-write
 *   translation of the policy.
 * @param extraRoots - the additional canonical writable roots to grant.
 * @returns the confined result with the extra grants spliced in.
 */
export function augmentConfinedArgv(confined, extraRoots) {
  const argv = confined.argv;
  const program = argv[0];
  const sepIndex = argv.indexOf("--");
  const at = sepIndex === -1 ? argv.length : sepIndex;
  if (program === "bwrap") {
    const grants = [];
    for (const root of extraRoots) grants.push("--bind", root, root);
    return { ...confined, argv: [...argv.slice(0, at), ...grants, ...argv.slice(at)] };
  }
  if (typeof program === "string" && program.includes("landlock-run")) {
    const grants = [];
    for (const root of extraRoots) grants.push("--rw", root);
    return { ...confined, argv: [...argv.slice(0, at), ...grants, ...argv.slice(at)] };
  }
  if (program === "sandbox-exec") {
    const pIndex = argv.indexOf("-p");
    if (pIndex !== -1 && pIndex + 1 < argv.length) {
      const forms = argv[pIndex + 1];
      const marker = "(allow file-write*";
      const last = forms.lastIndexOf(marker);
      if (last !== -1) {
        const extra = extraRoots.map((root) => `(subpath ${sbplString(root)})`).join(" ");
        const next = `${forms.slice(0, last + marker.length)} ${extra}${forms.slice(last + marker.length)}`;
        const copy = argv.slice();
        copy[pIndex + 1] = next;
        return { ...confined, argv: copy };
      }
    }
  }
  return confined;
}

/**
 * The model-facing policy text for the new mode, phrased like the core
 * `sandbox:policy` contribution so the model reads one consistent voice.
 * @param policy - the resolved policy (mode + workspaceRoot + extraWritableRoots).
 * @returns the context line, exactly as the model sees it.
 */
export function renderSelectedPolicyText(policy) {
  const roots = policy.extraWritableRoots ?? [];
  if (roots.length === 0) {
    return `Current DSH file policy: selected-workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`;
  }
  return `Current DSH file policy: selected-workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)} and the selected directories: ${JSON.stringify(roots)}. Some platform temporary areas may also be writable.`;
}

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target (mirrors the core
 * browse picker's crumbs).
 * @param target - the listed directory.
 * @returns crumb rows `{name, path}`.
 */
export function ancestryCrumbs(target) {
  const crumbs = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current });
    if (parent === current) return crumbs;
    current = parent;
  }
}

/**
 * One-level host-side directory listing (the fallback when the composition
 * serves the NATIVE directory-picker capability instead of `browse`, so
 * `host.listDirectory` is unavailable). Directories only, symlinks followed
 * to directories, bounded by `maxEntries` with the truncation flag set when
 * the level was cut.
 * @param path - the directory to list.
 * @param options - `{ maxEntries, opendir, stat }` seams (defaults for tests).
 * @returns `{ path, home, crumbs, entries, truncated }`, the same wire shape
 *   as the browse capability.
 */
export async function listDirectoryLevel(path, options = {}) {
  const { opendir, stat, maxEntries = MAX_LISTING_ENTRIES } = options;
  const opendirFn = opendir ?? (await import("node:fs/promises")).opendir;
  const statFn = stat ?? (await import("node:fs/promises")).stat;
  const home = process.platform === "win32" ? (process.env.USERPROFILE ?? "") : "/";
  const entries = [];
  let truncated = false;
  let handle;
  try {
    handle = await opendirFn(path);
    for await (const dirent of handle) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      let enterable = dirent.isDirectory();
      if (!enterable) {
        try {
          enterable = (await statFn(join(path, dirent.name))).isDirectory();
        } catch {
          continue;
        }
      }
      if (!enterable) continue;
      entries.push({ name: dirent.name, path: join(path, dirent.name), hidden: dirent.name.startsWith(".") });
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (handle !== void 0) {
      try {
        await handle.close();
      } catch {
        /* listing is best-effort; a close failure is not worth surfacing */
      }
    }
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { path, home, crumbs: ancestryCrumbs(path), entries, truncated };
}

/**
 * Build the writable-root allow-list for the new mode WITHOUT the dsh-sandbox
 * import: the workspace root plus the platform temp areas, canonicalized and
 * deduplicated — the same set the core `writableRoots` derives for
 * `workspace-write`. Kept here so tests cover the exact set the fs fence
 * checks.
 * @param workspaceRoot - the resolved policy workspace root.
 * @returns the canonical writable roots (workspace + temp areas).
 */
export function workspaceWritableRoots(workspaceRoot) {
  return [...new Set([workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))];
}
