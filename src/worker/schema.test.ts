import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLUMNS, SQL_TABLE, fromDbRow, toDbRow } from "./schema";
import { TABLES } from "../domain/state";
import { fixtureState } from "../domain/test-fixtures";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const sql = readFileSync(new URL("0001_init.sql", MIGRATIONS), "utf8");
/** The columns a later migration added, by table: every `ALTER TABLE <t> ADD COLUMN <c>` of the migrations in order. */
const addedColumns = (files: string[]): Record<string, string[]> => {
  const added: Record<string, string[]> = {};
  for (const file of files) {
    for (const [, table, col] of readFileSync(new URL(file, MIGRATIONS), "utf8").matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) {
      (added[table!] ??= []).push(col!);
    }
  }
  return added;
};
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

describe("schema mapping", () => {
  it("maps every column of every table the migrations declare, and nothing else", () => {
    const added = addedColumns(migrationFiles());
    for (const table of TABLES) {
      const body = sql.match(new RegExp(`CREATE TABLE ${SQL_TABLE[table]} \\(([\\s\\S]*?)\\n\\);`))?.[1];
      expect(body, table).toBeDefined();
      const cols = body!.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((c): c is string => !!c);
      expect(COLUMNS[table].map((c) => c.col).sort(), table).toEqual([...cols, ...(added[SQL_TABLE[table]] ?? [])].sort());
    }
  });

  it("folds an ALTER TABLE ADD COLUMN of a migration into its table", () => {
    expect(addedColumns(migrationFiles())["products"]).toContain("nutrition");
  });

  it("round-trips fixture rows through the DB representation", () => {
    const s = fixtureState();
    for (const table of TABLES) {
      for (const row of s[table] as unknown as { id: number }[]) {
        const values = toDbRow(table, row as never);
        const record = Object.fromEntries(COLUMNS[table].map((c, i) => [c.col, values[i]]));
        expect(fromDbRow(table, record)).toEqual(row);
      }
    }
  });
});
