-- A product's Ciqual composition per 100 g and its unit conversions (JSON, src/domain/types.ts ProductNutrition);
-- NULL until `product.nutrition` sets it. Read by the recipe nutrition (src/domain/nutrition.ts).
ALTER TABLE products ADD COLUMN nutrition TEXT;
