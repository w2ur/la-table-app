import { readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../src/cli/entry.ts";
import { expectedSchema, missingFromExport } from "./backup.ts";
import { DATABASE_NAME, DEPLOY_CONFIG_PATH, readDeployConfig, WORKER_NAME } from "./deploy-config.ts";
import { DRILL_DIR, pinnedWrangler, spawnExec, type Call, type DrillStep, type Exec } from "./deploy-target.ts";

export { DRILL_DIR };

/**
 * Rows per table in a `wrangler d1 export` dump, which writes one `INSERT INTO "t"` statement per row at the start of a
 * line; every table it creates is listed, at 0 when empty. A text value holding a line that starts with
 * `INSERT INTO "` would be counted too, and the drill would then report a mismatch rather than pass.
 */
export function rowCounts(dump: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of dump.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gm)) counts.set(m[1]!, 0);
  for (const m of dump.matchAll(/^INSERT INTO "?(\w+)"?/gm)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  return counts;
}

/** What the restored database lacks against the dump (row counts) and the migrations (tables, indexes, triggers). */
export function drillProblems(
  expected: Map<string, number>, restored: Map<string, number>, schema: { tables: string[]; indexes: string[]; triggers: string[] }, names: Set<string>,
): string[] {
  const problems: string[] = [];
  for (const [table, n] of expected) {
    const got = restored.get(table);
    if (got !== n) problems.push(`${table} : ${got ?? "aucune"} ligne(s) restaurée(s) pour ${n} dans la sauvegarde`);
  }
  for (const name of [...schema.tables, ...schema.indexes, ...schema.triggers]) {
    if (!names.has(name)) problems.push(`${name} absent après restauration`);
  }
  return problems;
}

function rows(stdout: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(stdout) as { results?: Record<string, unknown>[] }[];
    return Array.isArray(parsed?.[0]?.results) ? parsed[0].results : null;
  } catch {
    return null;
  }
}

/** The query that shows wrangler runs on the scratch database before anything is restored into it. */
export const DRILL_PREFLIGHT = "SELECT 1 AS ok";

/**
 * Restores a backup into a fresh local D1 and checks it holds what the backup holds: exit 0 restored and verified, 1 the
 * backup is incomplete, does not restore or restores different, 2 could not run (no backup, migrations/ unreadable,
 * wrangler not runnable on the empty scratch database, unreadable answers). Wrangler is first seen answering
 * DRILL_PREFLIGHT on that empty database, so a restore that fails afterwards is the backup's failure, not wrangler's.
 */
export function runDrill(deps: {
  path: string | null;
  dump: string | null;
  /** null: migrations/ could not be read. */
  migrations: string[] | null;
  /** The drill's wrangler steps, from `pinnedWrangler`: never wrangler any other way. */
  wrangler: (step: DrillStep) => Call;
  exec: Exec;
  /** Wipes the scratch D1 (DRILL_DIR under the repository). */
  reset: () => void;
  log: (s: string) => void;
}): number {
  const { log } = deps;
  const exec = (step: DrillStep) => deps.exec(deps.wrangler(step));
  if (!deps.path || !deps.dump) { log(`sauvegarde illisible : ${deps.path ?? "aucune dans backups/"}`); return 2; }
  if (deps.migrations === null) { log("migrations/ illisible : rien à quoi comparer la sauvegarde"); return 2; }
  const schema = expectedSchema(deps.migrations);
  if (schema.tables.length === 0) { log("aucune table dans migrations/ : rien à vérifier"); return 2; }
  const missing = missingFromExport(deps.dump, schema);
  if (missing) { log(`sauvegarde incomplète, il manque ${missing} : ${deps.path}`); return 1; }
  deps.reset();
  const preflight = exec({ drill: "query", sql: DRILL_PREFLIGHT });
  if (preflight.status !== 0 || rows(preflight.stdout)?.[0]?.ok !== 1) {
    log(`wrangler ne s'exécute pas sur la base vide de l'exercice (${preflight.status ?? "non lancé"}) : ${preflight.stderr.trim()}`);
    return 2;
  }
  const restore = exec({ drill: "restore", file: deps.path });
  if (restore.status === null) { log(`wrangler ne s'exécute pas : ${restore.stderr.trim()}`); return 2; }
  if (restore.status !== 0) { log(`la sauvegarde ne se restaure pas (wrangler ${restore.status}) : ${restore.stderr.trim()}`); return 1; }
  const expected = rowCounts(deps.dump);
  // one row, one column per table: D1 refuses a UNION ALL of this many terms (« too many terms in compound SELECT »)
  const count = `SELECT ${[...expected.keys()].map((t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`).join(", ")}`;
  const counted = rows(exec({ drill: "query", sql: count }).stdout);
  const listed = rows(exec({ drill: "query", sql: "SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')" }).stdout);
  if (!counted?.[0] || !listed) { log("réponse illisible de la base restaurée"); return 2; }
  const restored = new Map(Object.entries(counted[0]).map(([t, n]) => [t, Number(n)]));
  const problems = drillProblems(expected, restored, schema, new Set(listed.map((r) => String(r.name))));
  for (const p of problems) log(`restauration : ${p}`);
  if (problems.length > 0) return 1;
  const total = [...expected.values()].reduce((a, b) => a + b, 0);
  log(`restauration vérifiée : ${deps.path}, ${expected.size} tables, ${total} lignes, ${schema.indexes.length} index, ${schema.triggers.length} déclencheur(s)`);
  return 0;
}

/** Where the drill reads its inputs: a directory's entries and a file's text, null when unreadable. */
export interface DrillFs { list: (dir: string) => readonly string[] | null; read: (path: string) => string | null }

/**
 * What the drill reads, from the repository `root` wherever it was started: the backup `arg` names (relative to `cwd`, the
 * directory the drill was started from) or else the newest in backups/, and the migrations in order (null when
 * migrations/ cannot be read).
 */
export function drillInputs(root: string, cwd: string, arg: string | undefined, fs: DrillFs): { path: string | null; dump: string | null; migrations: string[] | null } {
  const newest = (fs.list(join(root, "backups")) ?? []).filter((f) => /^la-table-.*\.sql$/.test(f)).sort().at(-1);
  const path = arg !== undefined ? resolve(cwd, arg) : newest !== undefined ? join(root, "backups", newest) : null;
  const names = fs.list(join(root, "migrations"))?.filter((f) => f.endsWith(".sql")).sort() ?? null;
  const texts = names?.map((f) => fs.read(join(root, "migrations", f))) ?? null;
  return { path, dump: path === null ? null : fs.read(path), migrations: texts === null || texts.some((t) => t === null) ? null : (texts as string[]) };
}

if (isEntry(import.meta.url)) {
  // the repository this script belongs to, wherever it was started: wrangler runs there, on its wrangler.jsonc, through
  // pinnedWrangler, and migrations/ and backups/ are read there
  const root = realpathSync.native(dirname(dirname(fileURLToPath(import.meta.url))));
  const configPath = join(root, DEPLOY_CONFIG_PATH);
  let account: string;
  try {
    account = String(readDeployConfig(configPath).account_id);
  } catch (error) {
    console.error(`${configPath} illisible : ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const fs: DrillFs = {
    list: (dir) => { try { return readdirSync(dir); } catch { return null; } },
    read: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  };
  process.exit(runDrill({
    ...drillInputs(root, process.cwd(), process.argv[2], fs),
    // local steps only: no token is passed (the caller's environment is not read); baseEnv's CI=1 asks no question
    wrangler: pinnedWrangler({ worker: WORKER_NAME, account, database: DATABASE_NAME, root, configPath }, {}),
    exec: spawnExec,
    reset: () => rmSync(join(root, DRILL_DIR), { recursive: true, force: true }),
    log: (s) => console.error(s),
  }));
}
