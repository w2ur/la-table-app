import type { Unit } from "./units";

export type { Unit };
export type Category =
  | "fruits-legumes"
  | "boucherie-volaille"
  | "poissonnerie"
  | "cremerie"
  | "epicerie"
  | "surgeles";
export type RecipeStatus = "normal" | "favourite" | "banned";
export type Verdict = "a_refaire" | "correct" | "pas_pour_nous";
export type LineKind = "planning" | "staple_hors_budget" | "ajout";
export type Place = "marche" | "supermarche" | "autre";
export type StockOrigin = "achat" | "ajout" | "plat_cuisine";
export type EnvieStatus = "ouverte" | "placee" | "gardee";

/** Ciqual composition per 100 g of a food. */
export interface Nutrients {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  saltG: number;
}

/** A product's Ciqual values and the conversions from a piece or a millilitre to grams (null: unknown). */
export interface ProductNutrition {
  ciqualCode: string;
  per100g: Nutrients;
  gramsPerPiece: number | null;
  gramsPerMl: number | null;
  /** Share of the bought weight that is eaten, in percent (0, 100]: Ciqual values are per 100 g of the edible part. Absent on a row stored before the field: read as 100. */
  ediblePct?: number;
}

/** A product's one pack size in base units: a Courses line is bought in whole packs (pack-sizes spec). */
export interface ProductPack { qty: number; unit: Unit }
/** The reference price of `qty` `unit` of a product, in cents: a pack's price, or a loose product's per kilo, litre or piece. */
export interface ProductPrice { cents: number; qty: number; unit: Unit }

export interface Product {
  id: number;
  name: string;
  category: Category;
  isStaple: boolean;
  roles: string[];
  isFreshProduce: boolean;
  seasonMonths: number[] | null;
  shelfLifeDays: number | null;
  openedShelfLifeDays: number | null;
  defaultUnit: Unit;
  nutrition: ProductNutrition | null;
  pack: ProductPack | null;
  price: ProductPrice | null;
}

export interface Recipe {
  id: number;
  title: string;
  sourceUrl: string | null;
  basePortions: number;
  activeMin: number;
  totalMin: number;
  steps: string[];
  mainProtein: string;
  status: RecipeStatus;
  createdAt: string;
}

export interface RecipeIngredient {
  id: number;
  recipeId: number;
  productId: number;
  qty: number;
  unit: Unit;
  note: string | null;
}

export interface PlanningParams {
  portions: number;
  redMeatRequested: boolean;
  constraints: string;
}

export interface Planning {
  id: number;
  createdAt: string;
  mealsAdded: number;
  budgetCents: number;
  estimateCents: number;
  params: PlanningParams;
}

export interface Meal {
  id: number;
  planningId: number;
  recipeId: number;
  portions: number;
  doubledFrom: number | null;
  cookEarlyReason: string | null;
  cookedAt: string | null;
  droppedAt: string | null;
  verdict: Verdict | null;
  note: string | null;
}

export interface MealShare {
  mealId: number;
  qty: number;
}

/** Why a planned line leaves Courses: the owners have it already (« On en a déjà »), or will not buy it (« On n'en prend pas »). */
export type RemoveReason = "a_la_maison" | "pas_achete";

export interface ShoppingItem {
  id: number;
  productId: number | null;
  label: string;
  qty: number | null;
  unit: Unit | null;
  /** What the planning put on the line, kept the first time a receipt corrects `qty` (shopping.set_bought_qty); null until then. */
  plannedQty: number | null;
  estPriceCents: number | null;
  kind: LineKind;
  planningId: number | null;
  forMeals: MealShare[];
  isFood: boolean;
  boughtAt: string | null;
  tripId: number | null;
  removedAt: string | null;
  createdAt: string;
}

export interface Trip {
  id: number;
  date: string;
  place: Place;
  totalCents: number | null;
  /** A trip of lines bought off the receipt (trip.record noReceipt): no total, no price read by calibration. Null (a trip written before migration 0009) = it has a receipt; read as `=== true`. */
  noReceipt: boolean | null;
  createdAt: string;
}

export interface StockItem {
  id: number;
  productId: number | null;
  label: string;
  qty: number | null;
  unit: Unit | null;
  qtyText: string | null;
  isLow: boolean;
  useBy: string | null;
  openedAt: string | null;
  finishedAt: string | null;
  origin: StockOrigin;
  sourceShoppingItemId: number | null;
  sourceMealId: number | null;
  createdAt: string;
}

export interface Reservation {
  id: number;
  stockItemId: number;
  mealId: number;
  qty: number | null;
  unit: Unit | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface Envie {
  id: number;
  text: string;
  url: string | null;
  createdAt: string;
  status: EnvieStatus;
  mealId: number | null;
}

export type TableName =
  | "products"
  | "recipes"
  | "recipeIngredients"
  | "plannings"
  | "meals"
  | "shoppingItems"
  | "trips"
  | "stockItems"
  | "reservations"
  | "envies";

export type Row = { id: number } & Record<string, unknown>;

export interface Change {
  table: TableName;
  id: number;
  before: Row | null;
  after: Row | null;
}

export type OpStatus = "applied" | "noop" | "refused";

export interface AppliedOp {
  opId: string;
  type: string;
  appliedAt: string;
  status: OpStatus;
  reason: string | null;
  /**
   * Every row the op wrote, as it was before and after: a row the op wrote with the values it already had is listed too,
   * before equal to after, so an undo of an earlier op can see that this one wrote it since.
   */
  changes: Change[];
  undoneBy: string | null;
  /**
   * The order the server applied ops in: higher is later. The `seq` column of the op's D1 record (written as the
   * highest one plus one, in the store's version-guarded batch); an op applied in memory takes one above every record
   * the state holds, so it comes after them.
   */
  seq: number;
}

export interface State {
  version: number;
  products: Product[];
  recipes: Recipe[];
  recipeIngredients: RecipeIngredient[];
  plannings: Planning[];
  meals: Meal[];
  shoppingItems: ShoppingItem[];
  trips: Trip[];
  stockItems: StockItem[];
  reservations: Reservation[];
  envies: Envie[];
  /**
   * The highest id each table has issued, kept in D1 (meta.last_ids). An undo deletes the rows its op created but never
   * lowers this, so `nextId` never hands a deleted row's id to a later row: an op queued against the deleted row (a
   * trip.set_total for an undone trip) then finds nothing instead of landing on its successor.
   */
  lastIds: Partial<Record<TableName, number>>;
  /**
   * Only the records relevant to the ops being applied are loaded (see d1-store): those the ops name, and for an undo the
   * ops applied after its target, still in effect, that wrote one of its rows.
   */
  appliedOps: Record<string, AppliedOp>;
}
