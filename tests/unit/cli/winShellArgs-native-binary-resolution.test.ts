import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

import { resolveNativeWindowsBinary } from "../../../bin/cli/utils/winShellArgs.mjs";

// resolveNativeWindowsBinary() only matters on win32 (it mirrors cmd.exe's own
// PATH + PATHEXT resolution order), but its logic is pure string/fs work, so
// it can and should run cross-platform in CI -- the fs layout it walks is
// entirely synthetic via the envOverride test seam.

function withTempDirs(count, fn) {
  const dirs = Array.from({ length: count }, () => mkdtempSync(join(tmpdir(), "winbin-")));
  try {
    return fn(...dirs);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveNativeWindowsBinary: finds a bare .exe on PATH", () => {
  withTempDirs(1, (dir) => {
    writeFileSync(join(dir, "codex.exe"), "");
    const result = resolveNativeWindowsBinary("codex", { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(result, join(dir, "codex.exe"));
  });
});

test("resolveNativeWindowsBinary: returns undefined for a .cmd shim (stays on the shell path)", () => {
  withTempDirs(1, (dir) => {
    writeFileSync(join(dir, "codex.cmd"), "");
    const result = resolveNativeWindowsBinary("codex", { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(result, undefined);
  });
});

test("resolveNativeWindowsBinary: returns undefined for a .bat shim", () => {
  withTempDirs(1, (dir) => {
    writeFileSync(join(dir, "codex.bat"), "");
    const result = resolveNativeWindowsBinary("codex", { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(result, undefined);
  });
});

test("resolveNativeWindowsBinary: returns undefined when nothing matches", () => {
  withTempDirs(1, (dir) => {
    const result = resolveNativeWindowsBinary("codex", { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(result, undefined);
  });
});

test("resolveNativeWindowsBinary: PATHEXT order wins within one directory (.exe before .cmd)", () => {
  withTempDirs(1, (dir) => {
    writeFileSync(join(dir, "codex.cmd"), "");
    writeFileSync(join(dir, "codex.exe"), "");
    const result = resolveNativeWindowsBinary("codex", { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(result, join(dir, "codex.exe"), "default PATHEXT puts .EXE before .CMD");
  });
});

test("resolveNativeWindowsBinary: PATH directory order wins over extension order across dirs", () => {
  withTempDirs(2, (dirA, dirB) => {
    // dirA (earlier on PATH) only has the shim; dirB (later) has the native exe.
    // cmd.exe resolves per-directory (all extensions) before moving to the next
    // directory, so the shim in dirA must win even though .EXE outranks .CMD.
    writeFileSync(join(dirA, "codex.cmd"), "");
    writeFileSync(join(dirB, "codex.exe"), "");
    const result = resolveNativeWindowsBinary("codex", {
      path: `${dirA}${delimiter}${dirB}`,
      pathExt: ".COM;.EXE;.BAT;.CMD",
    });
    assert.equal(result, undefined, "the earlier directory's .cmd shim wins the search, not the later .exe");
  });
});

test("resolveNativeWindowsBinary: an unusual PATHEXT entry (.ps1) is treated as non-native", () => {
  withTempDirs(1, (dir) => {
    writeFileSync(join(dir, "codex.ps1"), "");
    const result = resolveNativeWindowsBinary("codex", { path: dir, pathExt: ".PS1;.EXE" });
    assert.equal(result, undefined);
  });
});
