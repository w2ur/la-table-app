import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { isEntry } from "../src/cli/entry.ts";

/**
 * The account values the self-hosting guides (GUIDES) tell a deployer to replace, read from their tables (each between
 * `<!-- replace-values -->` and `<!-- /replace-values -->`, one per language and guide), and where they sit.
 *
 * `node scripts/self-hosting-values.ts` checks the guides against the tree: every table of every guide lists the same
 * values and files as the first guide's first table, every file exists, and every value is in every file a guide names
 * (exit 0; 1 on a finding; 2 when a guide or its tables cannot be read). Run it after changing one of those values in
 * this repository.
 *
 * `node scripts/self-hosting-values.ts --remaining` is the deployer's: it lists each value still in a file it should
 * have left (exit 1 while any is, 0 once none is).
 */

export type Row = { line: number; value: string; files: string[] };

/** The guides that list the values, the first one the reference the others must agree with. */
export const GUIDES = ["SELF-HOSTING.md", "SELF-HOSTING-BEGINNER.md"] as const;

const OPEN = "<!-- replace-values -->";
const CLOSE = "<!-- /replace-values -->";

/** The guide's tables, each a list of rows; a row is `| what | \`value\` | \`file\`, \`file\` |`. Null when a table is left open or holds an unreadable row. */
export function valueTables(guide: string): Row[][] | null {
  const tables: Row[][] = [];
  let current: Row[] | null = null;
  let header = false;
  const lines = guide.split("\n");
  for (const [i, raw] of lines.entries()) {
    const text = raw.trim();
    if (text === OPEN) { if (current) return null; current = []; header = true; continue; }
    if (text === CLOSE) { if (!current) return null; tables.push(current); current = null; continue; }
    if (!current || !text.startsWith("|")) continue;
    const cells = text.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (header) { header = false; continue; } // each table's first row names its columns
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // the separator under it
    if (cells.length !== 3) return null;
    const value = /^`([^`]+)`$/.exec(cells[1]!)?.[1];
    if (value === undefined) return null;
    const files = cells[2]!.split(",").map((f) => /^`([^`]+)`$/.exec(f.trim())?.[1]);
    if (files.length === 0 || files.some((f) => f === undefined)) return null;
    current.push({ line: i + 1, value, files: files as string[] });
  }
  return current ? null : tables;
}

const key = (rows: Row[]) => rows.map((r) => `${r.value} → ${[...r.files].sort().join(", ")}`).sort().join("\n");

/**
 * Why a guide's tables do not match the tree at `root`: empty when every value is in every file it names and every
 * table lists what `reference` does (by default the guide's own first table; another guide's to compare two guides).
 */
export function valueProblems(root: string, tables: Row[][], reference: Row[] | undefined = tables[0]): string[] {
  if (tables.length === 0 || tables.some((t) => t.length === 0) || !reference?.length) return ["no table of values to replace, or an empty one"];
  const problems: string[] = [];
  const against = reference === tables[0] ? "table 1" : "the reference table";
  for (const [n, t] of tables.entries()) if (key(t) !== key(reference)) problems.push(`table ${n + 1} does not list the same values and files as ${against}`);
  for (const t of tables) {
    for (const r of t) {
      for (const f of r.files) {
        const path = join(root, f);
        if (!existsSync(path)) problems.push(`line ${r.line}: ${f} does not exist`);
        else if (!readFileSync(path, "utf8").includes(r.value)) problems.push(`line ${r.line}: ${r.value} is not in ${f}`);
      }
    }
  }
  return problems;
}

/** Each value still in a file the guide names, once per (value, file). */
export function remaining(root: string, tables: Row[][]): string[] {
  const out = new Set<string>();
  for (const r of tables.flat()) {
    for (const f of r.files) {
      const path = join(root, f);
      if (existsSync(path) && readFileSync(path, "utf8").includes(r.value)) out.add(`${f}: ${r.value}`);
    }
  }
  return [...out];
}

if (isEntry(import.meta.url, argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const guides: { name: string; tables: Row[][] }[] = [];
  for (const name of GUIDES) {
    let guide: string;
    try { guide = readFileSync(join(root, name), "utf8"); } catch (e) {
      console.error(`${name} unreadable: ${(e as Error).message}`);
      process.exit(2);
    }
    const tables = valueTables(guide);
    if (tables === null) { console.error(`${name}: a table of values is left open or holds an unreadable row`); process.exit(2); }
    guides.push({ name, tables });
  }
  if (argv.includes("--remaining")) {
    const left = remaining(root, guides.flatMap((g) => g.tables));
    for (const l of left) console.log(`still to replace: ${l}`);
    console.log(left.length === 0 ? "every value replaced" : `${left.length} left`);
    process.exit(left.length === 0 ? 0 : 1);
  }
  const reference = guides[0]!.tables[0];
  const problems = guides.flatMap((g) => valueProblems(root, g.tables, reference).map((p) => `${g.name}: ${p}`));
  for (const p of problems) console.error(p);
  console.log(problems.length === 0 ? `values: ${reference!.length} found where ${GUIDES.join(" and ")} say` : `values: ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}
