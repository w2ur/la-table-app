import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../src/cli/entry.ts";
import { isEdiblePct } from "../src/domain/ops/catalogue.ts";
import { payloadObject } from "../src/domain/ops/helpers.ts";

/**
 * Generator of the `plan -- nutrition` file: the committed product map (`data/nutrition-map.json`: which Ciqual food each
 * catalogue product is, and its conversions) joined with the downloaded Ciqual tables (`data/ciqual/alim.xml` and
 * `compo.xml`, gitignored, version named in the map's `source`). Foods are matched by code, never by name.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MAP_PATH = join(ROOT, "data", "nutrition-map.json");
export const TABLE_DIR = join(ROOT, "data", "ciqual");

/** Ciqual's constituent codes (UE 1169/2011 energy, Jones proteins, carbohydrates, fat, fibres, salt) and their wire keys. */
const CONSTITUENTS = [
  { code: "328", key: "kcal", label: "kcal", required: true },
  { code: "25000", key: "protein_g", label: "protéines", required: true },
  { code: "31000", key: "carbs_g", label: "glucides", required: true },
  { code: "40000", key: "fat_g", label: "lipides", required: true },
  { code: "34100", key: "fibre_g", label: "fibres", required: false },
  { code: "10004", key: "salt_g", label: "sel", required: false },
] as const;
type Key = (typeof CONSTITUENTS)[number]["key"];

const ENTITIES: Record<string, string> = { "&apos;": "'", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&amp;": "&" };

/** `&amp;` last, so `&amp;lt;` decodes to the text `&lt;`, not to `<`. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:apos|lt|gt|quot);/g, (m) => ENTITIES[m]!).replace(/&amp;/g, "&");
}

/**
 * A `teneur` cell as a number: decimal comma, padding and entities handled; `traces` and `< x` (under the detection
 * limit) are 0; `-`, an empty cell or text that is no number is `"missing"`.
 */
export function parseCiqualCell(cell: string): number | "missing" {
  const text = decodeEntities(cell).trim().toLowerCase();
  if (text === "" || text === "-") return "missing";
  if (text === "traces" || /^<\s*\d+(?:[.,]\d+)?$/.test(text)) return 0;
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return "missing";
  return Number(text.replace(",", "."));
}

const FIELD = {
  alim_code: /<alim_code>([^<]*)<\/alim_code>/,
  alim_nom_fr: /<alim_nom_fr>([^<]*)<\/alim_nom_fr>/,
  const_code: /<const_code>([^<]*)<\/const_code>/,
} as const;

const TENEUR = /<teneur>([^<]*)<\/teneur>/;

function field(record: string, tag: keyof typeof FIELD): string | null {
  const m = FIELD[tag].exec(record);
  return m ? decodeEntities(m[1]!).trim() : null;
}

/** Food code → French name, from `alim.xml`. */
export function parseAlim(xml: string): Map<string, string> {
  const foods = new Map<string, string>();
  for (const m of xml.matchAll(/<ALIM>([\s\S]*?)<\/ALIM>/g)) {
    const code = field(m[1]!, "alim_code");
    if (code) foods.set(code, field(m[1]!, "alim_nom_fr") ?? "");
  }
  return foods;
}

/** Food code → constituent code → cell, for the wanted foods and the six constituents only (the table is ~69 MB). */
export function parseCompo(xml: string, wanted: Set<string>): Map<string, Map<string, string>> {
  const known = new Set<string>(CONSTITUENTS.map((c) => c.code));
  const cells = new Map<string, Map<string, string>>();
  for (const m of xml.matchAll(/<COMPO>([\s\S]*?)<\/COMPO>/g)) {
    const code = field(m[1]!, "alim_code");
    const constituent = field(m[1]!, "const_code");
    if (!code || !constituent || !wanted.has(code) || !known.has(constituent)) continue;
    const teneur = TENEUR.exec(m[1]!);
    if (!teneur) continue;
    if (!cells.has(code)) cells.set(code, new Map());
    cells.get(code)!.set(constituent, teneur[1]!);
  }
  return cells;
}

const MAP_LINE_KEYS = ["name", "ciqual_code", "grams_per_piece", "grams_per_ml", "edible_pct"];

export interface MapLine { name: string; ciqual_code: string; grams_per_piece: number | null; grams_per_ml: number | null; edible_pct: number }
export interface NutritionMap { source: { ciqual: string; checkedOn: string }; products: MapLine[] }

export interface Generated { file: string | null; refusals: string[]; warnings: string[] }

/** The map's lines, or what is wrong with the file; `unreadable` is a file that is no map at all (not JSON, wrong top-level shape), not a refused line. */
export function parseMap(text: string): { map: NutritionMap | null; errors: string[]; unreadable: boolean } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { map: null, errors: [`carte illisible : ${e instanceof Error ? e.message : String(e)}`], unreadable: true }; }
  const top = payloadObject(raw);
  if (!top || !Array.isArray(top.products)) return { map: null, errors: ["carte : « products » doit être une liste"], unreadable: true };
  const errors: string[] = [];
  const products: MapLine[] = [];
  top.products.forEach((entry: unknown, i) => {
    const at = `products[${i}]`;
    const p = payloadObject(entry);
    if (!p || typeof p.name !== "string" || !p.name.trim()) return void errors.push(`${at} : « name » texte non vide attendu`);
    const label = p.name;
    const unknown = Object.keys(p).filter((k) => !MAP_LINE_KEYS.includes(k));
    if (unknown.length) return void errors.push(`${label} : clé inconnue « ${unknown[0]} »`);
    if (typeof p.ciqual_code !== "string" || !p.ciqual_code.trim()) return void errors.push(`${label} : « ciqual_code » texte non vide attendu`);
    for (const k of ["grams_per_piece", "grams_per_ml"] as const) {
      if (p[k] !== null && !(typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] > 0)) return void errors.push(`${label} : « ${k} » nombre > 0 ou null attendu`);
    }
    const edible = p.edible_pct === undefined ? 100 : p.edible_pct;
    if (!isEdiblePct(edible)) return void errors.push(`${label} : « edible_pct » nombre > 0 et ≤ 100 attendu`);
    products.push({ name: p.name, ciqual_code: p.ciqual_code.trim(), grams_per_piece: p.grams_per_piece as number | null, grams_per_ml: p.grams_per_ml as number | null, edible_pct: edible });
  });
  if (errors.length) return { map: null, errors, unreadable: false };
  const source = payloadObject(top.source);
  if (!source || typeof source.ciqual !== "string" || typeof source.checkedOn !== "string") return { map: null, errors: ["carte : « source » { ciqual, checkedOn } attendu"], unreadable: true };
  return { map: { source: { ciqual: source.ciqual, checkedOn: source.checkedOn }, products }, errors: [], unreadable: false };
}

/** The `plan -- nutrition` file for the map's lines; `file` is null as soon as one line is refused. */
export function generate(map: NutritionMap, foods: Map<string, string>, cells: Map<string, Map<string, string>>): Generated {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const products: { name: string; nutrition: unknown }[] = [];
  for (const line of map.products) {
    if (!foods.has(line.ciqual_code)) { refusals.push(`✗ ${line.name} : code Ciqual ${line.ciqual_code} absent de la table`); continue; }
    const per100g = {} as Record<Key, number>;
    let refused = false;
    for (const c of CONSTITUENTS) {
      const raw = cells.get(line.ciqual_code)?.get(c.code);
      const value = raw === undefined ? "missing" : parseCiqualCell(raw);
      if (value !== "missing") { per100g[c.key] = value; continue; }
      if (c.required) { refusals.push(`✗ ${line.name} : ${c.label} manquant(es) dans Ciqual (${line.ciqual_code})`); refused = true; break; }
      per100g[c.key] = 0;
      warnings.push(`⚠ ${line.name} : ${c.label} manquant(es) dans Ciqual (${line.ciqual_code}), compté(es) 0`);
    }
    if (refused) continue;
    products.push({ name: line.name, nutrition: { ciqual_code: line.ciqual_code, per_100g: per100g, grams_per_piece: line.grams_per_piece, grams_per_ml: line.grams_per_ml, edible_pct: line.edible_pct } });
  }
  return { file: refusals.length ? null : `${JSON.stringify({ products }, null, 2)}\n`, refusals, warnings };
}

export interface Io { stdout: (text: string) => void; stderr: (text: string) => void }

function readTable(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/**
 * Exit 0 file written · 1 a map line refused (malformed, or its code absent from the table) · 2 could not run: the map missing,
 * not JSON, of the wrong shape or empty, or a table missing or without a single record. Nothing on stdout otherwise.
 */
export function run(dir: string, mapPath: string, io: Io): 0 | 1 | 2 {
  const mapText = readTable(mapPath);
  if (mapText === null) { io.stderr(`Carte introuvable : ${mapPath}\n`); return 2; }
  const { map, errors, unreadable } = parseMap(mapText);
  if (!map) { io.stderr(`${errors.map((e) => `✗ ${e}`).join("\n")}\n`); return unreadable ? 2 : 1; }
  if (map.products.length === 0) { io.stderr("Rien à générer : la carte ne liste aucun produit.\n"); return 2; }
  const alim = readTable(join(dir, "alim.xml"));
  const compo = readTable(join(dir, "compo.xml"));
  if (alim === null || compo === null) { io.stderr(`Table Ciqual illisible : alim.xml et compo.xml attendus dans ${dir}\n`); return 2; }
  const foods = parseAlim(alim);
  if (foods.size === 0) { io.stderr(`Table Ciqual illisible : aucun aliment dans ${join(dir, "alim.xml")}\n`); return 2; }
  if (!compo.includes("<COMPO>")) { io.stderr(`Table Ciqual illisible : aucune valeur trouvée dans ${join(dir, "compo.xml")}\n`); return 2; }
  const cells = parseCompo(compo, new Set(map.products.map((p) => p.ciqual_code)));
  const { file, refusals, warnings } = generate(map, foods, cells);
  if (warnings.length) io.stderr(`${warnings.join("\n")}\n`);
  if (file === null) { io.stderr(`${refusals.join("\n")}\n\nRien n'est écrit.\n`); return 1; }
  io.stdout(file);
  return 0;
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--dir");
  const dir = at === -1 ? TABLE_DIR : args[at + 1];
  if (dir === undefined || args.length !== (at === -1 ? 0 : 2)) {
    process.stderr.write("Usage : npm run ciqual -- [--dir <dossier des tables Ciqual>]\n");
    process.exitCode = 2;
  } else {
    process.exitCode = run(resolve(dir), MAP_PATH, { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) });
  }
}
