import exceptionsList from "../../data/season-exceptions.json";
import { applyCalibration, calibration, type Calibration } from "./calibration";
import { daysBetween, parisDate, parisMonth } from "./dates";
import { parseProposal, type Proposal } from "./proposal";
import { referencePriceCents } from "./packs";
import { isOpen, liveReservations, sharedQty } from "./quantities";
import { resolveProposal, type ResolvedMeal, type ResolvedPlan } from "./resolve";
import { RULES, type NutritionRule } from "./rules.config";
import { planShopping, type ShoppingPlan } from "./shopping-plan";
import { formatDayMonth, normalizeName } from "./text";
import type { Product, State, Unit } from "./types";
import { formatAmount, formatEuros } from "./units";
import type { ProteinRole } from "./vocabulary";

export interface Violation {
  ruleId: string;
  message: string;
  mealIndex?: number;
}

export interface LineSummary {
  productId: number;
  label: string;
  unit: Unit;
  qty: number;
  kind: "planning" | "staple_hors_budget";
  estPriceCents: number | null;
}

export interface CheckResult {
  blocks: Violation[];
  warns: Violation[];
  proposal: Proposal | null;
  resolved: ResolvedPlan | null;
  shopping: ShoppingPlan | null;
  lines: LineSummary[];
  estimateCents: number;
  budgetCents: number;
  calibratedCents: number | null;
  calibration: Calibration;
  mealCostsCents: number[];
  mealsAdded: number;
}

const EXCEPTIONS = new Set(exceptionsList.map(normalizeName));

const mealCount = (m: { doubled: boolean }): number => (m.doubled ? 2 : 1);

function mealRoles(meal: ResolvedMeal, productsById: Map<number, Product>): Set<string> {
  const roles = new Set<string>();
  for (const ing of meal.ingredients) for (const role of productsById.get(ing.productId)?.roles ?? []) roles.add(role);
  return roles;
}

function hasRole(roles: Set<string>, role: string): boolean {
  if (role.endsWith(":*")) {
    const prefix = role.slice(0, -1);
    return [...roles].some((r) => r.startsWith(prefix));
  }
  return roles.has(role);
}

function matchesPlanningRule(rule: Extract<NutritionRule, { scope: "planning" }>, meal: ResolvedMeal, roles: Set<string>): boolean {
  if (rule.mainProtein !== undefined) return meal.recipe.mainProtein === rule.mainProtein;
  if (rule.role !== undefined) return hasRole(roles, rule.role);
  return false;
}

const PROTEIN_LABELS: Record<ProteinRole, string> = {
  "protein:laitier": "laitier",
  "protein:legumineuse": "légumineuses",
  "protein:oeuf": "œuf",
  "protein:poisson": "poisson",
  "protein:porc": "porc",
  "protein:tofu": "tofu",
  "protein:viande_rouge": "viande rouge",
  "protein:volaille": "volaille",
};

// a recipe's main protein is free text: one outside the vocabulary is written from its tag
const proteinLabel = (role: string): string =>
  Object.hasOwn(PROTEIN_LABELS, role) ? PROTEIN_LABELS[role as ProteinRole] : role.replace(/^protein:/, "").replace(/_/g, " ");

export function checkProposal(state: State, input: unknown, at: string): CheckResult {
  const blocks: Violation[] = [];
  const warns: Violation[] = [];
  const cal = calibration(state);
  const empty = (): CheckResult => ({
    blocks, warns, proposal: null, resolved: null, shopping: null, lines: [], estimateCents: 0, budgetCents: 0,
    calibratedCents: null, calibration: cal, mealCostsCents: [], mealsAdded: 0,
  });

  const parsed = parseProposal(input);
  if (!parsed.ok) {
    for (const message of parsed.errors) blocks.push({ ruleId: "schema", message });
    return empty();
  }
  const proposal = parsed.proposal;
  const resolved = resolveProposal(state, proposal, at);
  if (resolved.errors.length) {
    for (const message of resolved.errors) blocks.push({ ruleId: "resolve", message });
    return { ...empty(), proposal };
  }
  const { productsById } = resolved;
  const meals = resolved.meals;
  const mealsAdded = meals.reduce((n, m) => n + mealCount(m), 0);
  const month = parisMonth(at);

  for (const placed of proposal.envies.placed) {
    const envie = state.envies.find((e) => e.id === placed.envie_id);
    if (!envie || envie.status === "placee") blocks.push({ ruleId: "envie", message: `envie inconnue ou déjà placée : #${placed.envie_id}` });
    if (placed.meal_index >= meals.length) blocks.push({ ruleId: "envie", message: `envie #${placed.envie_id} : repas ${placed.meal_index + 1} inexistant` });
  }

  // Nutrition (§5.1)
  const rolesByMeal = meals.map((m) => mealRoles(m, productsById));
  for (const rule of RULES.nutrition) {
    const sink = rule.severity === "block" ? blocks : warns;
    if (rule.scope === "meal") {
      meals.forEach((m, i) => {
        if (!hasRole(rolesByMeal[i]!, rule.role)) sink.push({ ruleId: rule.id, mealIndex: i, message: `${m.recipe.title} : il manque ${rule.label}` });
      });
      continue;
    }
    const count = meals.reduce((n, m, i) => n + (matchesPlanningRule(rule, m, rolesByMeal[i]!) ? mealCount(m) : 0), 0);
    if (rule.kind === "min") {
      const min = Math.ceil((rule.per7 * mealsAdded) / 7);
      if (count < min) sink.push({ ruleId: rule.id, message: `au moins ${min} ${rule.label} attendu(s), ${count} proposé(s)` });
    } else {
      const max = rule.requiresFlag === "redMeatRequested" && !proposal.params.red_meat_requested ? 0 : rule.n;
      if (count > max) sink.push({ ruleId: rule.id, message: `au plus ${max} ${rule.label}, ${count} proposé(s)` });
    }
  }

  // Variety (§5.2)
  const recent = [...state.plannings].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const recentIds = new Set(recent.slice(0, RULES.noRepeatPlannings).map((p) => p.id));
  const latestId = recent[0]?.id;
  const recentRecipes = new Set(state.meals.filter((m) => recentIds.has(m.planningId)).map((m) => m.recipeId));
  const latestRecipes = new Set(state.meals.filter((m) => m.planningId === latestId).map((m) => m.recipeId));
  const knownTitles = new Map(state.recipes.map((r) => [normalizeName(r.title), r.id]));
  const proposedTitles = new Set<string>();
  meals.forEach((m, i) => {
    const r = m.recipe;
    const title = normalizeName(r.title);
    if (proposedTitles.has(title)) {
      blocks.push({ ruleId: "no-repeat", mealIndex: i, message: `${r.title} : déjà proposée dans cette planification` });
    }
    proposedTitles.add(title);
    if (m.isNewRecipe) {
      const dup = knownTitles.get(normalizeName(r.title));
      if (dup !== undefined) blocks.push({ ruleId: "duplicate-recipe", mealIndex: i, message: `recette déjà connue : ${r.title} (#${dup})` });
      return;
    }
    if (r.status === "banned") blocks.push({ ruleId: "banned", mealIndex: i, message: `recette écartée : ${r.title}` });
    if (r.status !== "favourite" && recentRecipes.has(r.id)) {
      blocks.push({ ruleId: "no-repeat", mealIndex: i, message: `${r.title} : déjà au menu dans les ${RULES.noRepeatPlannings} dernières planifications` });
    }
    if (r.status === "favourite" && latestRecipes.has(r.id)) {
      blocks.push({ ruleId: "favourite-gap", mealIndex: i, message: `${r.title} : favori déjà au menu à la dernière planification` });
    }
  });
  const proteinCounts = new Map<string, number>();
  for (const m of state.meals.filter(isOpen)) {
    const protein = state.recipes.find((r) => r.id === m.recipeId)?.mainProtein;
    if (protein) proteinCounts.set(protein, (proteinCounts.get(protein) ?? 0) + 1);
  }
  for (const m of meals) proteinCounts.set(m.recipe.mainProtein, (proteinCounts.get(m.recipe.mainProtein) ?? 0) + mealCount(m));
  for (const [protein, n] of proteinCounts) {
    if (n > RULES.maxMealsPerMainProtein) {
      blocks.push({ ruleId: "protein-rotation", message: `${n} repas avec ${proteinLabel(protein)} au menu, ${RULES.maxMealsPerMainProtein} au plus` });
    }
  }

  // Season (§5.3)
  meals.forEach((m, i) => {
    for (const ing of m.ingredients) {
      const p = productsById.get(ing.productId);
      if (!p || !p.isFreshProduce || EXCEPTIONS.has(normalizeName(p.name))) continue;
      if (!p.seasonMonths?.includes(month)) {
        blocks.push({ ruleId: "season", mealIndex: i, message: `hors saison : ${p.name} (${m.recipe.title})` });
      }
    }
  });

  // Time (§5.4)
  const longMeals = meals.filter((m) => m.recipe.activeMin > RULES.quickActiveMin).length;
  if (longMeals > RULES.maxLongMeals) warns.push({ ruleId: "long-meals", message: `${longMeals} plats longs, ${RULES.maxLongMeals} au plus conseillé` });

  // Shopping, prices, budget (§5.5)
  const shopping = planShopping(state, meals, productsById, at);
  const priceOf = new Map(proposal.prices.map((p) => [`${normalizeName(p.product)}|${p.unit}`, p.est_price_cents]));
  const lines: LineSummary[] = shopping.lines.map((l) => {
    const product = productsById.get(l.productId)!;
    const proposed = priceOf.get(`${normalizeName(product.name)}|${l.unit}`) ?? null;
    const reference = referencePriceCents(l.qty, l.unit, product.price ?? null);
    if (reference !== null && proposed !== null && proposed !== reference) {
      warns.push({ ruleId: "price-reference", message: `prix de référence utilisé pour ${product.name} (prix de la proposition ignoré)` });
    }
    const estPriceCents = reference ?? proposed;
    if (estPriceCents === null) {
      // the whole line as bought, so the price supplied is the rounded line's, not the need's
      const pack = product.pack?.unit === l.unit ? `, paquet de ${formatAmount(product.pack.qty, l.unit)}` : "";
      blocks.push({ ruleId: "price-missing", message: `prix manquant : ${product.name} (${formatAmount(l.qty, l.unit)}${pack})` });
    }
    if (l.kind === "planning") {
      const surplus = l.qty - sharedQty(l);
      if (surplus > 0) {
        warns.push({ ruleId: "pack-leftover", message: `≈ ${formatAmount(surplus, l.unit)} de ${product.name} resteront, sans emploi prévu` });
      }
    }
    return { productId: l.productId, label: product.name, unit: l.unit, qty: l.qty, kind: l.kind, estPriceCents };
  });
  const estimateCents = lines.filter((l) => l.kind === "planning").reduce((s, l) => s + (l.estPriceCents ?? 0), 0);
  const budgetCents = RULES.budgetCentsPerPortion * meals.reduce((s, m) => s + m.portions * mealCount(m), 0);
  const calibratedCents = applyCalibration(estimateCents, cal);
  if (estimateCents > budgetCents || (calibratedCents !== null && calibratedCents > budgetCents)) {
    warns.push({ ruleId: "budget", message: `estimation ${formatEuros(estimateCents)}${calibratedCents === null ? "" : ` (calibrée ${formatEuros(calibratedCents)})`} au-dessus du budget ${formatEuros(budgetCents)}` });
  }
  const mealCostsCents = meals.map((m) =>
    shopping.lines.reduce((sum, l, li) => {
      const share = l.forMeals.find((f) => f.mealIndex === m.index);
      const price = lines[li]!.estPriceCents;
      return share && price !== null && l.kind === "planning" ? sum + Math.round((price * share.qty) / l.qty) : sum;
    }, 0),
  );

  // Reuse (§5.6) and unknown-quantity stock (it covers a need, for one meal at most, and is flagged)
  const today = parisDate(at);
  const live = liveReservations(state);
  const usedNow = new Set(shopping.reservations.map((r) => r.stockItemId));
  for (const item of state.stockItems) {
    if (item.finishedAt !== null || item.useBy === null || usedNow.has(item.id)) continue;
    if (live.some((r) => r.stockItemId === item.id)) continue;
    if (item.productId !== null && productsById.get(item.productId)?.isStaple) continue;
    const daysLeft = daysBetween(today, item.useBy);
    if (daysLeft <= RULES.perishableUnusedWithinDays) {
      const when = daysLeft < 0 ? `périmé depuis ${formatDayMonth(item.useBy)}` : `avant ${formatDayMonth(item.useBy)}`;
      warns.push({ ruleId: "perishable-unused", message: `${item.label} (${when}) n'est utilisé par aucun nouveau repas` });
    }
  }
  for (const r of shopping.reservations.filter((r) => r.reliesOnUnknownQty)) {
    const item = state.stockItems.find((s) => s.id === r.stockItemId)!;
    warns.push({ ruleId: "unknown-qty-stock", mealIndex: r.mealIndex, message: `repose sur un reste sans quantité : ${item.label} (« ${item.qtyText ?? "?"} »)` });
  }

  return { blocks, warns, proposal, resolved, shopping, lines, estimateCents, budgetCents, calibratedCents, calibration: cal, mealCostsCents, mealsAdded };
}
