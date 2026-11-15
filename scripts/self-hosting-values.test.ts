import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GUIDES, remaining, valueProblems, valueTables } from "./self-hosting-values.ts";

describe("the values SELF-HOSTING.md tells a deployer to replace", () => {
  const scratch = mkdtempSync(join(tmpdir(), "la-table-values-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let n = 0;
  const tree = (files: Record<string, string>) => {
    const root = join(scratch, `t${n++}`);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };
  const table = (...rows: string[]) => ["<!-- replace-values -->", "| What | Value | Files |", "|---|---|---|", ...rows, "<!-- /replace-values -->"].join("\n");
  const ACCOUNT = "| Account | `abc123` | `a.jsonc`, `probes/b.jsonc` |";
  const URL = "| Address | `https://x.example` | `src/c.ts` |";
  const files = { "a.jsonc": '"account_id": "abc123"', "probes/b.jsonc": '"account_id": "abc123"', "src/c.ts": 'export const U = "https://x.example";' };

  it("reads each table's rows, its header and separator aside", () => {
    expect(valueTables(`# Guide\n\n${table(ACCOUNT, URL)}\n\n## FR\n\n${table(URL, ACCOUNT)}\n`)).toEqual([
      [{ line: 6, value: "abc123", files: ["a.jsonc", "probes/b.jsonc"] }, { line: 7, value: "https://x.example", files: ["src/c.ts"] }],
      [{ line: 15, value: "https://x.example", files: ["src/c.ts"] }, { line: 16, value: "abc123", files: ["a.jsonc", "probes/b.jsonc"] }],
    ]);
  });

  it("refuses a table left open or a row it cannot read", () => {
    expect(valueTables("<!-- replace-values -->\n| a | b | c |\n")).toBeNull();
    expect(valueTables(table("| Account | abc123 | `a.jsonc` |"))).toBeNull();
    expect(valueTables(table("| Account | `abc123` | a.jsonc |"))).toBeNull();
  });

  it("passes when every value is in every file the guide names", () => {
    expect(valueProblems(tree(files), valueTables(`${table(ACCOUNT, URL)}\n${table(URL, ACCOUNT)}`)!)).toEqual([]);
  });

  // Controls: each check must fail once, or a silent pass proves nothing.
  it("reports a value absent from a file it names, and a file that does not exist", () => {
    const root = tree({ ...files, "probes/b.jsonc": '"account_id": "other"' });
    expect(valueProblems(root, valueTables(table(ACCOUNT, "| Gone | `v` | `nowhere.ts` |"))!)).toEqual([
      "line 4: abc123 is not in probes/b.jsonc",
      "line 5: nowhere.ts does not exist",
    ]);
  });

  it("reports two language tables that disagree, and no table at all", () => {
    expect(valueProblems(tree(files), valueTables(`${table(ACCOUNT, URL)}\n${table(ACCOUNT)}`)!)).toEqual(["table 2 does not list the same values and files as table 1"]);
    expect(valueProblems(tree(files), valueTables("# nothing\n")!)).toEqual(["no table of values to replace, or an empty one"]);
  });

  it("compares a second guide's tables with the first guide's, and reports one that lists other values", () => {
    const reference = valueTables(table(ACCOUNT, URL))![0];
    expect(valueProblems(tree(files), valueTables(`${table(URL, ACCOUNT)}\n${table(ACCOUNT, URL)}`)!, reference)).toEqual([]);
    expect(valueProblems(tree(files), valueTables(`${table(ACCOUNT, URL)}\n${table(ACCOUNT)}`)!, reference)).toEqual(["table 2 does not list the same values and files as the reference table"]);
    expect(valueProblems(tree(files), valueTables(table(ACCOUNT))!, [])).toEqual(["no table of values to replace, or an empty one"]);
  });

  it("lists, for a deployer, each value still in a file, and nothing once all are replaced", () => {
    const tables = valueTables(`${table(ACCOUNT, URL)}\n${table(URL, ACCOUNT)}`)!;
    expect(remaining(tree({ ...files, "a.jsonc": '"account_id": "mine"' }), tables)).toEqual(["probes/b.jsonc: abc123", "src/c.ts: https://x.example"]);
    expect(remaining(tree({ "a.jsonc": "mine", "probes/b.jsonc": "mine", "src/c.ts": "mine" }), tables)).toEqual([]);
  });

  it("reads this repository's guides: two tables each, one per language, all listing the same values and files", () => {
    const guides = GUIDES.map((g) => valueTables(readFileSync(resolve(g), "utf8")));
    for (const tables of guides) {
      expect(tables?.length).toBe(2);
      expect(tables![0]!.length).toBeGreaterThan(0);
    }
    const keyOf = (rows: { value: string; files: string[] }[]) => rows.map((r) => `${r.value} → ${[...r.files].sort().join(", ")}`).sort();
    for (const tables of guides) for (const t of tables!) expect(keyOf(t)).toEqual(keyOf(guides[0]![0]!));
  });
});
