-- What the planning put on a line, kept the first time a receipt corrects its quantity (`shopping.set_bought_qty`,
-- src/domain/ops/shopping.ts); NULL until then. A rebuy prices per unit from it (helpers.ts rebuyPriceCents), since the
-- line's price is what the planned quantity cost, not the quantity bought.
ALTER TABLE shopping_items ADD COLUMN planned_qty INTEGER;
