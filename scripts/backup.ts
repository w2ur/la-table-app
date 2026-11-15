import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isEntry } from "../src/cli/entry.ts";

export function backupPath(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return `backups/la-table-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}.sql`;
}

export interface Schema { tables: string[]; indexes: string[]; triggers: string[] }

const NAME = String.raw`["\`\[]?(\w+)["\`\]]?`;
const DDL = new RegExp(
  [
    String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s+ON\s+${NAME}`,
    String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${NAME}`,
    String.raw`DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?${NAME}`,
    String.raw`ALTER\s+TABLE\s+${NAME}\s+RENAME\s+TO\s+${NAME}`,
    String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}[^;]*?\bON\s+${NAME}`,
    String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${NAME}`,
  ].join("|"),
  "gi",
);

/**
 * String literals and SQL comments, scanned in one pass left to right as SQLite does: a `--` inside a block comment,
 * a `/*` inside a line comment, and either inside a quoted value are text, not comments. An unclosed block comment
 * runs to the end of the file. A literal (with `''` escapes) is emptied, so a value naming a table is never read as DDL.
 */
const LITERAL_OR_COMMENT = /'(?:[^']|'')*'|\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*/g;

/** The tables, indexes and triggers the migrations leave, replayed in order: the schema an export of the database must hold. */
export function expectedSchema(migrations: string[]): Schema {
  const tables = new Set<string>();
  const indexes = new Map<string, string>(); // index → its table
  const triggers = new Map<string, string>(); // trigger → its table
  for (const sql of migrations) {
    for (const m of sql.replace(LITERAL_OR_COMMENT, (s) => (s.startsWith("'") ? "''" : "")).matchAll(DDL)) {
      const [, created, index, on, dropped, droppedIndex, from, to, trigger, triggerOn, droppedTrigger] = m;
      if (created) tables.add(created);
      else if (index && on) indexes.set(index, on);
      else if (dropped) {
        tables.delete(dropped);
        for (const [i, t] of indexes) if (t === dropped) indexes.delete(i);
        for (const [g, t] of triggers) if (t === dropped) triggers.delete(g);
      } else if (droppedIndex) indexes.delete(droppedIndex);
      else if (trigger && triggerOn) triggers.set(trigger, triggerOn);
      else if (droppedTrigger) triggers.delete(droppedTrigger);
      else if (from && to) {
        tables.delete(from);
        tables.add(to);
        for (const [i, t] of indexes) if (t === from) indexes.set(i, to);
        for (const [g, t] of triggers) if (t === from) triggers.set(g, to);
      }
    }
  }
  return { tables: [...tables], indexes: [...indexes.keys()], triggers: [...triggers.keys()] };
}

/**
 * What a complete export lacks, or null. `wrangler d1 export` writes each table's CREATE then its rows, and the indexes
 * last: every table, index and trigger of the schema, by exact name, and a final statement that ends, mean the dump ran to
 * its end. That holds only while no row follows an index, so a dump that writes an index before a row fails too rather
 * than verifying on an order the check cannot rely on. Without an index in the schema, a dump cut between two rows of
 * its last table would go unseen.
 */
export function missingFromExport(body: string, schema: Schema): string | null {
  for (const t of schema.tables) {
    if (!new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["\`]?${t}["\`]?\s*\(`, "i").test(body)) return `la table ${t}`;
  }
  for (const i of schema.indexes) {
    if (!new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["\`]?${i}["\`]?\s+ON\b`, "i").test(body)) return `l'index ${i}`;
  }
  for (const g of schema.triggers) {
    if (!new RegExp(String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?["\`]?${g}["\`]?\s`, "i").test(body)) return `le déclencheur ${g}`;
  }
  const firstIndex = body.search(/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/im);
  if (firstIndex >= 0 && /^INSERT\s+INTO\b/im.test(body.slice(firstIndex))) return "les index en fin de dump (une ligne suit un index)";
  if (!body.trimEnd().endsWith(";")) return "la fin du dernier ordre SQL";
  return null;
}

export function runBackup(deps: {
  now: Date;
  migrations: string[];
  exec: (cmd: string, args: string[]) => { status: number | null; stderr: string };
  read: (path: string) => string | null;
  unlink: (path: string) => void;
  rename: (from: string, to: string) => void;
  log: (s: string) => void;
}): number {
  const schema = expectedSchema(deps.migrations);
  // no schema to compare against means nothing can be verified, not that everything is there
  if (schema.tables.length === 0) { deps.log("sauvegarde impossible à vérifier : aucune table dans migrations/"); return 2; }
  const path = backupPath(deps.now);
  const partial = `${path}.partial`;
  deps.unlink(partial);
  const r = deps.exec("npx", ["wrangler", "d1", "export", "la-table", "--remote", "--output", partial]);
  if (r.status !== 0) { deps.log(`sauvegarde impossible (wrangler ${r.status}) : ${r.stderr.trim()}`); return 2; }
  const body = deps.read(partial);
  if (!body) { deps.log(`sauvegarde vide : ${partial}`); return 2; }
  const missing = missingFromExport(body, schema);
  if (missing) { deps.log(`sauvegarde incomplète, il manque ${missing} : ${partial}`); return 2; }
  deps.rename(partial, path);
  deps.log(`sauvegarde : ${path} (${body.length} octets)`);
  return 0;
}

if (isEntry(import.meta.url)) {
  mkdirSync("backups", { recursive: true });
  process.exit(runBackup({
    now: new Date(),
    migrations: readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(`migrations/${f}`, "utf8")),
    exec: (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] }); return { status: r.status, stderr: r.stderr ?? "" }; },
    unlink: (p) => rmSync(p, { force: true }),
    rename: (from, to) => renameSync(from, to),
    read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    log: (s) => console.error(s),
  }));
}
