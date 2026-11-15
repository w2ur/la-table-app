import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The file's canonical path (symlinks resolved, macOS's letter case restored), or null when it cannot be read. */
function canonical(path: string): string | null {
  try { return realpathSync.native(path); } catch { return null; }
}

/**
 * Whether the module at `moduleUrl` is the script node was asked to run (`argv1`, as typed): compared as real paths,
 * so a run through a symlink or in another letter case still runs, rather than doing nothing and exiting 0.
 */
export function isEntry(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  const self = canonical(fileURLToPath(moduleUrl));
  return self !== null && canonical(argv1) === self;
}
