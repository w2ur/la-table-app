import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository's shipped files, found by walking the filesystem, never `git ls-files`, so the tests that use it also
 * run in a `git archive` export with no `.git`.
 */

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-demo", ".wrangler", "backups", "playwright-report", "test-results"]);
/** Gitignored and never shipped, but kept beside the code (per-agent memory). */
export const SKIP_PATHS = new Set([".claude/agent-memory"]);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHER = "scripts/publish-public.sh";
const PUBLISHER_CONF = "scripts/publish-public.conf";

/**
 * What scripts/publish-public.sh always leaves out of the export, read from the script itself (its `EXCLUDES+=( … )`
 * block, `"$ALLOWLIST"` being the conf's `binary-allowlist`), so this list cannot drift from the publisher's: the
 * script, its test, its conf, its `.d` folder and the binary allowlist. They carry the leak patterns themselves, the
 * owner's handle and the session-trailer pattern included. A tree without the publisher (the public mirror) holds
 * none of them: nothing to skip. A publisher present but unreadable as expected throws, rather than skip nothing.
 */
export function publisherExcluded(repo: string = REPO): Set<string> {
  if (!existsSync(join(repo, PUBLISHER))) return new Set();
  const script = readFileSync(join(repo, PUBLISHER), "utf8");
  const blocks = [...script.matchAll(/^EXCLUDES\+=\(\n([\s\S]*?)\n\)$/gm)];
  if (blocks.length !== 1) throw new Error(`${PUBLISHER}: expected one EXCLUDES+=( … ) block, found ${blocks.length}`);
  const allowlist = /^binary-allowlist (\S+)$/m.exec(readFileSync(join(repo, PUBLISHER_CONF), "utf8"))?.[1];
  const paths = blocks[0]![1]!.split("\n").map((line) => {
    const value = /^\s*"([^"]+)"\s*$/.exec(line)?.[1];
    if (value === undefined) throw new Error(`${PUBLISHER}: unexpected line in the EXCLUDES block: ${line}`);
    if (value !== "$ALLOWLIST") return value;
    if (allowlist === undefined) throw new Error(`${PUBLISHER_CONF}: no binary-allowlist`);
    return allowlist;
  });
  if (!paths.includes(PUBLISHER)) throw new Error(`${PUBLISHER}: its EXCLUDES block does not name the script itself`);
  return new Set(paths);
}

/** Every path the publisher always excludes, files and folders alike (`scripts/publish-public.d`). */
export const SKIP_PUBLISHER = publisherExcluded();

/** Every file under `root` but the skipped ones: the walker the repository's checks share. */
export function* repoFiles(root: string, dir = root): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).split("\\").join("/");
    if (SKIP_PUBLISHER.has(rel)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(rel)) yield* repoFiles(root, path);
    } else if (entry.isFile() && entry.name !== ".git") yield path; // a worktree's .git is a file naming its gitdir
  }
}

/** The text files among them: a NUL byte means binary, no prose in it. */
export function* textFiles(root: string): Generator<string> {
  for (const path of repoFiles(root)) if (!readFileSync(path).includes(0)) yield path;
}
