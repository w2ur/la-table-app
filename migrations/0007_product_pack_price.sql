-- A product's one pack size and its reference price (JSON, src/domain/types.ts ProductPack / ProductPrice);
-- NULL until `product.pack` sets them. Read by planShopping and check (src/domain/packs.ts).
ALTER TABLE products ADD COLUMN pack TEXT;
ALTER TABLE products ADD COLUMN price TEXT;
