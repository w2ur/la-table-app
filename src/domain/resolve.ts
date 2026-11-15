import type { Proposal } from "./proposal";
import { nextId } from "./state";
import { normalizeName } from "./text";
import type { Product, Recipe, RecipeIngredient, State } from "./types";
import { toBase } from "./units";

export interface ResolvedMeal {
  index: number;
  recipe: Recipe;
  ingredients: RecipeIngredient[];
  portions: number;
  doubled: boolean;
  isNewRecipe: boolean;
}

export interface ResolvedPlan {
  newProducts: Product[];
  newRecipes: Recipe[];
  newIngredients: RecipeIngredient[];
  productsById: Map<number, Product>;
  productsByName: Map<string, Product>;
  meals: ResolvedMeal[];
  errors: string[];
}

export function resolveProposal(state: State, proposal: Proposal, at: string): ResolvedPlan {
  const errors: string[] = [];
  const productsById = new Map(state.products.map((p) => [p.id, p]));
  const productsByName = new Map(state.products.map((p) => [normalizeName(p.name), p]));

  const newProducts: Product[] = [];
  let productId = nextId(state, "products");
  for (const p of proposal.new_products) {
    if (productsByName.has(normalizeName(p.name))) {
      errors.push(`produit déjà connu : ${p.name}`);
      continue;
    }
    const product: Product = {
      id: productId++,
      name: p.name.trim(),
      category: p.category,
      isStaple: p.is_staple,
      roles: p.roles,
      isFreshProduce: p.is_fresh_produce,
      seasonMonths: p.season_months,
      shelfLifeDays: p.shelf_life_days,
      openedShelfLifeDays: p.opened_shelf_life_days,
      defaultUnit: p.default_unit,
      nutrition: null,
      pack: null,
      price: null,
    };
    newProducts.push(product);
    productsById.set(product.id, product);
    productsByName.set(normalizeName(product.name), product);
  }

  const newRecipes: Recipe[] = [];
  const newIngredients: RecipeIngredient[] = [];
  const recipesByKey = new Map<string, Recipe>();
  let recipeId = nextId(state, "recipes");
  let ingredientId = nextId(state, "recipeIngredients");
  for (const r of proposal.new_recipes) {
    const recipe: Recipe = {
      id: recipeId++,
      title: r.title.trim(),
      sourceUrl: r.source_url,
      basePortions: r.base_portions,
      activeMin: r.active_min,
      totalMin: r.total_min,
      steps: r.steps,
      mainProtein: r.main_protein,
      status: "normal",
      createdAt: at,
    };
    for (const g of r.ingredients) {
      const product = productsByName.get(normalizeName(g.product));
      if (!product) {
        errors.push(`produit inconnu : ${g.product.trim()} (recette ${recipe.title})`);
        continue;
      }
      let base;
      try {
        base = toBase(g.qty, g.unit);
      } catch {
        errors.push(`unité inconnue : ${g.unit} (recette ${recipe.title})`);
        continue;
      }
      newIngredients.push({ id: ingredientId++, recipeId: recipe.id, productId: product.id, qty: base.qty, unit: base.unit, note: null });
    }
    newRecipes.push(recipe);
    recipesByKey.set(r.key, recipe);
  }

  const meals: ResolvedMeal[] = [];
  proposal.meals.forEach((m, index) => {
    let recipe: Recipe | undefined;
    let isNewRecipe = false;
    if (typeof m.recipe === "string") {
      recipe = recipesByKey.get(m.recipe);
      isNewRecipe = true;
      if (!recipe) return void errors.push(`recette inconnue : ${m.recipe}`);
    } else {
      recipe = state.recipes.find((r) => r.id === m.recipe);
      if (!recipe) return void errors.push(`recette inconnue : #${m.recipe}`);
    }
    const ingredients = isNewRecipe
      ? newIngredients.filter((i) => i.recipeId === recipe.id)
      : state.recipeIngredients.filter((i) => i.recipeId === recipe.id);
    meals.push({ index, recipe, ingredients, portions: m.portions, doubled: m.doubled, isNewRecipe });
  });

  return { newProducts, newRecipes, newIngredients, productsById, productsByName, meals, errors };
}
