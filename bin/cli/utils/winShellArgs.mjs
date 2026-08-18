import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Argument escaping for child processes spawned with `shell: true` on Windows.
 *
 * The launchers (`omniroute launch`, `omniroute launch-codex`) must go through
 * cmd.exe on win32 when the target binary is an npm `.cmd`/`.bat` shim, because
 * Node cannot exec those directly (CVE-2024-27980). With `shell: true` Node
 * joins argv with plain spaces and no escaping at all (the DEP0190 warning), so
 * anything with a space, a quote or a cmd metacharacter reaches the child
 * mangled -- hence the double caret-escaping below, needed because the shim
 * forwards `%*` through a SECOND cmd.exe parse.
 *
 * A native/standalone install (`codex.exe`, `claude.exe`, no shim at all) is a
 * different shape: `resolveNativeWindowsBinary()` finds it directly on PATH so
 * callers can spawn it with `shell: false` and the RAW argv -- no shell means
 * no cmd.exe parse at all, so Node's own Windows argv encoding is correct
 * as-is and any of this file's escaping would be one layer too many (it
 * leaves literal stray carets in the args the child receives).
 */

/** cmd.exe metacharacters that stay live inside a quoted argument. */
const WIN_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escape one argument for a cmd.exe command line built by `shell: true`.
 *
 * Two layers, in order:
 *  1. the CRT argv rules the target binary parses (double the backslashes that
 *     precede a quote, escape embedded quotes, wrap in quotes);
 *  2. cmd.exe's metacharacters, caret-escaped — applied TWICE because the
 *     target is an npm `.cmd` shim that forwards `%*` to node, so the line is
 *     parsed by cmd a second time. Single-escaping truncated any argument at
 *     the first `&` or `|`. (Same rule as cross-spawn's doubleEscapeMetaChars.)
 *
 * @param {unknown} arg
 * @returns {string}
 */
export function escapeWindowsShellArg(arg) {
  const s = String(arg);
  if (s === "") return '""';
  let out = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`;
  return out.replace(WIN_META_CHARS, "^$1").replace(WIN_META_CHARS, "^$1");
}

/**
 * Escape a whole argv for the `shell: true` path. Off Windows there is no shell,
 * so argv is passed through untouched.
 *
 * @param {string[]} args
 * @param {NodeJS.Platform|string} platform
 * @returns {string[]}
 */
export function quoteShellArgs(args, platform) {
  const list = [...(args ?? [])];
  return platform === "win32" ? list.map(escapeWindowsShellArg) : list;
}

/** Extensions cmd.exe hands straight to CreateProcess (no nested cmd.exe parse). */
const NATIVE_EXECUTABLE_EXTS = new Set([".com", ".exe"]);

/**
 * Resolve a bare Windows command name to an absolute path, but ONLY when it
 * resolves to a native `.com`/`.exe` binary via the same PATH + PATHEXT search
 * order cmd.exe itself uses (outer loop over PATH dirs, inner loop over
 * PATHEXT, first match wins). Returns `undefined` for anything else -- a
 * `.cmd`/`.bat` npm shim, an unusual PATHEXT entry, or nothing found at all --
 * so those callers stay on the existing `shell: true` + escaped-args path.
 *
 * @param {string} command  bare command name, no extension (e.g. "codex")
 * @param {{ path?: string, pathExt?: string }} [envOverride]  test seam
 * @returns {string|undefined}
 */
export function resolveNativeWindowsBinary(command, envOverride = {}) {
  const pathExt = (envOverride.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const dirs = (envOverride.path ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExt) {
      const lowerExt = ext.toLowerCase();
      const candidate = join(dir, `${command}${lowerExt}`);
      if (existsSync(candidate)) {
        return NATIVE_EXECUTABLE_EXTS.has(lowerExt) ? candidate : undefined;
      }
    }
  }
  return undefined;
}
