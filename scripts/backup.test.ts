import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backupPath, expectedSchema, missingFromExport, runBackup, type Schema } from "./backup";

const at = new Date("2026-10-11T22:30:00Z"); // 00:30 on the 12th in Paris
const ok = { status: 0, stderr: "" };
const MIGRATIONS = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(`migrations/${f}`, "utf8"));
const SCHEMA = expectedSchema(MIGRATIONS);
/** Shaped like `wrangler d1 export`: each table's CREATE then its rows, the indexes last. */
const exportOf = (schema: Schema) => [
  "PRAGMA defer_foreign_keys=TRUE;",
  'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY);',
  ...schema.tables.flatMap((t) => [`CREATE TABLE ${t} (\n  id INTEGER PRIMARY KEY\n);`, `INSERT INTO "${t}" ("id") VALUES(1);`]),
  ...schema.indexes.map((i) => `CREATE INDEX ${i} ON somewhere (id);`),
  ...schema.triggers.map((g) => `CREATE TRIGGER ${g} BEFORE INSERT ON somewhere\nBEGIN\n  SELECT 1;\nEND;`),
].join("\n") + "\n";
const full = exportOf(SCHEMA);
const base = { now: at, migrations: MIGRATIONS, exec: () => ok, read: () => full, unlink: () => {}, rename: () => {}, log: () => {} };

describe("backup", () => {
  it("names the file after the Paris date and time", () => {
    expect(backupPath(at)).toBe("backups/la-table-2026-10-12-0030.sql");
  });

  it("runs wrangler d1 export --remote into that file and exits 0 when it holds the whole schema", () => {
    const calls: [string, string[]][] = [];
    const code = runBackup({ ...base, exec: (c, a) => { calls.push([c, a]); return ok; } });
    expect(code).toBe(0);
    expect(calls).toEqual([["npx", ["wrangler", "d1", "export", "la-table", "--remote", "--output", "backups/la-table-2026-10-12-0030.sql.partial"]]]);
  });

  it("exits 2 when wrangler fails, the file is missing or empty, or it holds no table", () => {
    expect(runBackup({ ...base, exec: () => ({ status: 1, stderr: "Not logged in" }), read: () => null })).toBe(2);
    expect(runBackup({ ...base, exec: () => ({ status: null, stderr: "" }) })).toBe(2);
    expect(runBackup({ ...base, read: () => null })).toBe(2);
    expect(runBackup({ ...base, read: () => "" })).toBe(2);
    expect(runBackup({ ...base, read: () => "-- nothing" })).toBe(2);
  });

  it("exits 2 when there is no schema to verify against, whatever the export holds", () => {
    expect(runBackup({ ...base, migrations: [] })).toBe(2);
    expect(runBackup({ ...base, migrations: ["INSERT INTO products VALUES (1);"] })).toBe(2);
  });

  // Regression: 3e8e9d6 — a stale file at the same path (wrangler exits 0 without writing) reported success
  it("removes any stale partial file before exporting, so it cannot pass verification", () => {
    const events: string[] = [];
    let present = true;
    const code = runBackup({
      ...base,
      unlink: (p) => { events.push(`unlink ${p}`); present = false; },
      exec: () => { events.push("exec"); return ok; },
      read: () => (present ? full : null),
    });
    expect(events).toEqual(["unlink backups/la-table-2026-10-12-0030.sql.partial", "exec"]);
    expect(code).toBe(2);
  });

  // Regression: 5ccac12 — a failed export in the same minute deleted the earlier good backup
  it("never touches the final file unless the export verified, then renames the partial onto it", () => {
    const events: string[] = [];
    const spy = { ...base, unlink: (p: string) => events.push(`unlink ${p}`), rename: (a: string, b: string) => events.push(`rename ${a} -> ${b}`) };
    expect(runBackup({ ...spy, exec: () => ({ status: 1, stderr: "boom" }) })).toBe(2);
    expect(runBackup({ ...spy, read: () => "-- nothing" })).toBe(2);
    expect(events.filter((e) => !e.endsWith(".partial"))).toEqual([]);
    events.length = 0;
    expect(runBackup(spy)).toBe(0);
    expect(events).toEqual([
      "unlink backups/la-table-2026-10-12-0030.sql.partial",
      "rename backups/la-table-2026-10-12-0030.sql.partial -> backups/la-table-2026-10-12-0030.sql",
    ]);
  });

  // Regression: 3e8e9d6 — an export cut off after another table still passed the any-CREATE-TABLE check
  it("exits 2 when the export lacks the products table", () => {
    expect(runBackup({ ...base, read: () => full.replace("CREATE TABLE products (", "CREATE TABLE orders (") })).toBe(2);
  });

  // Regression: 6f81ef3 — the check asked for « CREATE TABLE products » only, so an export cut after it, or holding products_old, verified
  it("exits 2 on an export cut anywhere before its end, or naming a table only by prefix", () => {
    const logs: string[] = [];
    const lastIndex = full.lastIndexOf("CREATE INDEX");
    const cuts = {
      "after products": full.slice(0, full.indexOf("\n", full.indexOf("CREATE TABLE products (")) + 1),
      "before the last index": full.slice(0, lastIndex),
      "inside the last index": full.slice(0, lastIndex + "CREATE INDEX ".length + 3),
      "inside the last statement": full.trimEnd().slice(0, -1),
      "products_old instead of products": full.replace("CREATE TABLE products (", "CREATE TABLE products_old ("),
    };
    for (const [why, body] of Object.entries(cuts)) {
      expect(runBackup({ ...base, read: () => body, log: (s) => logs.push(s) }), why).toBe(2);
    }
    expect(logs.every((l) => l.startsWith("sauvegarde incomplète, il manque "))).toBe(true);
    expect(runBackup({ ...base, read: () => full.replace("CREATE TABLE products (", 'CREATE TABLE "products" (') })).toBe(0);
  });

  // Regression: b5b8e37 — the cut check assumed the indexes come last; a dump writing each index after its table, cut between two rows of the last table, verified
  it("exits 2 when a row follows an index, since a cut between the last rows would then go unseen", () => {
    const logs: string[] = [];
    const interleaved = [
      "PRAGMA defer_foreign_keys=TRUE;",
      ...SCHEMA.tables.flatMap((t) => [`CREATE TABLE ${t} (\n  id INTEGER PRIMARY KEY\n);`, `INSERT INTO "${t}" ("id") VALUES(1);`]),
    ];
    interleaved.splice(2, 0, ...SCHEMA.indexes.map((i) => `CREATE INDEX ${i} ON somewhere (id);`));
    interleaved.push(...SCHEMA.triggers.map((g) => `CREATE TRIGGER ${g} BEFORE INSERT ON somewhere\nBEGIN\n  SELECT 1;\nEND;`));
    const cut = interleaved.join("\n") + "\n"; // every CREATE present, ends on « ; », rows of the last table possibly missing
    expect(runBackup({ ...base, read: () => cut, log: (s) => logs.push(s) })).toBe(2);
    expect(logs).toEqual([expect.stringMatching(/^sauvegarde incomplète, il manque les index en fin de dump/)]);
  });
});

describe("expectedSchema", () => {
  it("reads every table and index of the real migrations", () => {
    expect(SCHEMA.tables).toEqual(expect.arrayContaining(["meta", "products", "meals", "shopping_items", "applied_ops"]));
    expect(SCHEMA.indexes).toEqual(expect.arrayContaining(["meals_open", "reservations_live", "applied_ops_seq"]));
    expect(SCHEMA.tables).not.toContain("d1_migrations");
    expect(SCHEMA.triggers).toEqual(["applied_ops_seq_required"]);
  });

  it("replays the migrations in order: drops, renames and the indexes that go with them, comments ignored", () => {
    const schema = expectedSchema([
      "CREATE TABLE a (id INTEGER);\nCREATE TABLE IF NOT EXISTS `b` (id INTEGER);\nCREATE UNIQUE INDEX b_id ON b (id);\nCREATE INDEX a_id ON a (id);",
      "-- CREATE TABLE ghost (id INTEGER);\nDROP TABLE a;\nALTER TABLE b RENAME TO c;\nCREATE INDEX IF NOT EXISTS \"c_more\" ON c (id);\nDROP INDEX c_more;",
    ]);
    expect(schema).toEqual({ tables: ["c"], indexes: ["b_id"], triggers: [] });
    expect(missingFromExport('CREATE TABLE "c"(id INTEGER);\nCREATE UNIQUE INDEX b_id ON c (id);\n', schema)).toBeNull();
  });

  // Regression: f551cdd — a DDL statement inside a /* … */ comment was expected in the export, so the backup failed on a complete dump
  it("ignores block comments too, whichever comment opens first", () => {
    const schema = expectedSchema([
      "CREATE TABLE a (id INTEGER);\n/* CREATE TABLE ghost (id INTEGER);\nCREATE INDEX ghost_id ON ghost (id); */\nCREATE TABLE b (id INTEGER);",
      "/* -- */ CREATE TABLE c (id INTEGER);\n-- /* not a block\nCREATE TABLE d (id INTEGER);\n/* unclosed\nCREATE TABLE e (id INTEGER);",
    ]);
    expect(schema).toEqual({ tables: ["a", "b", "c", "d"], indexes: [], triggers: [] });
  });

  // Regression: 056b85a — a seed value holding « /* » opened a block comment, so every table created after it went unchecked
  it("reads quoted values as text: a comment marker or a CREATE TABLE inside one is neither", () => {
    const schema = expectedSchema([
      "CREATE TABLE a (id INTEGER, note TEXT);\nINSERT INTO a VALUES (1, 'voir /* plus bas');\nCREATE TABLE b (id INTEGER);",
      "INSERT INTO a VALUES (2, 'l''étiquette -- CREATE TABLE ghost (id INTEGER)'), (3, 'CREATE TABLE ghost2 (id INTEGER)');\nCREATE INDEX b_id ON b (id);",
    ]);
    expect(schema).toEqual({ tables: ["a", "b"], indexes: ["b_id"], triggers: [] });
  });
});

describe("triggers", () => {
  // Regression: 2996d34 — an export lacking the applied_ops_seq_required trigger verified with exit 0, so a restore from it lost the guard against a NULL seq
  it("exits 2 when the export lacks a trigger the migrations create", () => {
    const logs: string[] = [];
    const withoutTrigger = full.replace(/^CREATE TRIGGER applied_ops_seq_required[\s\S]*?END;\n/m, "");
    expect(withoutTrigger).not.toBe(full);
    expect(missingFromExport(withoutTrigger, SCHEMA)).toBe("le déclencheur applied_ops_seq_required");
    expect(runBackup({ ...base, read: () => withoutTrigger, log: (s) => logs.push(s) })).toBe(2);
    expect(logs).toEqual([expect.stringMatching(/il manque le déclencheur applied_ops_seq_required/)]);
    expect(missingFromExport(full, SCHEMA)).toBeNull();
  });

  it("replays trigger creates, drops, and the drop or rename of their table", () => {
    const schema = expectedSchema([
      "CREATE TABLE a (id INTEGER);\nCREATE TABLE b (id INTEGER);\nCREATE TRIGGER a_guard BEFORE INSERT ON a WHEN NEW.id IS NULL\nBEGIN\n  SELECT RAISE(ABORT, 'x');\nEND;\nCREATE TRIGGER IF NOT EXISTS b_one AFTER UPDATE OF id ON b\nBEGIN\n  SELECT 1;\nEND;\nCREATE TRIGGER b_two AFTER DELETE ON b\nBEGIN\n  SELECT 1;\nEND;",
      "DROP TRIGGER b_two;\nDROP TABLE a;\nALTER TABLE b RENAME TO c;\n-- CREATE TRIGGER ghost BEFORE INSERT ON c BEGIN SELECT 1; END;",
    ]);
    expect(schema).toEqual({ tables: ["c"], indexes: [], triggers: ["b_one"] });
  });
});
