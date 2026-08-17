// Unit tests for the dependency-free helpers in lib/core.js.
// Run with: node --test test/core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  MODE,
  SELECTION_EVENT,
  ancestryCrumbs,
  augmentConfinedArgv,
  canonicalPath,
  isLexicallyUnder,
  isPathUnder,
  listDirectoryLevel,
  normalizeRoots,
  renderSelectedPolicyText,
  selectedRootsOf,
  selectionOf,
  tempWritableRoots,
  workspaceWritableRoots,
} from "../lib/core.js";

test("MODE and SELECTION_EVENT are the plugin vocabulary", () => {
  assert.equal(MODE, "selected-workspace-write");
  assert.equal(SELECTION_EVENT, "workspace-scope/selection");
});

test("selectionOf folds the whole scope (roots + workspace) last-wins", () => {
  const events = [
    { type: SELECTION_EVENT, data: { roots: ["/a"], workspace: false } },
    { type: "turn/start", data: {} },
    { type: SELECTION_EVENT, data: { roots: ["/c"] } },
  ];
  assert.deepEqual(selectionOf(events), { roots: ["/c"], workspace: true });
  assert.deepEqual(
    selectionOf([{ type: SELECTION_EVENT, data: { roots: ["/x"], workspace: false } }]),
    { roots: ["/x"], workspace: false },
  );
  assert.deepEqual(selectionOf([{ type: "turn/end", data: {} }]), { roots: [], workspace: true });
  assert.deepEqual(selectionOf([]), { roots: [], workspace: true });
  // Legacy events without the workspace field stay workspace-writable.
  assert.deepEqual(
    selectionOf([{ type: SELECTION_EVENT, data: { roots: ["/y"] } }]),
    { roots: ["/y"], workspace: true },
  );
  assert.deepEqual(selectionOf([{ type: SELECTION_EVENT, data: { roots: "nope" } }]), { roots: [], workspace: true });
});

test("selectedRootsOf folds last-wins over the log", () => {
  const events = [
    { type: "sandbox/mode", data: { mode: "workspace-write" } },
    { type: SELECTION_EVENT, data: { roots: ["/a", "/b"] } },
    { type: "turn/start", data: {} },
    { type: SELECTION_EVENT, data: { roots: ["/c"] } },
  ];
  assert.deepEqual(selectedRootsOf(events), ["/c"]);
  assert.deepEqual(selectedRootsOf([{ type: SELECTION_EVENT, data: { roots: ["/x"] } }]), ["/x"]);
  assert.deepEqual(selectedRootsOf([{ type: "turn/end", data: {} }]), []);
  assert.deepEqual(selectedRootsOf([]), []);
  // A malformed payload degrades to no selection, never a crash.
  assert.deepEqual(selectedRootsOf([{ type: SELECTION_EVENT, data: { roots: "nope" } }]), []);
});

test("normalizeRoots validates, canonicalizes, dedupes, sorts", () => {
  const canonical = (path) => (path === "/a" ? "/resolved-a" : path);
  assert.deepEqual(normalizeRoots(["/b", "/a", "/a"], canonical), ["/b", "/resolved-a"]);
  assert.deepEqual(normalizeRoots([], canonical), []);
  assert.throws(() => normalizeRoots("nope"), /expects a JSON array/);
  assert.throws(() => normalizeRoots(["/ok", "relative"]), /not an absolute directory path/);
  assert.throws(() => normalizeRoots(["/ok", 42]), /not an absolute directory path/);
  assert.throws(() => normalizeRoots(["/ok", ""]), /not an absolute directory path/);
  const many = [];
  for (let index = 0; index < 200; index += 1) many.push(`/dir-${index}`);
  assert.throws(() => normalizeRoots(many), /at most 128/);
});

test("isLexicallyUnder covers equality and separator-aware descendants", () => {
  assert.equal(isLexicallyUnder("/ws/a", "/ws"), true);
  assert.equal(isLexicallyUnder("/ws", "/ws"), true);
  assert.equal(isLexicallyUnder("/ws-other", "/ws"), false);
  assert.equal(isLexicallyUnder("/ws/a", "/ws/sub"), false);
  if (process.platform === "win32") {
    assert.equal(isLexicallyUnder("C:\\ws\\a", "C:\\ws", false), true);
    assert.equal(isLexicallyUnder("C:\\ws-other", "C:\\ws", false), false);
  }
});

test("isPathUnder falls back to filesystem identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wss-test-"));
  try {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const target = join(sub, "file.txt");
    writeFileSync(target, "x");
    assert.equal(await isPathUnder(target, dir), true);
    assert.equal(await isPathUnder(join(dir, "sub", "missing", "deep"), dir), true);
    assert.equal(await isPathUnder(join(dir, "nonexistent"), join(dir, "nope")), false);
    // Windows-alias style: identical identity via a different spelling.
    const fakeStat = async () => ({ dev: 7n, ino: 42n });
    assert.equal(await isPathUnder("/alias/sub", "/real", false, fakeStat), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspaceWritableRoots contains the workspace and the temp areas", () => {
  const roots = workspaceWritableRoots("/ws");
  assert.ok(roots.includes(canonicalPath("/ws")));
  assert.ok(roots.includes("/tmp"));
  assert.ok(roots.includes(canonicalPath(tmpdir())));
  assert.equal(new Set(roots).size, roots.length);
});

test("tempWritableRoots excludes the workspace", () => {
  const roots = tempWritableRoots();
  assert.ok(roots.includes("/tmp"));
  assert.ok(roots.includes(canonicalPath(tmpdir())));
  assert.ok(!roots.includes(canonicalPath("/ws")));
  assert.equal(new Set(roots).size, roots.length);
});

test("renderSelectedPolicyText names the roots only when present", () => {
  const empty = renderSelectedPolicyText({ mode: MODE, workspaceRoot: "/ws", extraWritableRoots: [] });
  assert.match(empty, /selected-workspace-write/);
  assert.match(empty, /"\/ws"/);
  assert.doesNotMatch(empty, /selected directories/);
  const withRoots = renderSelectedPolicyText({ mode: MODE, workspaceRoot: "/ws", extraWritableRoots: ["/data", "/notes"] });
  assert.match(withRoots, /\[\"\/data\",\"\/notes\"\]/);
  // Workspace excluded from the selection: it is named as read-only.
  const offEmpty = renderSelectedPolicyText({ mode: MODE, workspaceRoot: "/ws", extraWritableRoots: [], workspaceWritable: false });
  assert.match(offEmpty, /read-only/);
  const offWithRoots = renderSelectedPolicyText({ mode: MODE, workspaceRoot: "/ws", extraWritableRoots: ["/data"], workspaceWritable: false });
  assert.match(offWithRoots, /\[\"\/data\"\]/);
  assert.match(offWithRoots, /read-only/);
  assert.doesNotMatch(offWithRoots, /under the session workspace/);
});

test("augmentConfinedArgv splices grants per dialect", () => {
  const base = { enforcement: "full", denialSignatures: ["read-only file system"], runnerFailureRules: [] };

  const bwrap = augmentConfinedArgv(
    { ...base, argv: ["bwrap", "--ro-bind", "/", "/", "--bind", "/ws", "/ws", "--", "bash", "-c", "x"] },
    ["/data", "/notes"],
  );
  assert.deepEqual(bwrap.argv, [
    "bwrap", "--ro-bind", "/", "/", "--bind", "/ws", "/ws",
    "--bind", "/data", "/data", "--bind", "/notes", "/notes",
    "--", "bash", "-c", "x",
  ]);

  const landlock = augmentConfinedArgv(
    { ...base, argv: ["/opt/landlock-run", "--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", "/ws", "--", "bash", "-c", "x"] },
    ["/data"],
  );
  assert.deepEqual(landlock.argv, [
    "/opt/landlock-run", "--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", "/ws",
    "--rw", "/data",
    "--", "bash", "-c", "x",
  ]);

  const seatbelt = augmentConfinedArgv(
    { ...base, argv: ["sandbox-exec", "-p", '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))(allow file-write* (subpath "/tmp") (subpath "/ws"))', "--", "bash", "-c", "x"] },
    ["/data"],
  );
  assert.equal(seatbelt.argv[2], '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))(allow file-write* (subpath "/data") (subpath "/tmp") (subpath "/ws"))');

  // Unknown dialect (custom runnerCommand / Windows ACL): unchanged, fail closed.
  const unknown = augmentConfinedArgv(
    { ...base, argv: ["my-runner", "--flag", "--", "bash", "-c", "x"] },
    ["/data"],
  );
  assert.deepEqual(unknown.argv, ["my-runner", "--flag", "--", "bash", "-c", "x"]);

  // No separator: grants append at the end.
  const noSep = augmentConfinedArgv({ ...base, argv: ["bwrap", "--ro-bind", "/", "/"] }, ["/data"]);
  assert.deepEqual(noSep.argv, ["bwrap", "--ro-bind", "/", "/", "--bind", "/data", "/data"]);

  // Workspace excluded (read-only base): temp areas + extra roots granted.
  const offBwrap = augmentConfinedArgv(
    { ...base, argv: ["bwrap", "--ro-bind", "/", "/", "--", "bash", "-c", "x"] },
    ["/data"],
    ["/tmp"],
  );
  assert.deepEqual(offBwrap.argv, [
    "bwrap", "--ro-bind", "/", "/",
    "--tmpfs", "/tmp", "--bind", "/data", "/data",
    "--", "bash", "-c", "x",
  ]);
  const offLandlock = augmentConfinedArgv(
    { ...base, argv: ["/opt/landlock-run", "--ro", "/", "--rw", "/dev/null", "--", "bash", "-c", "x"] },
    ["/data"],
    ["/tmp"],
  );
  assert.deepEqual(offLandlock.argv, [
    "/opt/landlock-run", "--ro", "/", "--rw", "/dev/null",
    "--rw", "/tmp", "--rw", "/data",
    "--", "bash", "-c", "x",
  ]);
  const offSeatbelt = augmentConfinedArgv(
    { ...base, argv: ["sandbox-exec", "-p", '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))', "--", "bash", "-c", "x"] },
    ["/data"],
    ["/tmp"],
  );
  assert.equal(offSeatbelt.argv[2], '(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "/tmp") (subpath "/data") (literal "/dev/null"))');
});

test("ancestryCrumbs walks to the filesystem root", () => {
  const crumbs = ancestryCrumbs("/ws/sub/deep");
  assert.equal(crumbs.length >= 4, true);
  assert.equal(crumbs[crumbs.length - 1].path, "/ws/sub/deep");
  assert.equal(crumbs[0].path, "/");
});

test("listDirectoryLevel lists one level with truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wss-list-"));
  try {
    mkdirSync(join(dir, "b-dir"));
    mkdirSync(join(dir, "a-dir"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, "file.txt"), "x");
    const listing = await listDirectoryLevel(dir, { maxEntries: 100 });
    assert.equal(listing.path, dir);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      [".hidden", "a-dir", "b-dir"],
    );
    assert.equal(listing.truncated, false);
    assert.ok(listing.crumbs.length >= 1);
    const truncated = await listDirectoryLevel(dir, { maxEntries: 1 });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
