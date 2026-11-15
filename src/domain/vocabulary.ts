import type { Category } from "./types";

export const CATEGORIES: readonly Category[] = [
  "fruits-legumes",
  "boucherie-volaille",
  "poissonnerie",
  "cremerie",
  "epicerie",
  "surgeles",
];

/** Open vocabulary (§5.1): nutrition-goal tags, so extend this list when a new goal needs a new tag (a protein also needs its label, see ProteinRole); plus SEASONING_ROLE, which marks a product left out of recipe nutrition (not a goal). */
export const ROLES = [
  "protein:volaille",
  "protein:poisson",
  "protein:oeuf",
  "protein:legumineuse",
  "protein:laitier",
  "protein:porc",
  "protein:viande_rouge",
  "protein:tofu",
  "vegetable",
  "fibre",
  "legume",
  "fruit",
  /** A seasoning used in negligible amounts; recipe nutrition ignores it. Salt is not one. */
  "assaisonnement",
] as const;


export type Role = (typeof ROLES)[number];

/** The role of a product that recipe nutrition ignores; a rename fails to compile where it is used. */
export const SEASONING_ROLE: Role = "assaisonnement";
/** Every protein role; a map typed `Record<ProteinRole, …>` fails to compile until a new one has its entry. */
export type ProteinRole = Extract<Role, `protein:${string}`>;

export function isKnownRole(role: string): boolean {
  return (ROLES as readonly string[]).includes(role);
}

/** Categories whose non-staple products must carry a shelf life. */
export const PERISHABLE_CATEGORIES: readonly Category[] = [
  "fruits-legumes",
  "boucherie-volaille",
  "poissonnerie",
  "cremerie",
];

/** Courses groups in the shop's order (spec §10.2): the categories, then the ajouts, which have no product. */
export const COURSE_GROUPS: readonly (Category | "ajouts")[] = [...CATEGORIES, "ajouts"];

export const GROUP_LABELS: Record<Category | "ajouts", string> = {
  "fruits-legumes": "Fruits et légumes", "boucherie-volaille": "Boucherie, volaille", poissonnerie: "Poissonnerie",
  cremerie: "Crèmerie", epicerie: "Épicerie", surgeles: "Surgelés", ajouts: "Ajouts",
};
