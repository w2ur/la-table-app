import { isRecord } from "./shape";
import { isWebUrl } from "./text";
import { CATEGORIES, isKnownRole } from "./vocabulary";
import type { Category, Unit } from "./types";

export interface ProposalProduct {
  name: string;
  category: Category;
  is_staple: boolean;
  roles: string[];
  is_fresh_produce: boolean;
  season_months: number[] | null;
  shelf_life_days: number | null;
  opened_shelf_life_days: number | null;
  default_unit: Unit;
}

export interface ProposalIngredient {
  product: string;
  qty: number;
  unit: string;
}

export interface ProposalRecipe {
  key: string;
  title: string;
  source_url: string | null;
  base_portions: number;
  active_min: number;
  total_min: number;
  main_protein: string;
  steps: string[];
  ingredients: ProposalIngredient[];
}

export interface ProposalMeal {
  recipe: string | number;
  portions: number;
  doubled: boolean;
}

export interface ProposalPrice {
  product: string;
  unit: Unit;
  est_price_cents: number;
}

export interface Proposal {
  params: { portions: number; red_meat_requested: boolean; constraints: string };
  new_products: ProposalProduct[];
  new_recipes: ProposalRecipe[];
  meals: ProposalMeal[];
  prices: ProposalPrice[];
  envies: { placed: { envie_id: number; meal_index: number }[]; kept: number[] };
}

type Errors = string[];

function str(v: unknown, path: string, errors: Errors): void {
  if (typeof v !== "string") errors.push(`${path}: texte attendu`);
}
function strOrNull(v: unknown, path: string, errors: Errors): void {
  if (v !== null && typeof v !== "string") errors.push(`${path}: texte ou null attendu`);
}
function bool(v: unknown, path: string, errors: Errors): void {
  if (typeof v !== "boolean") errors.push(`${path}: booléen attendu`);
}
function int(v: unknown, path: string, errors: Errors, min: number): void {
  if (!Number.isInteger(v) || (v as number) < min) errors.push(`${path}: entier ≥ ${min} attendu`);
}
function intOrNull(v: unknown, path: string, errors: Errors): void {
  if (v !== null) int(v, path, errors, 0);
}
function num(v: unknown, path: string, errors: Errors): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(`${path}: nombre ≥ 0 attendu`);
}
function list(v: unknown, path: string, errors: Errors): v is unknown[] {
  if (!Array.isArray(v)) {
    errors.push(`${path}: liste attendue`);
    return false;
  }
  return true;
}
function unitBase(v: unknown, path: string, errors: Errors): void {
  if (v !== "g" && v !== "ml" && v !== "piece") errors.push(`${path}: unité g, ml ou piece attendue`);
}

/** One product in the `new_products` shape (spec §7.3): a planning's new product, or a `product.upsert` payload. */
export function validateProduct(p: unknown, at: string, errors: Errors): p is ProposalProduct {
  const before = errors.length;
  if (!isRecord(p)) { errors.push(`${at}: objet attendu`); return false; }
  str(p.name, `${at}.name`, errors);
  if (!CATEGORIES.includes(p.category as Category)) errors.push(`${at}.category: catégorie inconnue`);
  bool(p.is_staple, `${at}.is_staple`, errors);
  if (list(p.roles, `${at}.roles`, errors)) {
    const roleErrors = errors.length;
    p.roles.forEach((r, j) => str(r, `${at}.roles[${j}]`, errors));
    const unknown = errors.length === roleErrors ? (p.roles as string[]).filter((r) => !isKnownRole(r)) : [];
    if (unknown.length) errors.push(`${at}.roles: rôle inconnu ${unknown.join(", ")}`);
  }
  bool(p.is_fresh_produce, `${at}.is_fresh_produce`, errors);
  if (p.season_months !== null && list(p.season_months, `${at}.season_months`, errors)) {
    p.season_months.forEach((m, j) => {
      if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 12) errors.push(`${at}.season_months[${j}]: mois 1–12 attendu`);
    });
  }
  intOrNull(p.shelf_life_days, `${at}.shelf_life_days`, errors);
  intOrNull(p.opened_shelf_life_days, `${at}.opened_shelf_life_days`, errors);
  unitBase(p.default_unit, `${at}.default_unit`, errors);
  return errors.length === before;
}

export function parseProposal(input: unknown): { ok: true; proposal: Proposal } | { ok: false; errors: string[] } {
  const errors: Errors = [];
  if (!isRecord(input)) return { ok: false, errors: ["proposition: objet attendu"] };

  const params = input.params;
  if (!isRecord(params)) errors.push("params: objet attendu");
  else {
    int(params.portions, "params.portions", errors, 1);
    bool(params.red_meat_requested, "params.red_meat_requested", errors);
    str(params.constraints, "params.constraints", errors);
  }

  if (list(input.new_products, "new_products", errors)) {
    input.new_products.forEach((p, i) => {
      const at = `new_products[${i}]`;
      validateProduct(p, at, errors);
    });
  }

  if (list(input.new_recipes, "new_recipes", errors)) {
    input.new_recipes.forEach((r, i) => {
      const at = `new_recipes[${i}]`;
      if (!isRecord(r)) return void errors.push(`${at}: objet attendu`);
      str(r.key, `${at}.key`, errors);
      str(r.title, `${at}.title`, errors);
      if (r.source_url !== null && !isWebUrl(r.source_url)) errors.push(`${at}.source_url: adresse http(s) ou null attendue`);
      int(r.base_portions, `${at}.base_portions`, errors, 1);
      int(r.active_min, `${at}.active_min`, errors, 0);
      int(r.total_min, `${at}.total_min`, errors, 0);
      str(r.main_protein, `${at}.main_protein`, errors);
      if (list(r.steps, `${at}.steps`, errors)) r.steps.forEach((s, j) => str(s, `${at}.steps[${j}]`, errors));
      if (list(r.ingredients, `${at}.ingredients`, errors)) {
        r.ingredients.forEach((g, j) => {
          const gat = `${at}.ingredients[${j}]`;
          if (!isRecord(g)) return void errors.push(`${gat}: objet attendu`);
          str(g.product, `${gat}.product`, errors);
          num(g.qty, `${gat}.qty`, errors);
          str(g.unit, `${gat}.unit`, errors);
        });
      }
    });
  }

  if (list(input.meals, "meals", errors)) {
    if (input.meals.length === 0) errors.push("meals: au moins un repas attendu");
    input.meals.forEach((m, i) => {
      const at = `meals[${i}]`;
      if (!isRecord(m)) return void errors.push(`${at}: objet attendu`);
      if (typeof m.recipe !== "string" && !Number.isInteger(m.recipe)) errors.push(`${at}.recipe: clé ou id attendu`);
      int(m.portions, `${at}.portions`, errors, 1);
      bool(m.doubled, `${at}.doubled`, errors);
    });
  }

  if (list(input.prices, "prices", errors)) {
    input.prices.forEach((p, i) => {
      const at = `prices[${i}]`;
      if (!isRecord(p)) return void errors.push(`${at}: objet attendu`);
      str(p.product, `${at}.product`, errors);
      unitBase(p.unit, `${at}.unit`, errors);
      int(p.est_price_cents, `${at}.est_price_cents`, errors, 0);
    });
  }

  const envies = input.envies;
  if (!isRecord(envies)) errors.push("envies: objet attendu");
  else {
    if (list(envies.placed, "envies.placed", errors)) {
      envies.placed.forEach((e, i) => {
        if (!isRecord(e)) return void errors.push(`envies.placed[${i}]: objet attendu`);
        int(e.envie_id, `envies.placed[${i}].envie_id`, errors, 1);
        int(e.meal_index, `envies.placed[${i}].meal_index`, errors, 0);
      });
    }
    if (list(envies.kept, "envies.kept", errors)) envies.kept.forEach((e, i) => int(e, `envies.kept[${i}]`, errors, 1));
  }

  return errors.length ? { ok: false, errors } : { ok: true, proposal: input as unknown as Proposal };
}
