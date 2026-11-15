import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { isEntry } from "../src/cli/entry.ts";
import { repoFiles, SKIP_DIRS } from "./repo-files.ts";

/**
 * Finds, in a tree's Markdown files, every link and every backticked repository path that points at a file the tree
 * does not hold, and every bare capitalised Markdown name in prose (`CLAUDE.md` written without backticks) that names
 * no file anywhere in the tree. Run it on the public export (`node scripts/check-export-links.ts <dir>`): a file the
 * mirror leaves out (CLAUDE.md, the publisher) must not stay named in a doc that ships. Exit 0 when clean, 1 on a
 * finding, 2 when it could not run.
 *
 * A backticked path is checked when its first segment is a top-level name of the tree, of the private repository (the
 * folder above this script: `.github/workflows/pr-gate.yml` names a folder the export lacks entirely, and
 * `wrangler.prod.jsonc` a lowercase root file), or starts with a dot. Reference-style definitions (`[ref]: path`), titled
 * inline links (`[t](path "title")`) and HTML `<a href>` are links. A backticked bare name the private root does not
 * hold (`SKILL.md`) counts as present when any file in the tree has it, as in prose.
 */

/** Paths that exist only after a build, a run or a setup step, so an absence proves nothing. */
const GENERATED = [/^dist(-demo)?(\/|$)/, /^node_modules(\/|$)/, /^\.wrangler(\/|$)/, /^backups(\/|$)/, /^data\/ciqual(\/|$)/, /^\.dev\.vars$/, /^\.env/];

export type Dangling = { file: string; line: number; target: string };

/** A token's first segment that names a repository root entry, so its absence in the tree is a finding. */
function isRootName(name: string, top: Set<string>, privateTop: Set<string>): boolean {
  return top.has(name) || privateTop.has(name) || (name.startsWith(".") && name !== "." && name !== "..");
}

/** `privateTop`: the top-level names of the private repository, whose absence from the tree is a finding. */
export function dangling(root: string, privateTop: Set<string> = new Set()): Dangling[] {
  const top = new Set(readdirSync(root));
  const files = [...repoFiles(root)];
  const basenames = new Set(files.map((path) => basename(path)));
  const out: Dangling[] = [];
  for (const path of files.filter((p) => p.endsWith(".md"))) {
    const file = relative(root, path).split("\\").join("/");
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((text, i) => {
        const miss = (target: string) => out.push({ file, line: i + 1, target });
        // An inline link: `[t](target)`, `[t](<target>)` or `[t](target "title")`; an HTML `<a href="target">`.
        const linkTargets = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)].map((m) => m[1]!);
        for (const m of text.matchAll(/<a\s[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) linkTargets.push((m[1] ?? m[2])!);
        const definition = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(text);
        if (definition) linkTargets.push(definition[1]!);
        for (const link of linkTargets) {
          const target = link.split("#")[0]!;
          if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // an anchor, or a URL / mailto
          const abs = resolve(dirname(path), target);
          if (!existsSync(abs) && !GENERATED.some((g) => g.test(relative(root, abs).split("\\").join("/")))) miss(target);
        }
        for (const m of text.matchAll(/`([^`\s*{}<>]+)`/g)) {
          const token = m[1]!.replace(/^\.\//, "").replace(/[:#].*$/, "");
          const rooted = token.includes("/")
            ? isRootName(token.split("/")[0]!, top, privateTop)
            : privateTop.has(token) || (/^[\w.-]+\.(md|ts|tsx|json|jsonc|toml|sql|sh|yml|yaml)$/.test(token) && /^[A-Z]/.test(token));
          if (!rooted || GENERATED.some((g) => g.test(token))) continue;
          // A bare name the private root does not hold (`SKILL.md`) no more says which directory it means than prose
          // does: a file of that name anywhere in the tree counts, as below.
          const bare = !token.includes("/") && !privateTop.has(token);
          if (bare ? !basenames.has(token) : !existsSync(join(root, token))) miss(token);
        }
        // Prose: a bare name such as "the repo's CLAUDE.md", once links and code spans are set aside. A file of that
        // name anywhere in the tree (SKILL.md, README.md) counts as present: prose does not say which directory it means.
        const prose = (definition ? "" : text).replace(/`[^`]*`/g, " ").replace(/<[^>]*>/g, " ").replace(/\[[^\]]*\]\([^)]*\)/g, " ");
        for (const m of prose.matchAll(/(?<![\w./-])([A-Z][A-Za-z0-9_-]*\.md)(?![\w/-])/g)) {
          if (!basenames.has(m[1]!)) miss(m[1]!);
        }
      });
  }
  return out;
}

/**
 * The command: 0 clean, 1 a dangling reference, 2 could not run (no such directory, a tree or repository it cannot
 * read). A tree it could not walk proves nothing either way, so it is never reported as clean or as a finding.
 */
export function main(dir: string | undefined, repo: string): number {
  let found: Dangling[];
  try {
    const root = resolve(dir ?? ".");
    if (!statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
    const privateTop = new Set(readdirSync(repo).filter((name) => !SKIP_DIRS.has(name) && !GENERATED.some((g) => g.test(name))));
    found = dangling(root, privateTop);
  } catch (error: unknown) {
    console.error(`links: could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  for (const f of found) console.error(`${f.file}:${f.line}: ${f.target} is not in the tree`);
  console.log(found.length === 0 ? "links: clean" : `links: ${found.length} dangling`);
  return found.length === 0 ? 0 : 1;
}

if (isEntry(import.meta.url)) process.exit(main(argv[2], resolve(dirname(fileURLToPath(import.meta.url)), "..")));
