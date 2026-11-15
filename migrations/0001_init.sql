-- La Table schema (spec §4). Additive changes only from here on.
CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT INTO meta (id, version) VALUES (1, 0);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  is_staple INTEGER NOT NULL,
  roles TEXT NOT NULL,
  is_fresh_produce INTEGER NOT NULL,
  season_months TEXT,
  shelf_life_days INTEGER,
  opened_shelf_life_days INTEGER,
  default_unit TEXT NOT NULL
);

CREATE TABLE recipes (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT,
  base_portions INTEGER NOT NULL,
  active_min INTEGER NOT NULL,
  total_min INTEGER NOT NULL,
  steps TEXT NOT NULL,
  main_protein TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE recipe_ingredients (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  unit TEXT NOT NULL,
  note TEXT
);

CREATE TABLE plannings (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  meals_added INTEGER NOT NULL,
  budget_cents INTEGER NOT NULL,
  estimate_cents INTEGER NOT NULL,
  params TEXT NOT NULL
);

CREATE TABLE meals (
  id INTEGER PRIMARY KEY,
  planning_id INTEGER NOT NULL REFERENCES plannings(id),
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  portions INTEGER NOT NULL,
  doubled_from INTEGER REFERENCES meals(id),
  cook_early_reason TEXT,
  cooked_at TEXT,
  dropped_at TEXT,
  verdict TEXT,
  note TEXT
);

CREATE TABLE trips (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  place TEXT NOT NULL,
  total_cents INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  label TEXT NOT NULL,
  qty INTEGER,
  unit TEXT,
  est_price_cents INTEGER,
  kind TEXT NOT NULL,
  planning_id INTEGER REFERENCES plannings(id),
  for_meals TEXT NOT NULL,
  is_food INTEGER NOT NULL,
  bought_at TEXT,
  trip_id INTEGER REFERENCES trips(id),
  removed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE stock_items (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  label TEXT NOT NULL,
  qty INTEGER,
  unit TEXT,
  qty_text TEXT,
  is_low INTEGER NOT NULL,
  use_by TEXT,
  opened_at TEXT,
  finished_at TEXT,
  origin TEXT NOT NULL,
  source_shopping_item_id INTEGER REFERENCES shopping_items(id),
  source_meal_id INTEGER REFERENCES meals(id),
  created_at TEXT NOT NULL
);

CREATE TABLE reservations (
  id INTEGER PRIMARY KEY,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
  meal_id INTEGER NOT NULL REFERENCES meals(id),
  qty INTEGER,
  unit TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE envies (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  meal_id INTEGER REFERENCES meals(id)
);

CREATE TABLE applied_ops (
  op_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  changes TEXT NOT NULL,
  undone_by TEXT
);

CREATE INDEX meals_open ON meals (cooked_at, dropped_at);
CREATE INDEX shopping_open ON shopping_items (bought_at, removed_at);
CREATE INDEX stock_open ON stock_items (finished_at);
CREATE INDEX reservations_live ON reservations (released_at);
