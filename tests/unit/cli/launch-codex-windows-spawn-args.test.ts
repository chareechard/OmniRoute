import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildCodexProviderArgs,
  quoteCodexArgs,
  resolveCodexSpawn,
  resolveCodexSpawnPlan,
} from "../../../bin/cli/commands/launch-codex.mjs";

const isWindows = process.platform === "win32";

// Regression guard: on Windows an npm-installed `codex` is a `.cmd` shim that
// spawn() cannot resolve without a shell (bare "codex" -> ENOENT when shell is
// undefined). A native/standalone Codex CLI install instead places a bare
// `codex.exe` on PATH with no `.cmd` shim at all, so the command must NOT be
// hardcoded to "codex.cmd" -- shell: true lets cmd.exe's normal PATHEXT
// resolution find whichever one is actually installed.
test("resolveCodexSpawn: win32 spawns bare codex through a shell (PATHEXT resolves .cmd or .exe)", () => {
  const { command, shell } = resolveCodexSpawn("win32");
  assert.equal(command, "codex");
  assert.equal(shell, true);
});

test("resolveCodexSpawn: non-Windows platforms spawn the bare binary without a shell", () => {
  for (const platform of ["linux", "darwin", "freebsd"]) {
    const { command, shell } = resolveCodexSpawn(platform);
    assert.equal(command, "codex", `${platform} command`);
    assert.equal(shell, undefined, `${platform} shell`);
  }
});

test("quoteCodexArgs leaves argv untouched off Windows (no shell, no quoting)", () => {
  const args = [...buildCodexProviderArgs("http://localhost:20128"), "explain this repo"];
  assert.deepEqual(quoteCodexArgs(args, "linux"), args);
});

// The injected provider flags are the reason this bug bit every Windows
// invocation, not just the ones with a multi-word user argument: their TOML
// values are quoted, and cmd.exe eats those quotes when the line is unescaped.
test("quoteCodexArgs escapes the injected -c provider flags on win32", () => {
  const input = buildCodexProviderArgs("http://localhost:20128");
  const quoted = quoteCodexArgs(input, "win32");
  assert.equal(quoted.length, input.length);
  for (const [i, arg] of quoted.entries()) {
    assert.notEqual(arg, input[i], `argument ${i} must be escaped`);
    assert.match(arg, /"/, `argument ${i} must be quoted`);
  }
});

// The cmd.exe round-trip below is the real proof, but it can only run on
// Windows. These golden strings pin the exact encoding so CI (Linux) still
// fails if the escaping changes — e.g. if the double caret-escape required by
// the `.cmd` shim's %* re-parse is ever reduced back to a single pass.
test("quoteCodexArgs: exact win32 encoding (golden)", () => {
  const golden: Array<[string, string]> = [
    ["-c", '^^^"-c^^^"'],
    [
      'model_providers.omniroute.base_url="http://localhost:20128/v1"',
      '^^^"model_providers.omniroute.base_url=\\^^^"http://localhost:20128/v1\\^^^"^^^"',
    ],
    [
      "model_providers.omniroute.requires_openai_auth=false",
      '^^^"model_providers.omniroute.requires_openai_auth=false^^^"',
    ],
    ["fix the bug & ship it", '^^^"fix^^^ the^^^ bug^^^ ^^^&^^^ ship^^^ it^^^"'],
    ["", '""'],
  ];
  for (const [input, expected] of golden) {
    assert.equal(
      quoteCodexArgs([input], "win32")[0],
      expected,
      `encoding of ${JSON.stringify(input)}`
    );
  }
});

test("quoteCodexArgs does not mutate the caller's array", () => {
  const input = ["-c", "model_provider=\"omniroute\""];
  quoteCodexArgs(input, "win32");
  assert.deepEqual(input, ["-c", 'model_provider="omniroute"']);
});

// The real contract: whatever we hand to spawn(shell:true) must arrive at the
// child's argv byte-identical. Verified against a probe .cmd through the same
// cmd.exe path the launcher uses.
test(
  "quoteCodexArgs survives a real cmd.exe round-trip",
  { skip: isWindows ? false : "windows-only: exercises the cmd.exe shell path" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-codex-argv-"));
    try {
      // Mirror the real shape of `codex.cmd`: an npm .cmd shim forwarding %*
      // to a node script. Printing argv as JSON keeps the oracle exact.
      writeFileSync(join(dir, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
      const probe = join(dir, "probe.cmd");
      writeFileSync(probe, ["@echo off", 'node "%~dp0argv.mjs" %*'].join("\r\n") + "\r\n");

      const args = [
        ...buildCodexProviderArgs("http://localhost:20128"),
        "--profile",
        "auto-best-coding",
        "In one short line: say BANANA",
        'quotes " and & ampersands | pipes',
        "percent %PATH% and caret ^ and bang !",
        "trailing backslash \\",
        "",
      ];

      const received = await new Promise<string[]>((resolve, reject) => {
        const child = spawn(probe, quoteCodexArgs(args, "win32"), {
          shell: true,
          windowsHide: true,
        });
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.on("error", reject);
        child.on("exit", () => {
          try {
            resolve(JSON.parse(out.trim().split(/\r?\n/).pop() ?? "[]"));
          } catch (err) {
            reject(new Error(`probe did not emit argv JSON: ${out}`, { cause: err }));
          }
        });
      });

      assert.deepEqual(received, args, "child argv must match what the caller passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

// Bug found while validating the .cmd -> bare-command fix above: winShellArgs'
// double caret-escaping assumes the target is ALWAYS an npm .cmd shim (two
// cmd.exe parses). A native/standalone codex.exe install is only ONE parse
// (cmd.exe hands the line straight to CreateProcess), so that same escaping
// leaves literal stray carets in the args codex receives -- reproduced live
// against node.exe: `error: unexpected argument '^model_provider=\^omniroute\^^'`.
// resolveCodexSpawnPlan() is the fix: resolve "codex" via PATH first, and only
// take the shell:true/escaped path when it actually resolves to a .cmd/.bat.
test("resolveCodexSpawnPlan: falls back to the shell path when codex isn't a native exe", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-plan-fallback-"));
  try {
    // empty dir on PATH: resolveNativeWindowsBinary finds nothing native.
    const args = buildCodexProviderArgs("http://localhost:20128");
    const plan = resolveCodexSpawnPlan(args, "win32", { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(plan.command, "codex");
    assert.equal(plan.shell, true);
    assert.deepEqual(plan.args, quoteCodexArgs(args, "win32"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCodexSpawnPlan: takes the direct no-shell path when codex is a native exe", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-plan-native-"));
  try {
    writeFileSync(join(dir, "codex.exe"), "");
    const args = buildCodexProviderArgs("http://localhost:20128");
    const plan = resolveCodexSpawnPlan(args, "win32", { path: dir, pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(plan.command, join(dir, "codex.exe"));
    assert.equal(plan.shell, false);
    assert.deepEqual(plan.args, args, "raw argv, untouched by any cmd.exe escaping");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCodexSpawnPlan: non-Windows platforms never take the native-exe path", () => {
  const args = buildCodexProviderArgs("http://localhost:20128");
  for (const platform of ["linux", "darwin"]) {
    const plan = resolveCodexSpawnPlan(args, platform);
    assert.equal(plan.command, "codex");
    assert.equal(plan.shell, undefined);
    assert.deepEqual(plan.args, args);
  }
});

// The real contract for the native-exe path: args reach the child completely
// unescaped (no shell involved at all), proving the over-escaping bug is gone.
// The node binary itself, copied to "codex.exe", stands in for a real
// standalone codex install -- both are plain native Windows binaries resolved
// via PATH, which is the only thing resolveCodexSpawnPlan cares about.
test(
  "resolveCodexSpawnPlan: native-exe path delivers argv byte-identical (no cmd.exe involved)",
  { skip: isWindows ? false : "windows-only: exercises the native-exe spawn path" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-codex-native-argv-"));
    try {
      writeFileSync(join(dir, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(1)));\n");
      copyFileSync(process.execPath, join(dir, "codex.exe"));

      const args = [
        join(dir, "argv.mjs"),
        ...buildCodexProviderArgs("http://localhost:20128"),
        "--profile",
        "auto-best-coding",
        'quotes " and & ampersands | pipes',
        "percent %PATH% and caret ^ and bang !",
      ];

      const plan = resolveCodexSpawnPlan(args, "win32", {
        path: dir,
        pathExt: ".COM;.EXE;.BAT;.CMD",
      });
      assert.equal(plan.shell, false, "must take the no-shell native path for this probe");

      const received = await new Promise<string[]>((resolve, reject) => {
        const child = spawn(plan.command, plan.args, { shell: plan.shell, windowsHide: true });
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.on("error", reject);
        child.on("exit", () => {
          try {
            resolve(JSON.parse(out.trim().split(/\r?\n/).pop() ?? "[]"));
          } catch (err) {
            reject(new Error(`probe did not emit argv JSON: ${out}`, { cause: err }));
          }
        });
      });

      assert.deepEqual(received, args, "child argv must match what the caller passed, unescaped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
