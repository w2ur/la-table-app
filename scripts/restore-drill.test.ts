import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expectedSchema } from "./backup";
import { baseEnv, pinnedWrangler, WRANGLER_BIN, type Call, type Exec } from "./deploy-target";
import { DRILL_DIR, DRILL_PREFLIGHT, drillInputs, drillProblems, rowCounts, runDrill } from "./restore-drill";

const MIGRATIONS = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(`migrations/${f}`, "utf8"));
const SCHEMA = expectedSchema(MIGRATIONS);
/** Shaped like `wrangler d1 export`: each table's CREATE then its rows, the indexes and triggers last. */
const DUMP = [
  "PRAGMA defer_foreign_keys=TRUE;",
  'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY);',
  'INSERT INTO "d1_migrations" ("id") VALUES(1);',
  ...SCHEMA.tables.flatMap((t) => [`CREATE TABLE ${t} (\n  id INTEGER PRIMARY KEY\n);`, ...(t === "products" ? [`INSERT INTO "products" ("id") VALUES(1);`, `INSERT INTO "products" ("id") VALUES(2);`] : [])]),
  ...SCHEMA.indexes.map((i) => `CREATE INDEX ${i} ON somewhere (id);`),
  ...SCHEMA.triggers.map((g) => `CREATE TRIGGER ${g} BEFORE INSERT ON somewhere\nBEGIN\n  SELECT 1;\nEND;`),
].join("\n") + "\n";
const NAMES = ["d1_migrations", ...SCHEMA.tables, ...SCHEMA.indexes, ...SCHEMA.triggers];

const answer = (results: unknown[]) => ({ status: 0, stdout: JSON.stringify([{ results, success: true }]), stderr: "" });
/** A synthetic repository: the drill's wrangler runs there, on its wrangler.jsonc. */
const ROOT = "/repo";
const TARGET = { worker: "la-table", account: "0123456789abcdef0123456789abcdef", database: "la-table", root: ROOT, configPath: `${ROOT}/wrangler.jsonc` };
/** A local D1 that restores the dump into exactly what it holds, unless told otherwise. */
function d1(over: { restore?: ReturnType<Exec>; counts?: [string, number][]; names?: string[] } = {}) {
  const calls: string[][] = [];
  const all: Call[] = [];
  const exec: Exec = (call) => {
    all.push(call);
    const args = [...call.args];
    calls.push(args);
    if (args.includes(DRILL_PREFLIGHT)) return answer([{ ok: 1 }]);
    if (args.includes("--file")) return over.restore ?? { status: 0, stdout: "", stderr: "" };
    if (args.some((a) => a.includes("sqlite_master"))) return answer((over.names ?? NAMES).map((name) => ({ name })));
    return answer([Object.fromEntries(over.counts ?? [...rowCounts(DUMP)])]);
  };
  return { calls, all, exec };
}
const base = { path: "backups/la-table-2026-10-13-0900.sql", dump: DUMP, migrations: MIGRATIONS, wrangler: pinnedWrangler(TARGET, {}), reset: () => {}, log: () => {} };
const PINS = ["--config", `${ROOT}/wrangler.jsonc`, "--env=", "--env-file=/dev/null"];

describe("rowCounts", () => {
  it("counts each table's rows, listing an empty table at 0", () => {
    const counts = rowCounts(DUMP);
    expect(counts.get("products")).toBe(2);
    expect(counts.get("d1_migrations")).toBe(1);
    expect(counts.get("applied_ops")).toBe(0);
  });
});

describe("drillProblems", () => {
  it("names a table restored with a different count, and a schema object missing", () => {
    const expected = new Map([["products", 2], ["meta", 1]]);
    expect(drillProblems(expected, new Map([["products", 2], ["meta", 1]]), SCHEMA, new Set(NAMES))).toEqual([]);
    expect(drillProblems(expected, new Map([["products", 1]]), SCHEMA, new Set(NAMES.filter((n) => n !== "applied_ops_seq_required")))).toEqual([
      "products : 1 ligne(s) restaurée(s) pour 2 dans la sauvegarde",
      "meta : aucune ligne(s) restaurée(s) pour 1 dans la sauvegarde",
      "applied_ops_seq_required absent après restauration",
    ]);
  });
});

describe("runDrill", () => {
  it("restores into a wiped scratch D1, then counts and lists it (exit 0)", () => {
    const { calls, exec } = d1();
    let resets = 0;
    expect(runDrill({ ...base, exec, reset: () => { resets++; } })).toBe(0);
    expect(resets).toBe(1);
    // wrangler seen answering on the empty scratch database first, then the restore
    expect(calls[0]).toEqual([WRANGLER_BIN, "d1", "execute", "la-table", "--local", "--persist-to", `${ROOT}/${DRILL_DIR}`, "--command", DRILL_PREFLIGHT, "--json", ...PINS]);
    expect(calls[1]).toEqual([WRANGLER_BIN, "d1", "execute", "la-table", "--local", "--persist-to", `${ROOT}/${DRILL_DIR}`, "--file", base.path, "--yes", ...PINS]);
    expect(calls).toHaveLength(4);
  });

  // Regression: 0003975 — the drill ran `npx wrangler` with the caller's whole environment and no --config: a CLOUDFLARE_ENV, a .env or a stray wrangler.json chose its database, and npx could pick another wrangler
  it("runs every wrangler step through pinnedWrangler: this Node, the installed wrangler, the pins, the fixed environment, in the repository", () => {
    const { all, exec } = d1();
    expect(runDrill({ ...base, exec })).toBe(0);
    expect(all.length).toBeGreaterThan(0);
    for (const call of all) {
      expect(call.cmd).toBe(process.execPath);
      expect(call.args[0]).toBe(WRANGLER_BIN);
      expect(call.args.slice(-PINS.length)).toEqual(PINS);
      expect(call.args).toContain("--local");
      expect(call.args).not.toContain("--remote");
      expect(call.cwd).toBe(ROOT);
      expect(call.env).toEqual({ ...baseEnv(), CLOUDFLARE_ACCOUNT_ID: TARGET.account });
    }
  });

  it("refuses a cut backup before restoring anything (exit 1)", () => {
    const { calls, exec } = d1();
    expect(runDrill({ ...base, dump: DUMP.slice(0, DUMP.indexOf("CREATE INDEX")), exec })).toBe(1);
    expect(calls).toEqual([]);
  });

  it("fails (exit 1) when the backup does not restore, or restores fewer rows or without the seq trigger", () => {
    expect(runDrill({ ...base, exec: d1({ restore: { status: 1, stdout: "", stderr: "SQLITE_ERROR" } }).exec })).toBe(1);
    expect(runDrill({ ...base, exec: d1({ counts: [...rowCounts(DUMP)].map(([t, n]) => [t, t === "products" ? n - 1 : n]) }).exec })).toBe(1);
    expect(runDrill({ ...base, exec: d1({ names: NAMES.filter((n) => n !== "applied_ops_seq_required") }).exec })).toBe(1);
  });

  it("cannot run (exit 2) without a backup, a schema, or readable answers", () => {
    expect(runDrill({ ...base, path: null, exec: d1().exec })).toBe(2);
    expect(runDrill({ ...base, dump: null, exec: d1().exec })).toBe(2);
    expect(runDrill({ ...base, migrations: [], exec: d1().exec })).toBe(2);
    // wrangler answers the preflight, restores, then answers the counts with something that is not JSON
    const garbled: Exec = ({ args }) => (args.includes(DRILL_PREFLIGHT) ? answer([{ ok: 1 }]) : args.includes("--file") ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: "⛅️ wrangler", stderr: "" });
    const log: string[] = [];
    expect(runDrill({ ...base, exec: garbled, log: (s) => log.push(s) })).toBe(2);
    expect(log.at(-1)).toBe("réponse illisible de la base restaurée");
  });
});

describe("runDrill, a wrangler that cannot run", () => {
  // Regression: 3ecea8e — a wrangler that could not run (not spawned, or failing on the scratch database itself) read as « la sauvegarde ne se restaure pas », exit 1, a finding about the backup where nothing was checked
  it("cannot run (exit 2) when wrangler is not spawned or fails on the empty scratch database, before restoring anything", () => {
    for (const broken of [{ status: null, stdout: "", stderr: "spawn ENOENT" }, { status: 1, stdout: "", stderr: "wrangler.jsonc: parse error" }]) {
      const { calls, exec } = d1({ restore: broken });
      const failing: Exec = (call) => (call.args.includes("--file") || call.args.includes(DRILL_PREFLIGHT) ? (calls.push([...call.args]), broken) : exec(call));
      const log: string[] = [];
      expect({ broken, exit: runDrill({ ...base, exec: failing, log: (s) => log.push(s) }) }).toEqual({ broken, exit: 2 });
      expect(calls.some((a) => a.includes("--file"))).toBe(false);
      expect(log.at(-1)).toMatch(/^wrangler ne s'exécute pas/);
    }
  });

  // Regression: 3ecea8e — the branch for a wrangler that dies mid-restore was never exercised: with it deleted every test passed, and a wrangler killed by a signal during a large restore read as « la sauvegarde ne se restaure pas », exit 1, a finding about the backup
  it("cannot run (exit 2) when wrangler, answering the preflight, is killed during the restore", () => {
    const log: string[] = [];
    const killed = { status: null, stdout: "", stderr: "killed" };
    expect(runDrill({ ...base, exec: d1({ restore: killed }).exec, log: (s) => log.push(s) })).toBe(2);
    expect(log.at(-1)).toBe("wrangler ne s'exécute pas : killed");
  });

  it("still fails (exit 1) when wrangler runs on the scratch database but the backup does not restore (the control)", () => {
    const log: string[] = [];
    expect(runDrill({ ...base, exec: d1({ restore: { status: 1, stdout: "", stderr: "no such table: productz" } }).exec, log: (s) => log.push(s) })).toBe(1);
    expect(log.at(-1)).toMatch(/^la sauvegarde ne se restaure pas \(wrangler 1\)/);
  });
});

describe("drillInputs, what the drill reads", () => {
  const files: Record<string, string> = { "/repo/migrations/0001_a.sql": "A", "/repo/migrations/0002_b.sql": "B", "/repo/backups/la-table-2026-10-13-0900.sql": "old", "/repo/backups/la-table-2026-10-14-0900.sql": "new", "/elsewhere/mine.sql": "mine" };
  const dirs: Record<string, string[]> = { "/repo/migrations": ["0002_b.sql", "0001_a.sql", "README"], "/repo/backups": ["la-table-2026-10-13-0900.sql", "la-table-2026-10-14-0900.sql", "notes.txt"] };
  const fs = { list: (dir: string) => dirs[dir] ?? null, read: (path: string) => files[path] ?? null };

  // Regression: 3ecea8e — started outside the repository, the drill read migrations/ and backups/ from the working directory and crashed (exit 1) on the missing migrations/
  it("reads migrations/ and backups/ from the repository, wherever the drill was started", () => {
    expect(drillInputs("/repo", "/elsewhere", undefined, fs)).toEqual({ path: "/repo/backups/la-table-2026-10-14-0900.sql", dump: "new", migrations: ["A", "B"] });
    expect(drillInputs("/repo", "/elsewhere", "mine.sql", fs)).toEqual({ path: "/elsewhere/mine.sql", dump: "mine", migrations: ["A", "B"] });
    expect(drillInputs("/repo", "/repo", "backups/la-table-2026-10-13-0900.sql", fs).dump).toBe("old");
  });

  it("cannot run (exit 2) when migrations/ cannot be read, naming it", () => {
    const inputs = drillInputs("/nowhere", "/elsewhere", "mine.sql", fs);
    expect(inputs.migrations).toBeNull();
    const log: string[] = [];
    const { calls, exec } = d1();
    expect(runDrill({ ...base, ...inputs, exec, log: (s) => log.push(s) })).toBe(2);
    expect(calls).toEqual([]);
    expect(log.at(-1)).toMatch(/migrations\/ illisible/);
  });

  // Regression: 3ecea8e — run as a script outside the repository, the drill crashed on readdirSync("migrations") and exited 1
  it("run as a script from another directory, exits 2 on a backup it cannot read, never 1", () => {
    const cwd = mkdtempSync(join(tmpdir(), "la-table-drill-"));
    try {
      const r = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/restore-drill.ts"), join(cwd, "absent.sql")], { cwd, env: { PATH: baseEnv().PATH, HOME: baseEnv().HOME }, encoding: "utf8" });
      expect({ status: r.status, said: /sauvegarde illisible/.test(r.stderr) }).toEqual({ status: 2, said: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
