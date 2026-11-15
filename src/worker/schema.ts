import type { Row, TableName } from "../domain/types";

export interface ColumnSpec {
  key: string;
  col: string;
  kind: "int" | "text" | "bool" | "json";
}

const c = (key: string, col: string, kind: ColumnSpec["kind"] = "text"): ColumnSpec => ({ key, col, kind });
const id = c("id", "id", "int");

export const SQL_TABLE: Record<TableName, string> = {
  products: "products",
  recipes: "recipes",
  recipeIngredients: "recipe_ingredients",
  plannings: "plannings",
  meals: "meals",
  shoppingItems: "shopping_items",
  trips: "trips",
  stockItems: "stock_items",
  reservations: "reservations",
  envies: "envies",
};

/** Order matters only for insert order: parents before children. */
export const COLUMNS: Record<TableName, ColumnSpec[]> = {
  products: [id, c("name", "name"), c("category", "category"), c("isStaple", "is_staple", "bool"), c("roles", "roles", "json"),
    c("isFreshProduce", "is_fresh_produce", "bool"), c("seasonMonths", "season_months", "json"),
    c("shelfLifeDays", "shelf_life_days", "int"), c("openedShelfLifeDays", "opened_shelf_life_days", "int"), c("defaultUnit", "default_unit"), c("nutrition", "nutrition", "json"), c("pack", "pack", "json"), c("price", "price", "json")],
  recipes: [id, c("title", "title"), c("sourceUrl", "source_url"), c("basePortions", "base_portions", "int"), c("activeMin", "active_min", "int"),
    c("totalMin", "total_min", "int"), c("steps", "steps", "json"), c("mainProtein", "main_protein"), c("status", "status"), c("createdAt", "created_at")],
  recipeIngredients: [id, c("recipeId", "recipe_id", "int"), c("productId", "product_id", "int"), c("qty", "qty", "int"), c("unit", "unit"), c("note", "note")],
  plannings: [id, c("createdAt", "created_at"), c("mealsAdded", "meals_added", "int"), c("budgetCents", "budget_cents", "int"),
    c("estimateCents", "estimate_cents", "int"), c("params", "params", "json")],
  meals: [id, c("planningId", "planning_id", "int"), c("recipeId", "recipe_id", "int"), c("portions", "portions", "int"),
    c("doubledFrom", "doubled_from", "int"), c("cookEarlyReason", "cook_early_reason"), c("cookedAt", "cooked_at"), c("droppedAt", "dropped_at"),
    c("verdict", "verdict"), c("note", "note")],
  trips: [id, c("date", "date"), c("place", "place"), c("totalCents", "total_cents", "int"), c("createdAt", "created_at"),
    c("noReceipt", "no_receipt", "bool")],
  shoppingItems: [id, c("productId", "product_id", "int"), c("label", "label"), c("qty", "qty", "int"), c("unit", "unit"),
    c("estPriceCents", "est_price_cents", "int"), c("kind", "kind"), c("planningId", "planning_id", "int"), c("forMeals", "for_meals", "json"),
    c("isFood", "is_food", "bool"), c("boughtAt", "bought_at"), c("tripId", "trip_id", "int"), c("removedAt", "removed_at"), c("createdAt", "created_at"),
    c("plannedQty", "planned_qty", "int")],
  stockItems: [id, c("productId", "product_id", "int"), c("label", "label"), c("qty", "qty", "int"), c("unit", "unit"), c("qtyText", "qty_text"),
    c("isLow", "is_low", "bool"), c("useBy", "use_by"), c("openedAt", "opened_at"), c("finishedAt", "finished_at"), c("origin", "origin"),
    c("sourceShoppingItemId", "source_shopping_item_id", "int"), c("sourceMealId", "source_meal_id", "int"), c("createdAt", "created_at")],
  reservations: [id, c("stockItemId", "stock_item_id", "int"), c("mealId", "meal_id", "int"), c("qty", "qty", "int"), c("unit", "unit"),
    c("releasedAt", "released_at"), c("createdAt", "created_at")],
  envies: [id, c("text", "text"), c("url", "url"), c("createdAt", "created_at"), c("status", "status"), c("mealId", "meal_id", "int")],
};

export function toDbRow(table: TableName, row: Row): unknown[] {
  return COLUMNS[table].map(({ key, kind }) => {
    const v = row[key];
    if (v === null || v === undefined) return null;
    if (kind === "bool") return v ? 1 : 0;
    if (kind === "json") return JSON.stringify(v);
    return v;
  });
}

export function fromDbRow(table: TableName, record: Record<string, unknown>): Row {
  const row: Record<string, unknown> = {};
  for (const { key, col, kind } of COLUMNS[table]) {
    const v = record[col] ?? null;
    row[key] = v === null ? null : kind === "bool" ? v === 1 : kind === "json" ? JSON.parse(v as string) : v;
  }
  return row as Row;
}
