import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNutritionFile } from "../src/cli/nutrition";
import { parseAlim, parseCiqualCell, parseMap, run } from "./ciqual";

const FIXTURES = "scripts/fixtures/ciqual";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function mapFile(products: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ciqual-test-"));
  dirs.push(dir);
  const path = join(dir, "map.json");
  writeFileSync(path, JSON.stringify({ source: { ciqual: "2025", checkedOn: "2026-10-14" }, products }));
  return path;
}
const line = (name: string, code: string, piece: number | null = null, ml: number | null = null, edible?: unknown) => ({ name, ciqual_code: code, grams_per_piece: piece, grams_per_ml: ml, ...(edible === undefined ? {} : { edible_pct: edible }) });

function exec(products: unknown[], dir = FIXTURES) {
  let stdout = "", stderr = "";
  const code = run(dir, mapFile(products), { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; } });
  return { code, stdout, stderr };
}

describe("parseCiqualCell", () => {
  it.each([
    ["1,5", 1.5], ["30,4", 30.4], [" 140 ", 140], ["0", 0], ["traces", 0], [" traces ", 0],
    ["< 0,5", 0], ["&lt; 0,13", 0], ["<2", 0],
    ["-", "missing"], ["", "missing"], ["  ", "missing"], ["n/a", "missing"],
  ])("%j -> %j", (cell, expected) => { expect(parseCiqualCell(cell)).toBe(expected); });
});

describe("parseAlim", () => {
  it("reads a table with a BOM, CRLF, padding and entities", () => {
    const foods = parseAlim("<TABLE>\n<ALIM>\n<alim_code> 7 </alim_code>\n<alim_nom_fr> Jus d&apos;ananas &amp;lt; </alim_nom_fr>\n</ALIM>\n</TABLE>");
    expect([...foods]).toEqual([["7", "Jus d'ananas &lt;"]]);
  });
});

describe("parseMap", () => {
  it("refuses a conversion that is not a positive number or null", () => {
    expect(parseMap(JSON.stringify({ source: { ciqual: "2025", checkedOn: "x" }, products: [line("Oeuf", "22000", 0)] })).errors[0]).toMatch(/grams_per_piece/);
  });
});

describe("npm run ciqual against the synthetic fixture", () => {
  it("carries a map line's edible_pct to the output and defaults an absent one to 100", () => {
    const { code, stdout } = exec([line("Moule", "22000", null, null, 25), line("Poireau", "20039")]);
    expect(code).toBe(0);
    expect(parseNutritionFile(stdout).entries.map((e) => e.nutrition!.edible_pct)).toEqual([25, 100]);
  });

  it.each(["ediblePct", "edible"])("refuses a map line with the unknown key %s, naming it", (key) => {
    const { code, stdout, stderr } = exec([{ ...line("Moule", "22000"), [key]: 25 }]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(`« ${key} »`);
  });

  it.each([0, -1, 101, "75", null, Number.NaN])("refuses a map line whose edible_pct is %j: exit 1, nothing on stdout", (bad) => {
    const { code, stdout, stderr } = exec([line("Poireau", "20039", null, null, bad)]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("edible_pct");
  });

  it("writes the values of the foods in the map, matched by code, a file plan -- nutrition accepts", () => {
    const { code, stdout, stderr } = exec([line("Poireau", "20039"), line("Lentille verte", "20585", null, 0.8), line("Oeuf", "22000", 60)]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const { entries, errors } = parseNutritionFile(stdout);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { name: "Poireau", nutrition: { ciqual_code: "20039", per_100g: { kcal: 30.4, protein_g: 1.5, carbs_g: 4.55, fat_g: 0.3, fibre_g: 1.8, salt_g: 0.05 }, grams_per_piece: null, grams_per_ml: null, edible_pct: 100 } },
      { name: "Lentille verte", nutrition: { ciqual_code: "20585", per_100g: { kcal: 327, protein_g: 25.1, carbs_g: 44.5, fat_g: 1.8, fibre_g: 16.4, salt_g: 0 }, grams_per_piece: null, grams_per_ml: 0.8, edible_pct: 100 } },
      { name: "Oeuf", nutrition: { ciqual_code: "22000", per_100g: { kcal: 140, protein_g: 12.8, carbs_g: 0.06, fat_g: 9.83, fibre_g: 0, salt_g: 0.31 }, grams_per_piece: 60, grams_per_ml: null, edible_pct: 100 } },
    ]);
  });

  it("counts a missing fibre or salt as 0 and says so on stderr; traces and < x are 0 without a warning", () => {
    const { code, stdout, stderr } = exec([line("Crème", "9001")]);
    expect(code).toBe(0);
    expect(parseNutritionFile(stdout).entries[0]!.nutrition!.per_100g).toEqual({ kcal: 52, protein_g: 0, carbs_g: 0, fat_g: 2, fibre_g: 0, salt_g: 0 });
    expect(stderr.split("\n").filter((l) => l.startsWith("⚠"))).toHaveLength(1);
    expect(stderr).toContain("fibres");
  });

  it("refuses a line whose kcal is `-`, names it, and prints nothing on stdout", () => {
    const { code, stdout, stderr } = exec([line("Oeuf", "22000"), line("Sans énergie", "9002")]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("✗ Sans énergie");
    expect(stderr).toContain("kcal");
  });

  it("refuses a code absent from the table, names it, and prints nothing on stdout", () => {
    const { code, stdout, stderr } = exec([line("Fantôme", "99999"), line("Oeuf", "22000")]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("✗ Fantôme");
    expect(stderr).toContain("99999");
  });

  // Regression: 4643a86 — every wanted code missing from compo.xml was reported « table illisible » (exit 2) before the codes were named
  it("names every code when none of the map's codes is in the table, exit 1 not 2", () => {
    const { code, stdout, stderr } = exec([line("Fantôme", "99999"), line("Spectre", "88888")]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("✗ Fantôme : code Ciqual 99999 absent de la table");
    expect(stderr).toContain("✗ Spectre : code Ciqual 88888 absent de la table");
  });

  it("refuses a food present in alim.xml with no row of the six constituents", () => {
    const { code, stderr } = exec([line("Alien", "9003")]);
    expect(code).toBe(1);
    expect(stderr).toContain("protéines");
  });

  it("refuses a malformed map line with exit 1", () => {
    const { code, stdout } = exec([{ name: "Oeuf" }]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
  });

  // Regression: 4643a86 — an unreadable map exited 1, the code for « a map line refused », instead of 2 (could not run)
  it("exits 2 when the map is not JSON or has the wrong shape: the run could not start, no line was refused", () => {
    for (const text of ["{ not json", JSON.stringify({ source: { ciqual: "2025", checkedOn: "x" }, products: "oeuf" }), "[]"]) {
      const dir = mkdtempSync(join(tmpdir(), "ciqual-test-"));
      dirs.push(dir);
      const path = join(dir, "map.json");
      writeFileSync(path, text);
      let stdout = "";
      const code = run(FIXTURES, path, { stdout: (t) => { stdout += t; }, stderr: () => {} });
      expect(code).toBe(2);
      expect(stdout).toBe("");
    }
  });

  it("exits 2 when a table file is missing", () => {
    const { code, stdout, stderr } = exec([line("Oeuf", "22000")], join(tmpdir(), "ciqual-no-such-dir"));
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("illisible");
  });

  it("exits 2 when the table holds no record", () => {
    const dir = mkdtempSync(join(tmpdir(), "ciqual-test-"));
    dirs.push(dir);
    writeFileSync(join(dir, "alim.xml"), "<TABLE></TABLE>");
    writeFileSync(join(dir, "compo.xml"), "<TABLE></TABLE>");
    const { code, stdout } = exec([line("Oeuf", "22000")], dir);
    expect(code).toBe(2);
    expect(stdout).toBe("");
  });

  it("exits 2 with « Rien à générer » on an empty map: nothing was done, which is not a success", () => {
    const { code, stdout, stderr } = exec([]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Rien à générer");
  });
});
