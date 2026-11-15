export type Severity = "block" | "warn";

export type NutritionRule =
  | { id: string; scope: "meal"; kind: "requires"; role: string; severity: Severity; label: string }
  | {
      id: string;
      scope: "planning";
      kind: "min";
      role?: string;
      mainProtein?: string;
      /** minimum per 7 meals, scaled as ceil(per7 × N / 7) */
      per7: number;
      severity: Severity;
      label: string;
    }
  | {
      id: string;
      scope: "planning";
      kind: "max";
      role?: string;
      mainProtein?: string;
      n: number;
      /** when set and the planning flag is false, the maximum is 0 */
      requiresFlag?: "redMeatRequested";
      severity: Severity;
      label: string;
    };

/** Every threshold of spec §5. Changing a value here is the whole change. */
export const RULES = {
  budgetCentsPerPortion: 500,
  quickActiveMin: 30,
  maxLongMeals: 2,
  noRepeatPlannings: 4,
  maxMealsPerMainProtein: 2,
  urgentWithinDays: 2,
  cookEarlyWithinDays: 4,
  perishableUnusedWithinDays: 7,
  platCuisineUseByDays: 3,
  calibrationTrips: 6,
  calibrationMinTrips: 3,
  /** (proposed) A bought line or a cooked meal can be undone from its row for this many days after the op (spec §6.6). */
  undoFromRowDays: 14,
  nutrition: [
    { id: "meal-protein", scope: "meal", kind: "requires", role: "protein:*", severity: "block", label: "une protéine" },
    { id: "meal-vegetable", scope: "meal", kind: "requires", role: "vegetable", severity: "block", label: "un légume" },
    { id: "meal-fibre", scope: "meal", kind: "requires", role: "fibre", severity: "block", label: "une source de fibres" },
    { id: "planning-legume", scope: "planning", kind: "min", role: "legume", per7: 2, severity: "block", label: "repas aux légumineuses" },
    { id: "planning-fish", scope: "planning", kind: "min", mainProtein: "protein:poisson", per7: 1, severity: "block", label: "repas de poisson" },
    { id: "red-meat", scope: "planning", kind: "max", mainProtein: "protein:viande_rouge", n: 1, requiresFlag: "redMeatRequested", severity: "block", label: "repas de viande rouge" },
  ] satisfies NutritionRule[] as NutritionRule[],
} as const;
