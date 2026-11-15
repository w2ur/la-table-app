/**
 * Two meals that pass every rule in any month: no fresh produce outside the season exceptions (oignon), a legume meal
 * and a fish meal, two distinct main proteins, quick meals, every resulting line priced. Seeded product names only.
 */
export const SEED_PROPOSAL = {
  params: { portions: 2, red_meat_requested: false, constraints: "" },
  new_products: [],
  new_recipes: [
    {
      key: "curry", title: "Curry de pois chiches aux épinards", source_url: null, base_portions: 2, active_min: 20, total_min: 35,
      main_protein: "protein:legumineuse",
      steps: ["Faire revenir l'oignon émincé.", "Ajouter les pois chiches et les épinards, laisser mijoter 15 minutes.", "Servir avec le riz."],
      ingredients: [
        { product: "pois chiches en boîte", qty: 400, unit: "g" },
        { product: "épinards surgelés", qty: 300, unit: "g" },
        { product: "oignon", qty: 100, unit: "g" },
        { product: "riz complet", qty: 150, unit: "g" },
      ],
    },
    {
      key: "colin", title: "Colin gratiné au comté et haricots verts", source_url: null, base_portions: 2, active_min: 15, total_min: 35,
      main_protein: "protein:poisson",
      steps: ["Disposer le colin sur les haricots verts.", "Couvrir de comté râpé.", "Enfourner 20 minutes à 200 °C."],
      ingredients: [
        { product: "filets de colin surgelés", qty: 300, unit: "g" },
        { product: "haricots verts surgelés", qty: 300, unit: "g" },
        { product: "comté", qty: 80, unit: "g" },
      ],
    },
  ],
  meals: [
    { recipe: "curry", portions: 2, doubled: false },
    { recipe: "colin", portions: 2, doubled: false },
  ],
  prices: [
    { product: "pois chiches en boîte", unit: "g", est_price_cents: 180 },
    { product: "épinards surgelés", unit: "g", est_price_cents: 250 },
    { product: "oignon", unit: "g", est_price_cents: 40 },
    { product: "riz complet", unit: "g", est_price_cents: 120 },
    { product: "filets de colin surgelés", unit: "g", est_price_cents: 690 },
    { product: "haricots verts surgelés", unit: "g", est_price_cents: 230 },
    { product: "comté", unit: "g", est_price_cents: 320 },
  ],
  envies: { placed: [], kept: [] },
};
