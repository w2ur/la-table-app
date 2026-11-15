# La Table — design spec

Date: 2026-10-10, with the decisions taken since dated in place · Status: the design the code implements. The code's comments cite it as « spec §x »; the numbering is the original one and never changes. A section marked **Superseded** says what replaced it; there, the file it names wins. Back to the [README](../README.md).

Every decision below was taken with the owners in a design session on 2026-10-10, or later where a date says so. "Decided" items are not open; section 12 lists what is deliberately out of scope. The two owners are called A and B where the difference matters.

---

## 1. Purpose and success criteria

A private app for two people, the two owners, to **eat seasonal, fresh food, at a reasonable price, with variety and balanced nutrition**, organised as three lists that feed each other:

- **Menu** — what we'll eat (a rolling pool of meals to cook)
- **Courses** — what we'll buy
- **Reste** — what is left at home (fridge, freezer, cupboard)

Planning happens in **Claude Code sessions** (roughly weekly); the **phone app** is where lists are read and ticked. Reuse of what is left — especially perishables such as dairy — is a by-product of planning, not the lead.

Success means:

1. A planning session produces meals that pass every hard rule (§5) and a shopping list grouped by category, in one sitting.
2. In the shop, with or without network, the list can be read and ticked.
3. Reste is accurate enough that the next planning can build on it: perishables get used before their date, reserved ingredients are not eaten by mistake, staples are not rebought.
4. After a few weeks, estimated costs track actual receipts (calibration, §5.5).
5. The owners never feel they "always eat the same things".

**Users:** the two owners, A and B. Both have full write access from the phone. No other user, ever.

**Language:** user-facing text French; code, identifiers, comments, commits English.

## 2. Core concepts

| concept | meaning |
|---|---|
| **Meal** | one recipe to be cooked once, for N portions (default 2). Meals have **no fixed day**. |
| **Pool** | all meals not yet cooked or dropped — the Menu. |
| **Planning** | one Claude Code session that **adds** N meals to the pool (default 7; the owner may ask for any number, e.g. 3 before leaving, or 2 when 2 already remain). Uncooked meals always carry over. |
| **Product** | a catalogue entry (comté, poireau, riz basmati…) that recipes, list lines and Reste items point to. |
| **Staple** | a product flagged `is_staple` (oil, spices, rice, pasta, coffee…): outside planning cost, never reserved, rebought only when Reste lacks it. |
| **Reservation** | a Reste item held for a specific uncooked meal (the "cheese rule", §6.4). |
| **Trip** | one shopping trip (marché / supermarché / autre) with an optional receipt total. |
| **Envie** | a suggestion added from the phone (a dish, a link, "something with leeks") for the next planning. |

## 3. Architecture

```
 Claude Code session                         Phone (owner A, owner B)
 ──────────────────                          ────────────────────────
 la-table-planning skill                      PWA (Preact), offline cache
        │                                     IndexedDB snapshot + outbox
 npm run plan -- status|check|commit                  │
        │  (Access service token)                     │  (Access session cookie)
        └───────────────► POST /api/ops ◄─────────────┘
                          GET  /api/state
                          Cloudflare Worker  ── JWT check (§9.2)
                                │
                          domain/ (pure TS, shared with CLI)
                                │
                          Cloudflare D1
```

- **One write path.** Both writers send **operations** (§8) to `POST /api/ops`; the Worker applies them through `src/domain/`. Neither writer issues raw SQL against the live database.
- **`src/domain/` is pure TypeScript** (no I/O): rules, aggregation, reservations, shelf-life, season lookup, op application against a state interface. The Worker supplies a D1-backed implementation; tests supply an in-memory one; the CLI imports the same rule checks for `plan check`.
- **Rules config** is one versioned file, `src/domain/rules.config.ts` (§5). Changing a threshold is a visible commit.
- **Reference data** (the product seed, which carries each product's season months and shelf lives, the season exceptions, the Ciqual nutrition map) lives in `data/` as committed JSON, loaded into D1 by migration/seed and validated by tests (§11).

Directory layout:

```
src/domain/        pure logic + rules.config.ts
src/worker/        HTTP, auth, D1 adapter
src/app/           PWA
src/cli/           plan status|check|commit
data/              products.seed.json, season-exceptions.json, nutrition-map.json
migrations/        numbered, additive-only SQL
.claude/skills/la-table-planning/SKILL.md   the session protocol (§7)
```

## 4. Data model

All money in **integer cents**. All quantities in **integer base units** — `g`, `ml`, `piece` — with a conversion table (`kg→g ×1000`, `cl→ml ×10`, `l→ml ×1000`); display converts back. No floats in the domain. Timestamps ISO-8601 TEXT (UTC); dates (`use_by`) `YYYY-MM-DD` in Europe/Paris.

### 4.1 Tables

**`products`** — the catalogue
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT UNIQUE | French, singular ("poireau") |
| category | TEXT | one of: `fruits-legumes`, `boucherie-volaille`, `poissonnerie`, `cremerie`, `epicerie`, `surgeles` |
| is_staple | INTEGER 0/1 | |
| roles | TEXT (JSON array) | open vocabulary, see §5.1 |
| is_fresh_produce | INTEGER 0/1 | subject to the season rule |
| season_months | TEXT (JSON array of 1–12) NULL | required when `is_fresh_produce` and not in exceptions |
| shelf_life_days | INTEGER NULL | sealed / as bought; NULL = long-keeping |
| opened_shelf_life_days | INTEGER NULL | after opening |
| default_unit | TEXT | `g` / `ml` / `piece` |
| pack | TEXT (JSON `{ qty, unit }`) NULL | the one pack size, in base units; NULL = sold loose (decided 2026-10-14, migration 0007); set only by `product.pack` |
| price | TEXT (JSON `{ cents, qty, unit }`) NULL | reference price of `qty` `unit` (a pack's, or per kilo / litre / piece loose); same unit as `pack` when both are set; set only by `product.pack` |

**`recipes`**
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| title | TEXT | |
| source_url | TEXT NULL | when adapted from the web |
| base_portions | INTEGER | quantities in `recipe_ingredients` are for this many |
| active_min, total_min | INTEGER | |
| steps | TEXT (JSON array of strings) | written in Claude's own words, never copied verbatim |
| main_protein | TEXT | a `protein:*` role value; drives protein rotation |
| status | TEXT | `normal` / `favourite` / `banned` |
| created_at | TEXT | |

**`recipe_ingredients`** — (recipe_id, product_id, qty, unit, note NULL). `unit` ∈ base units.

**`plannings`** — (id, created_at, meals_added, budget_cents, estimate_cents, params JSON: portions, constraints text, red_meat_requested bool).

**`meals`**
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| planning_id | FK | |
| recipe_id | FK | |
| portions | INTEGER | |
| doubled_from | FK meals NULL | second round of a cook-once-eat-twice |
| cook_early_reason | TEXT NULL | set by planning, e.g. "crème à utiliser avant jeudi 16" |
| cooked_at, dropped_at | TEXT NULL | |
| verdict | TEXT NULL | `a_refaire` / `correct` / `pas_pour_nous` |
| note | TEXT NULL | |

**`shopping_items`**
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| product_id | FK NULL | NULL for a free-text ajout |
| label | TEXT | display name |
| qty, unit | INTEGER, TEXT NULL | NULL for an ajout with no quantity; a bought line's qty is corrected from the receipt (`shopping.set_bought_qty`, §6.5) |
| planned_qty | INTEGER NULL | migration 0008: the qty the planning put on the line, kept the first time a receipt corrects a priced line; NULL until then, never set on an unpriced line, and cleared by `shopping.set_price` (a price typed is for the line's qty as it is). `est_price_cents` is what this quantity cost, so a rebuy prices per unit from `planned_qty ?? qty` (§6.4) |
| est_price_cents | INTEGER NULL | |
| kind | TEXT | `planning` / `staple_hors_budget` / `ajout` |
| planning_id | FK NULL | |
| for_meal_ids | TEXT (JSON array) | meals this line serves (empty for ajouts/staples) |
| is_food | INTEGER 0/1 | ajouts: asked at creation, default 1 |
| bought_at | TEXT NULL | |
| trip_id | FK NULL | |
| removed_at | TEXT NULL | when it left Courses: its last meal dropped, its shares merged into another line's spare, or `shopping.remove` |

**`trips`** — (id, date, place `marche`/`supermarche`/`autre`, total_cents NULL, no_receipt NULL, created_at). `no_receipt` (migration 0009, nullable: NULL = the trip has a receipt, as every trip before it) is 1 for a trip of lines bought off the receipt, which carries no total.

**`stock_items`** — Reste
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| product_id | FK NULL | NULL for a free-text addition |
| label | TEXT | |
| qty, unit | INTEGER NULL, TEXT NULL | known amount at purchase |
| qty_text | TEXT NULL | human state: "il en reste un peu" |
| use_by | TEXT NULL | |
| opened_at | TEXT NULL | |
| finished_at | TEXT NULL | |
| origin | TEXT | `achat` / `ajout` / `plat_cuisine` |
| source_shopping_item_id | FK NULL | the line a `shopping.buy` bought it from (`origin = achat`), so one item per line at most; NULL for every other item, the one « On en a déjà » puts in Reste included (decided 2026-10-27: nothing was bought) |
| source_meal_id | FK NULL | for `plat_cuisine` |
| touched_at | TEXT NULL | last change after creation (gates undo, §6.6) |

**`reservations`** — (id, stock_item_id, meal_id, qty, unit, released_at NULL).

**`envies`** — (id, text, url NULL, created_at, status `ouverte`/`placee`/`gardee`, meal_id NULL).

**`applied_ops`** — (op_id TEXT PK, type, applied_at, result `applied`/`noop`/`refused`, reason NULL).

### 4.2 Derived views (computed, not stored)

- **Pool** = meals with `cooked_at` and `dropped_at` NULL; `cook_early_reason` first.
- **Libre amount** of a stock item = `qty − Σ unreleased reservations.qty` when every unit matches; otherwise "unknown" (display "réservé" without a surplus).
- **Urgency** = `use_by − today` on unfinished stock items; "À utiliser vite" = ≤ 2 days.

## 5. Rules (`rules.config.ts`)

Every rule is data: `{ id, scope: 'meal'|'planning', kind, ..., severity: 'block'|'warn' }`. `plan check` and the planning op evaluate the same list.

### 5.1 Nutrition — composition rules, extensible

`roles` is an **open vocabulary**. Initial vocabulary: `protein:volaille`, `protein:poisson`, `protein:oeuf`, `protein:legumineuse`, `protein:laitier`, `protein:porc`, `protein:viande_rouge`, `protein:tofu`, `vegetable`, `fibre`, `legume` (pulses). New goals (omega-3, calcium, wholegrain…) = tag products with a new role + add a rule entry; no schema or code change.

Initial entries:

| id | scope | rule | severity |
|---|---|---|---|
| meal-protein | meal | ingredients cover any `protein:*` | block |
| meal-vegetable | meal | covers `vegetable` | block |
| meal-fibre | meal | covers `fibre` | block |
| planning-legume | planning | ≥ 2 meals with `legume` (scaled: ⌈2 × N/7⌉ for N meals added) | block |
| planning-fish | planning | ≥ 1 meal with main_protein `protein:poisson` (scaled ⌈N/7⌉) | block |
| red-meat | planning | `protein:viande_rouge` meals ≤ 1, and only when `red_meat_requested` | block |

No meat is preferred by the rules; variety among proteins comes from the rotation rule below.

### 5.2 Variety

| id | rule | severity |
|---|---|---|
| no-repeat | a recipe does not reappear within the last **4 plannings**, unless `favourite` | block |
| favourite-gap | a favourite is not in **two consecutive** plannings | block |
| banned | a `banned` recipe is never proposed | block |
| protein-rotation | in the **pool after commit**, at most **2** meals share a `main_protein` (a doubled pair counts as 2) | block |

### 5.3 Season

- A product with `is_fresh_produce` is allowed fresh only if the current month ∈ `season_months`, or it is in `data/season-exceptions.json` (initial: oignon, ail, échalote, citron, gingembre, herbes fraîches, banane, pomme de terre de conservation — owner may extend).
- Out of season, the same produce is allowed only as a distinct frozen/tinned/dried product (e.g. `épinards surgelés`, category `surgeles`/`epicerie`, `is_fresh_produce = 0`).
- The season months (`seasonMonths` per product in `data/products.seed.json`) follow a French seasonal calendar cross-checked against a public source (mangerbouger); its URL and the date it was checked are recorded in that file's `source`. Severity: **block**.

### 5.4 Time

| id | rule | severity |
|---|---|---|
| quick | a meal is "quick" when `active_min ≤ 30` | — |
| long-meals | at most **2** non-quick meals per planning | warn |

Cook-once-eat-twice: a doubled recipe creates two meals (§6.1), counting as 2 of the N.

### 5.5 Budget and calibration

- `budget_cents = 500 × Σ portions of the meals added` (5 € per portion, averaged; no per-meal bound).
- `estimate_cents = Σ est_price_cents` of the planning's `kind = planning` lines. Staples bought `staple_hors_budget` and ajouts are excluded.
- A new line's `est_price_cents` is the product's reference price when its unit matches the line's (`round(qty × price.cents ÷ price.qty)`), else the proposal's `prices` entry, else `price-missing` blocks; a proposal price the reference overrides is named in a `price-reference` warning (decided 2026-10-14). Each receipt corrects the reference prices (`plan -- packs`) on top of the calibration factor.
- **Calibration factor** = median of `trip.total_cents ÷ Σ est_price_cents of all lines bought on that trip` (all kinds, so staples and ajouts don't read as overspend), over the last 6 trips that have a total (a trip without a receipt has none and is skipped) **and whose bought lines all carry a price**; shown with the trip count. Fewer than 3 trips → "pas encore de calibration". Unpriced lines (ajouts, rebuys with no known price) are priced by Claude at the next planning session (`shopping.set_price`, §6.5; decided 2026-10-11) — nothing is typed on the phone.
- Budget overrun (raw or calibrated) → **warn**, never block.

### 5.6 Reuse

| id | rule | severity |
|---|---|---|
| staple-already-held | a staple line while Reste holds that staple not marked low | warn |
| perishable-unused | an unreserved stock item with `use_by` within the next 7 days not used by any new meal | warn |
| pack-leftover | a new non-staple line whose pack-rounded qty exceeds its shares (« ≈ 50 g de comté resteront, sans emploi prévu ») | warn |

### 5.7 Conflict priority

When rules pull against each other the planner gives way in this order: **nutrition (hard) > variety > budget > reuse**. Better slightly over budget than a repeat; better buy something than force a third meal around the same leftover.

### 5.8 Initial values summary

5 € / portion · 30 min quick cap · ≤ 2 long meals · no repeat within 4 plannings · ≤ 2 meals per main protein · ≥ 2 legume and ≥ 1 fish per 7 meals · red meat ≤ 1, on request · "À utiliser vite" window 2 days · cook-early window 4 days · perishable-unused window 7 days · plat cuisiné use-by 3 days · calibration over last 6 trips, minimum 3.

Values marked **(proposed)** were not discussed with the owner and are Claude's defaults: the scaling of legume/fish minimums for N ≠ 7, the cook-early (4 d) and perishable-unused (7 d) windows, the calibration window (6 trips, min 3), and « pomme de terre de conservation » in the season exceptions. All live in `rules.config.ts` / `data/`.

## 6. Lifecycle — what each operation does

All operations are applied by the domain layer, each in one D1 transaction, idempotent by `op_id` (§8).

### 6.1 `planning.commit` (CLI only)

Input: a validated proposal (§7.3). Effects, in order:

1. Insert new products and recipes declared in the proposal.
2. Insert the planning row, then its meals. A doubled recipe inserts two meals; the second has `doubled_from` = the first and the same recipe.
3. Reserve existing **libre** stock for the new meals that need those products (largest-urgency first; up to the needed quantity).
4. Build Courses: for each product, `need = Σ new meals' recipe qty (scaled to portions) − reserved from stock`; a meal's remaining need first takes the spare (`qty − Σ shares`) of unbought, unremoved `planning` lines of that product and unit, its share appended to that line (qty, price and planning unchanged); what is left makes one `shopping_items` line per (product, unit) with `need > 0`, `for_meal_ids` set, rounded up to whole packs when the product has a pack in that unit. Staples: a line only if every Reste item of the product is marked low or at a known 0 (none held counts; words of unknown quantity are not a zero, decided 2026-10-25); staple lines round too and offer no spare.
5. Set `cook_early_reason` on meals that consume stock with `use_by` within 4 days.
6. Mark used envies `placee` (with `meal_id`), others named in the proposal `gardee`.

Doubled pairs: the first round's needs are computed at **2 × its portions**; the second round has no ingredient needs and no reservations until the first round is cooked (§6.3).

### 6.2 `shopping.buy(item)` / `shopping.unbuy(item)`

- **buy:** `bought_at` = op time, then the line enters Reste (`enterReste` in `src/domain/ops/shopping.ts`, shared with `shopping.remove` « On en a déjà », §6.5): if `is_food`, create a stock item (`origin = achat`, qty/unit from the line, `use_by = date + shelf_life_days` when known), then, for a `planning` line, create reservations for every uncooked, undropped meal in `for_meal_ids` up to the bought quantity (each its share first, then a surplus to a need no reservation and no unbought line covers). Non-food ajout: nothing else. The line leaves Courses before it enters Reste, so the surplus pass never counts its own shares as still to buy. **A tick on a removed line is refused** (decided 2026-10-27 by the owners, dropping an earlier buy-back): a line taken off Courses meanwhile (the other phone, a planning, or a `meal.drop`) is not bought and nothing enters Reste. A removed `planning` or `staple_hors_budget` line answers « retiré des courses », which the phone's refusal line shows; a removed ajout, like an unknown id, « article introuvable ». If the owners did buy it, they add it back as an ajout. The phone does not predict a tick on a line its snapshot no longer shows.
- **Receipt correction:** a loose product enters Reste at the line's planned quantity (a whole chou blanc as 250 g, four lemons as 1). In the planning session the receipt's weight or count is sent with `shopping.set_bought_qty` (§6.5, `plan -- bought`): the line takes it and its Reste item moves by the same difference.
- **unbuy:** refused if the created stock item has `touched_at` set or any of its reservations was released by cooking; otherwise deletes the stock item and its reservations and clears `bought_at`/`trip_id`.

### 6.3 `meal.cook(meal, sheet)` / `meal.uncook(meal)`

`sheet` = `{ verdict?, note?, items: [{ stock_item_id, outcome: 'fini'|'il_en_reste', qty_text?, resolution?: 'drop_meal'|'rebuy', if_empty?: true }] }`; every field optional except `resolution` as below. `if_empty` (on a `fini` only; decided 2026-10-25) marks a « Fini » the sheet pre-made for an item the meal empties: it finishes the item only if, once this meal's reservations are taken off and released, the item is at a known 0 and no other open meal holds it; otherwise the item is left as it is, with no refusal and no resolution asked.

- A **second round** is refused while its first round is open (« cuisinez d'abord le premier tour »).
- `cooked_at` = op time; store verdict and note. `a_refaire` → recipe `favourite`; `pas_pour_nous` → `banned`.
- For each reservation of this meal: release it and **take its quantity off the item** when the item's quantity is known and in the same unit (floor 0), so what the meal ate never reads as libre (decided 2026-10-11). Unknown quantities and the plat cuisiné keep `qty = null`.
- For each item answered: `fini` → `finished_at`; `il_en_reste` → `opened_at` (if unset), what is left (below), and `use_by = min(use_by, today + opened_shelf_life_days)`. A `fini` on an item still reserved for another open meal needs a `resolution`, exactly as `stock.finish` (§6.4); without one the whole cook is refused « réservé pour X ».
- **What is left** (decided 2026-10-20, `declaredLeftover` in `src/domain/declared.ts`, shared with the phone's projection): the declared leftover prevails, the subtraction above is the fallback, and it is never a false zero.
  - Words that parse in the item's unit (its product's base unit when the item has none, which then becomes its unit) — « 125g », « 1,5 kg », « 20 cl », « 2 boîtes » with a pack in that unit, a bare number only on pieces — become `qty`, and `qty_text` is cleared: the row shows the amount, and the « Il en reste » field opens empty, so a field sent back unchanged never puts back an amount a later cook took off.
  - Words that do not parse (« un fond », « la moitié », « 2 tranches » on grams, « 0 ») are kept, trimmed, in `qty_text` with `qty = null` (unknown). No words keep `qty`, unless it is 0 (or unknown), which becomes unknown; an absent `qty_text` keeps the item's words, `null` clears them.
  - What the owners declare is the truth, even below what other open meals hold (decided 2026-10-20; the cooking meal's reservations are released first): when the live reservations of the other open meals in the item's unit exceed a known `qty`, they are trimmed to fit, the most recently planned meal first (highest planning id, then highest meal id — meal ids are issued in planning order), each reduced, released at 0, until the sum fits. An unknown `qty` keeps one reservation at most, as everywhere: the earliest planned meal's; the others are released. A trimmed meal is short of that product: `plan -- status` lists it under « Manques » (§7.1), and its invariant `meal_under_covered` is reachable this way and by a line removed « On n'en prend pas » (§6.5) only.
  - In one sheet, every `fini` answer (and the meals its `drop_meal` drops) is settled before any `il_en_reste`, so a hold the same sheet releases is never counted.
  - The phone sends a bare number typed in the field with the unit shown beside it (« 125 » → « 125 g »); the server rule stays strict for dictation and the CLI.
- If the meal is the **first round of a doubled pair**: create a stock item `origin = plat_cuisine`, label = recipe title, `use_by = today + 3`, reserved for the second round.
- **uncook** is the generic undo (§6.6): refused if any row the cook changed was changed since, or if the meal would reopen over-covered, or shorter than it was cooked (a line carrying its share bought while it was cooked), or with a share on a line removed from Courses while it was cooked (« retiré des courses depuis », short of it or not; never a staple line, whose share never leaves a meal short: decided 2026-10-27), or as a second round with no plat cuisiné behind it. A meal a declared leftover had left short reopens as short. Undoing a `stock.partial` or a cook gives back the reservations its declaration trimmed.

### 6.4 `stock.finish(item)` and the reservation warning

- Unreserved item → `finished_at`. Already finished → `noop` (two phones finishing the same item; decided 2026-10-11).
- Item with an unreleased reservation → the op requires a `resolution`: `drop_meal` (meal `dropped_at`; release all its reservations; each unbought line it shared loses its share and its price shrinks by `round(price × share ÷ qty)` — with a pack in the line's unit and the line in whole packs, the line becomes `ceil(Σ remaining shares ÷ pack) × pack`, never above its current qty, and its price `round(price × new qty ÷ old qty)`; a touched line whose remaining shares fit another unbought `planning` line's spare moves them there and is emptied —, the line is `removed_at` only when no share is left) or `rebuy` (the reservation is released and its quantity goes on Courses by the rule below). `rebuy` is refused for a plat cuisiné (« un plat cuisiné ne se rachète pas ; retirez le repas »). The phone asks before sending (§10.4); an op without a resolution on a reserved item is refused.
- Dropping a **second round alone** trims its open first round back to the 1× need: its live reservations shrink first (latest first), then its shares on unbought lines.
- **Putting a meal's need on Courses** (`coverNeed` in `src/domain/ops/helpers.ts`), shared by `rebuy` and `meal.cover_shortfalls` (§6.5; decided 2026-10-21): the whole missing amount goes on the first unbought, unremoved `planning` line of that product and unit, in list order, whose spare (`qty − Σ shares`) holds it all, as the meal's share (its existing share on that line grows, else one is added; never split across lines); otherwise a new `kind = planning` line for that meal alone, in the meal's planning, quantity = the amount rounded up to whole packs, priced from the reference price when its unit matches, else pro rata from the source line (a rebuy's item's), else the latest priced line of that product and unit, else null. A rebuy's line takes the item's label, a shortfall's the product's name.

### 6.5 Other phone operations

| op | effect |
|---|---|
| `stock.partial(item, qty_text)` | marks opened, sets what is left from `qty_text` and `use_by` as in 6.3, trimming the other meals' reservations to fit (no meal is cooking: every live reservation on the item is another meal's); a write that changes neither the item nor its reservations answers noop « déjà noté » |
| `stock.set_use_by(item, date)` | manual date correction |
| `stock.add(label, product_id?, qty_text?, use_by?)` | `origin = ajout`; `use_by` from shelf life when blank and product known; `qty_text` read as in 6.3 in the product's base unit and pack (a dictated « 1 kg » becomes `qty = 1000 g`), kept as words with `qty = null` when it does not parse or there is no product |
| `shopping.add(label, is_food)` | `kind = ajout` |
| `shopping.remove(item, reason?)` | takes an unbought line off Courses (decided 2026-10-26). A `reason` present and not `a_la_maison` or `pas_achete` is INVALID whatever the line (unknown id, ajout, planned, removed; decided 2026-10-26), checked before the line is looked up. An ajout just leaves, without a reason; with one, valid or not, it is INVALID whatever its state (decided 2026-10-27: the phone never sends one, and a line's kind never changes), and the phone predicts an ajout's removal only without one. A planned line (`planning` or `staple_hors_budget`) needs `reason`: `a_la_maison` (« On en a déjà ») or `pas_achete` (« On n'en prend pas »); without one it is refused « mettez l'application à jour » (only an old cached build sends none). Either way `removed_at` = op time and the line keeps its qty and price (as a bought line keeps them; every reader skips a removed line), and of its shares only those of meals already cooked or dropped (decided 2026-10-26): an open meal's share leaves the line, so a removed line still carrying a meal's share says that meal was closed when the line left Courses, which undo reads (§6.6) without any clock. `pas_achete`: each non-staple open meal it served is short of its share, listed under « Manques » (§7.1, `mealShortfalls`); a staple line just leaves, and the next planning puts it back if the staple is still low. `a_la_maison`: `removed_at` is set first; then, for a `planning` line, each open meal on it reserves, up to its share and its remaining need, the libre quantity of unfinished Reste items of that product and unit, in use-by order, as `meal.cover_shortfalls` does (an item of unknown quantity is not taken in this pass, nor is any item marked « presque fini » whatever its quantity, here only: `meal.cover_shortfalls` still takes one; decided 2026-10-27; one near its use-by flags the meal « à cuisiner tôt »; decided 2026-10-27); then, when exactly one open meal on the line is still owed something, an unfinished item of that product and unit (its product's base unit when the item has none) of unknown quantity that no live reservation holds and that is not marked « presque fini » (an almost empty item must not cover a whole share; decided 2026-10-27) is reserved that meal's remaining share (the oldest by `created_at` when several, then the lowest id; one near its use-by flags the meal « à cuisiner tôt ») and no item enters Reste (decided 2026-10-27 by the owners: Reste does not show the product twice; with two meals owed, or every such item already held, nothing is reserved on it, since an item of unknown quantity holds one live reservation at most); otherwise what is left enters Reste as a purchase (§6.2), and nothing does when nothing is left (the free stock covered it all, or the quantity is 0: never an empty item; an item of unknown quantity only when the free stock took nothing; decided 2026-10-27): the item takes, for a `planning` line, Σ the shares its open meals hold, each at most the meal's remaining need (what they need, not the pack-rounded qty; decided 2026-10-26; the cap decided 2026-10-27, so no quantity enters Reste that nothing reserves) less what the free stock gave, and for a staple line or one no open meal holds a share of, an unknown quantity (`qty` null, as « Il en reste » without words leaves one; never the pack-rounded line qty, which nobody counted; a line at 0 still puts nothing; decided 2026-10-27); `origin = ajout` (declared by the owners, not bought; `source_shopping_item_id` NULL, decided 2026-10-27, replacing an earlier link to the line: the purchase link keeps one meaning, so `shopping.set_bought_qty` and `plan -- bought` read a purchase only, and a rebuy of this item prices from the reference price, else the product's latest priced line), `use_by` = today + shelf life, each open meal of a `planning` line reserved its share less what the free stock gave it (so a meal that also holds a share on another unbought line never takes what the line set aside for another meal; decided 2026-10-27), then any surplus (a staple line's item is unreserved); the line never reaches the basket, a trip or calibration. Bought → refused « déjà acheté », even without a reason (checked before it); already removed → for a planned line refused « déjà retiré des courses » (decided 2026-10-27: a second removal can carry the other reason, an « On en a déjà » that lost a race to « On n'en prend pas », which the phone then shows; a resend of the same op is replayed from `appliedOps` and never gets here), for an ajout noop « déjà retiré »; a `shopping.buy` landing on the removed line is refused « retiré des courses » (§6.2, decided 2026-10-27 by the owners); unknown → refused « article introuvable ». Undoable (§6.6). Planning, `meal.cover_shortfalls` and a drop's merge never take a removed line's spare |
| `trip.record(place, total_cents?, date, items, no_receipt?)` | creates the trip (`no_receipt: true` records lines bought off the receipt, another day or without a ticket: it takes no `total_cents`, else INVALID, `trip.set_total` on it is refused « passage sans ticket », and calibration, the phone's last trip and `status` skip it; a `no_receipt` that is no boolean is INVALID); attaches exactly `items`, the lines the checkout showed (each must still be bought and on no trip, else refused « panier modifié depuis » and nothing is recorded); a line bought since and not shown stays in the basket (decided 2026-10-12) |
| `trip.set_total(trip, total_cents)` | for receipts entered later; refused « passage sans ticket » on a trip without a receipt |
| `envie.add(text, url?)` | |
| `shopping.set_price(item, est_price_cents)` | planning session only: prices an unpriced line (ajout, rebuy) so calibration can use its trip; the price is for the line's qty as it is, so it clears `planned_qty`: a loose line gets its receipt qty (`set_bought_qty`) first |
| `shopping.set_bought_qty(item, qty)` | planning session (`plan -- bought`) by convention, not enforced: the receipt's quantity for a bought line, `qty` a safe integer ≥ 1 in the line's unit. Absolute: `qty` replaces the line's; its Reste item (the one whose `source_shopping_item_id` is the line: the purchase, since no other item names a line) moves by `qty − old qty`, so what a cook ate stays eaten (0 + 950); an item of unknown quantity stays unknown; a result ≤ 0 leaves the item of unknown quantity (never a false zero: a 0 would forget what was eaten, and a later correction would add phantom stock to it), with one hold kept as `declaredLeftover` keeps one on an unknown item, and it then shows under « Restes à préciser ». The first correction of a priced line keeps the old qty in `planned_qty` (an unpriced line keeps none: a price typed later is for the qty bought); `est_price_cents` stays (the trip's spend: calibration reads the extra weight as spend, which it is). A quantity below the other open meals' holds trims them as a declared leftover does (§6.3, `declaredLeftover`, latest planned first) without opening the item (`opened_at` and `use_by` unchanged); the trimmed meals show under « Manques ». Packed lines too (2 packs instead of 1). Refused « article introuvable » (unknown or removed), « pas encore acheté », « article sans produit » (ajout, free text), « pas d'article en Reste » (non-food), « déjà fini », « reste déclaré depuis, à préciser avec reste » (`opened_at` set: the owners' word is the truth from then on); the same qty again is noop « déjà cette quantité », checked before « déjà fini » and « reste déclaré depuis » so that a resend of a correction that landed stays a noop. Undoable by diff (§6.6); after a later `meal.cover_shortfalls` on a meal it trimmed, the undo is refused « couvert depuis » (the restored hold over-covers that meal) |
| `meal.drop(meal)` | explicit removal from the pool; same effects as `drop_meal` |
| `meal.cover_shortfalls(meal)` | sent by `plan -- manques` and by the phone's « Ajouter aux courses » on a short meal's recipe (§10.1); no op is limited to a client. For each shortfall of that open meal (`mealShortfalls`, §6.3), in `planning.commit`'s order so that nothing free at home is bought: first reserve the libre quantity of unfinished Reste items of that product and unit, in use-by order (the helpers `planShopping` uses: `stockByUseBy`, `libreTake`; an item of unknown quantity is not taken), flagging the meal « à cuisiner tôt » when an item it reserves is near its use-by, by the rule `planning.commit` applies (`cookEarlyReason`; a meal keeps a reason it has), then put what is left on Courses (§6.4). Refused « repas introuvable », « repas déjà cuisiné », « repas retiré du menu »; noop « rien ne manque » when the meal lacks nothing, so a resend changes nothing. Undoable (§6.6) |
| `product.pack(name, pack, price)` | planning session only (`plan -- packs`): sets or clears a product's pack size and reference price, nothing else of it; not undoable |

### 6.6 Undo

One generic `undo(op)` restores the rows the op changed. It is **refused, with the reason shown**, when any of those rows changed since (« modifié depuis »); when a row the op created is now referenced by a later row (« utilisé depuis »); or when the restored state breaks a domain invariant (§11 property 2) that the current state keeps: over-reserving an item (« réservé depuis pour un autre repas »), a reservation on an item finished since (« article fini depuis ») or for a meal cooked or dropped since (« repas cuisiné ou retiré depuis »), a meal reopened short (« acheté depuis ») or over-covered (« repas doublé retiré depuis » when that meal has a dropped second round, else « couvert depuis »), or a meal reopened with a share on a removed line (« retiré des courses depuis »: a removed planned line keeps only closed meals' shares, so one still carrying the meal's share was removed while it was cooked or dropped; refused whether or not the meal would be short; read from the row, never from a time or an op order; decided 2026-10-27; a `staple_hors_budget` line is left out, decided 2026-10-27: a staple share never leaves a meal short, the staple just leaves Courses as « On n'en prend pas » on an open meal's staple line does, and every reader skips a removed line, so the reopened meal's share there is inert). Two shortfalls are tolerated: a meal reopened as short as it was closed (§6.3; a line removed « On n'en prend pas » while it was open left it so, and took its share off), and the undo of a `meal.cover_shortfalls` bringing back its own meal's shortfall of a product and unit no larger than what that op covered of it (its new reservations plus its shares' growth); any other meal, or a larger amount, is still refused. The undo of a `shopping.remove` is refused « repas cuisiné ou retiré depuis » when a meal whose share it would put back on the line (a share the line had before the removal and not after it: that meal was open then) is cooked or dropped now (decided 2026-10-27), since Courses would list food for a closed meal (never for a `staple_hors_budget` line, decided 2026-10-27, as for the uncook above: a cooked meal's staple share comes back within the need it was cooked at, `staple_over_shared`, and a dropped meal's is still refused by `dropped_meal_share`); read from the removal's rows and the meals' rows, never from a later op. Only a `shopping.remove`: a `meal.drop` that emptied a line into another's spare also removes it, and its undo moves those shares back, a cooked meal's included, so it is not refused for them (decided 2026-10-27). A bought line already attached to a recorded trip cannot be un-bought, and the phone does not offer that undo (decided 2026-10-11). A trip can be undone while its own rows are unchanged, whatever trip follows it: a trip attaches only the lines it lists (§6.5 `trip.record`), so its lines go back to the basket and join no other trip. The 5-second "Annuler" bar sends the undo; later undo is done from the row.

### 6.7 Never automatic

Nothing expires, is dropped, rebought or re-planned without a person tapping or a planning session. Out-of-date stock stays visible (at the top of Reste) until someone finishes it.

## 7. Planning session protocol

Lives in the project skill `la-table-planning`, triggered by a line in the owners' working instructions for their agent ("Planning a batch of meals: load the `la-table-planning` skill").

### 7.1 Steps

1. **Backup:** `wrangler d1 export la-table --remote` into gitignored `backups/` (dated file).
2. **`npm run plan -- status`**, then **the receipts first**: trip totals (`plan -- total`), lines to price (`plan -- price`, after `plan -- bought` for a loose line), and from a receipt photo the reference prices and packs (`plan -- packs`) and, for each loose line, the weight or count bought (`plan -- bought`, §7.2). Receipts come before « Restes à préciser »: a `reste` answer sets `opened_at` on the item, and `bought` then refuses it. Calibration may rise after loose receipts: that is real spend, never corrected by hand.
3. **`status`** prints, first, **Restes à préciser** (open non-staple product items at 0 or unknown, whatever their words: a row kept as text before the server parsed it is converted by sending its words back; the owner says what is left and Claude records it with `plan -- reste`, §7.2), then **Manques** (each open meal whose live reservations plus shares on unbought lines fall below its need for a non-staple product — a declared leftover trimmed its hold, §6.3, or a line carrying its share was removed « On n'en prend pas », §6.5 — as « comté : 110 g manquent pour <titre> (#id) »; no planning op adds a line for a meal already planned, so each is covered by `plan -- manques` (§7.2), or the meal is dropped or swapped; `status` adds « (Reste : 950 g libres) » when free Reste stock of that product and unit exists), then: pool with reservations; Reste by urgency (staples marked low); open envies; verdicts and notes since the last planning; trips lacking a total (settled in step 2; a trip without a receipt is not listed, nor are its lines under « Lignes à chiffrer »); calibration factor and trip count.
4. **Ask the session parameters:** meals to add (default 7), portions (default 2, per-meal overrides), constraints (absences, guests, long-dish appetite, red-meat request).
5. **Build candidates**, in order: envies → perishables that must be used → eligible favourites → new recipes from Claude's knowledge or the web (web recipes keep `source_url`; steps rewritten, scaled, French units).
6. **Draft `proposal.json`** (§7.3) in the session scratchpad.
7. **`npm run plan -- check proposal.json`**: blocking violations must be zero; warnings are shown to the owner.
8. **Present** one line per meal — title, why (season / uses X / envie / favourite), € per portion, active time, cook-early flag — then totals vs budget (raw and calibrated). The owner swaps, drops, asks for alternatives; re-run `check` after every change.
9. **`npm run plan -- commit proposal.json`** only after the owner's explicit go; then print Courses by category.

Never in a session: committing without a clean `check`; editing rows directly; touching anything ticked on the phone, except `reste` (the owners' answer) and `bought` (the receipt), the two writes on a phone-owned row.

### 7.2 CLI

`src/cli/plan.ts`, run with `npm run plan -- <command>`:

| command | does | network |
|---|---|---|
| `status` | `GET /api/state` + history needed for rules; prints what §7.1 steps 2–3 read | yes |
| `check <file>` | validates the proposal schema and evaluates every rule against the fetched state; prints blocks and warnings; exit `0` clean · `1` violations · `2` could not run | yes (read) |
| `reste <id> <words…> [--low\|--pas-low]` | the owner's answer to Restes à préciser: sends `stock.partial` (the server parses the words into the item's unit, §6.5); `low` stays the item's own unless a flag sets it; prints before → after; unknown id or finished item exit `1` with nothing sent, refused `1`, not final `2` | yes (write) |
| `bought <line id> <words…> [--oui]` | the receipt's quantity for a bought line (§7.1 step 2): the words parse in the line's unit as a `reste` answer's do (`parseDeclaredQty`; unparsed: exit `1`, nothing sent); a quantity over 10× or under a tenth of the line's planned quantity (its meals' shares rounded up to the pack, which no receipt changes, so a second correction cannot drift from the first, priced or not; `planned_qty ?? qty` for a line without shares) is refused without `--oui` (a typo goes straight into Reste and calibration); sends `shopping.set_bought_qty` (§6.5), CLI-only by convention, not enforcement; prints « ~ chou blanc : 250 g → 1,2 kg · Reste #46 250 g → 1,2 kg » and each meal it left short (« ! #12 … : il manque comté 50 g (plan -- manques 12) »), « = » unchanged; a malformed id is exit `2` before the keychain is read; unknown line or line without a product `1` with nothing sent, refused `1`, not final `2` (safe to re-run: it sets a value) | yes (write) |
| `manques [<meal id>…]` | covers what open meals lack (§7.1 step 3 « Manques »; every short meal when no id): one `meal.cover_shortfalls` per meal (§6.5), the op the phone's « Ajouter aux courses » sends too. Prints per shortfall where it went, read from the state before and after: « → Reste #46 (réservé) », « → ligne #N (réserve) », « → nouvelle ligne comté 250 g, 4,35 € » (« prix inconnu » when null); a malformed id is exit `2` before the keychain is read; a meal not short « rien ne manque » (0), nothing short « Manques : aucun » (0); every op is sent, then `1` if any refused, `2` if any answer was not final (safe to re-run: a covered meal answers noop; the line says so, except after an Access refusal, which landed nowhere and which a rerun cannot change), else `0` | yes (write) |
| `commit <file>` | re-runs `check`; refuses on any block; sends one `planning.commit` op | yes |

Auth: Access service token (client id + secret) read from the macOS keychain at run time (`security find-generic-password`); a missing or empty secret is exit `2`, never a silent unauthenticated call.

### 7.3 Proposal format (`proposal.json`)

```json
{
  "params": { "portions": 2, "red_meat_requested": false, "constraints": "absents jeudi" },
  "new_products": [ { "name": "...", "category": "...", "is_staple": false, "roles": ["..."],
                      "is_fresh_produce": true, "season_months": [10,11,12],
                      "shelf_life_days": 7, "opened_shelf_life_days": null, "default_unit": "g" } ],
  "new_recipes":  [ { "key": "r1", "title": "...", "source_url": null, "base_portions": 2,
                      "active_min": 25, "total_min": 45, "main_protein": "protein:legumineuse",
                      "steps": ["..."], "ingredients": [ { "product": "lentilles vertes", "qty": 200, "unit": "g" } ] } ],
  "meals": [ { "recipe": "r1 | <existing recipe id>", "portions": 2, "doubled": false } ],
  "prices": [ { "product": "lentilles vertes", "unit": "g", "est_price_cents": 180 } ],
  "envies": { "placed": [ { "envie_id": 3, "meal_index": 0 } ], "kept": [4] }
}
```

`prices` gives one estimate per resulting list line whose product has no reference price in that unit, for the whole line as `check` prints it (rounded up to the pack); `check` refuses a proposal whose resulting lines lack a price, and ignores, with a warning, a `prices` entry the reference price covers.

## 8. API and sync

### 8.1 Endpoints

**Superseded in part** by the Worker as built, `src/worker/app.ts`, which wins where they differ: op fields are camelCase (`opId`, not `op_id`); `GET /api/health` answers `{ ok, version, tag }`, `tag` being the deployed commit's first 12 hex digits, and is the only route outside Access; `GET /api/history` takes no `since` and answers the whole stored state but the op records; `POST /api/ops` refuses a body that is not JSON (`invalid_json`, 400) or has no `ops` array (`ops_expected`, 400), and more than 100 ops in one request (`MAX_OPS`, `too_many_ops`, 413). The table below is the original design.

| endpoint | does |
|---|---|
| `GET /api/state` | snapshot of everything open: pool (+ recipes of pool meals), Courses (unbought + bought and on no trip), Reste (unfinished), open envies, meals cooked in the last 7 days, last trip, calibration |
| `GET /api/history?since=` | CLI only: plannings, meals, verdicts, notes, trips needed by variety and calibration rules |
| `POST /api/ops` | body `{ ops: [{ op_id, type, at, payload }] }`; applies in order; returns per-op result (`applied`/`noop`/`refused` + reason), `unrecorded` (the op ids answered without a stored record, §8.2) and a fresh snapshot |
| `GET /api/health` | `{ ok: true }` (exists) |

### 8.2 Ops semantics

- `op_id` is a client UUID. Already in `applied_ops` → the **stored** status and reason are returned again (replay-safe; a resent refused op still shows its refusal).
- A request loads the state once, applies its ops in order in memory and persists the result in **one** version-guarded `DB.batch` (Workers Free allows 50 D1 queries per invocation); a version conflict re-applies the whole request, up to 3 attempts. Noops and refusals are recorded without bumping the version. `POST /api/ops` requires `Content-Type: application/json` (415 otherwise). Each op touches only the rows its intent names plus the rows the domain derives from them (§6). There is no endpoint that writes a whole list.
- **Same intent twice** (two phones buy the same line): second is `noop`.
- **Target moved on** (undo after touch, cook a dropped meal): `refused` with a French reason string. Finishing an already-finished item is `noop` (same intent twice).
- **An op that throws** is answered as `refused` for that op alone and recorded nowhere, so a resend retries it; the request never fails as a whole.
- **Not recorded is not final.** An op answered without a stored record — it threw, every attempt hit a version conflict (« trop de modifications simultanées »), or D1 failed and its record could not be confirmed (« erreur interne ») — is listed in the response's `unrecorded` array. Its answer is always `refused` and says nothing about what a resend gets: the same op id is evaluated again, or replays a record that did land. A client keeps such an op and resends it under the same id; only an op absent from `unrecorded` has a final answer. A domain refusal is recorded, so it is final and never listed. A malformed op (an op id that is not a string, is empty or exceeds 100 characters, no type, a bad `at`) is refused « opération mal formée », recorded nowhere and never listed, even when D1 failed: no resend under the same id can change that answer, so it is final.
- `at` (client time) is used for `bought_at`/`cooked_at`: a full ISO-8601 date-time with seconds and an offset or Z (else refused as malformed), clamped to server time if in the future, stored as UTC.

### 8.3 Phone offline behaviour

- Service worker precaches the app shell and the font.
- The last snapshot is stored in IndexedDB and rendered immediately; refresh on open, on `visibilitychange` to visible, and on `online`. No polling.
- Each tap: apply optimistically to the local snapshot, append the op to an IndexedDB outbox, try to flush. On response: replace the snapshot with the server's; show refused ops as « N action(s) n'a/ont pas pu s'appliquer : … »; an op listed in `unrecorded` (§8.2) stays in the outbox and is resent under the same id. A handler bug answers « erreur interne » on every resend until it is fixed, so an op still listed in `unrecorded` after 5 resends is no longer resent automatically: it is shown as « en échec » with its last reason, leaves the « actions en attente » count, and offers « Réessayer » (same id) or « Abandonner ».
- While unsent ops exist: a muted line under the band « Hors ligne · 3 actions en attente ». Nothing when synced.
- **Access session expired:** an `/api` response that is an Access redirect (or non-JSON) is treated as « Reconnexion nécessaire »; the outbox is kept and nothing is retried until a successful login.
- Both phones must **add the app to the home screen** (iOS evicts storage of non-installed sites).

## 9. Infrastructure and security

### 9.1 Hosting and deploy

**Superseded.** No custom domain: the app is served at its Worker's own workers.dev address, and the deploy refuses any route or custom domain attached to the Worker. Workers Builds has no build command; it runs `npm run deploy:ci` on every push to `main`, which type-checks, tests and builds an export of the commit, checks Access before and after, records a D1 restore point, applies the pending migrations and deploys. The current rules are in [docs/deploy.md](deploy.md) and the `la-table-deploy` skill (`.claude/skills/la-table-deploy/SKILL.md`).

Still as designed: one Worker (static assets + `/api/*`) and one D1 database `la-table` on the Cloudflare free tier; migrations are additive only, a rename or drop happening only in a later release than the code that stopped using it.

### 9.2 Access and auth

**Superseded.** Cloudflare Access is set on the Worker itself, on its workers.dev address, with a public destination and the One-time PIN login method; its policy admits the two owners' email addresses and two service tokens, each kept in one place: the planning CLI's (`la-table-cli`) and the build's (`la-table-build`, in Workers Builds' build secrets only). The address is not a secret: Access is the protection. See [docs/deploy.md](deploy.md) and [docs/planning-cli.md](planning-cli.md).

Still as designed: the Worker verifies `Cf-Access-Jwt-Assertion` on every `/api/*` request except `/api/health` (signature against the team certs, `aud` = the application's tag); missing or invalid → 401 JSON. The local bypass `DEV_SKIP_ACCESS=1` holds only for a request to localhost under `wrangler dev` (`isLocalRequest` in `src/worker/auth.ts`), so it is inert on any deployed host, and a test asserts it is off without the variable. No secret in the repo.

### 9.3 Backups

- Every planning session starts with a remote export into `backups/` (gitignored).
- D1 point-in-time restore covers the days between.

## 10. Phone UX

Design identity: `DESIGN.md` ("Trois champs"). Each tab owns its field colour; the field shows the list name and a count. French throughout; dates written out (« jeudi 16 »); prices with a comma and €.

### 10.1 Menu (squash) — « 5 repas à cuisiner »

- Pool rows: cook-early meals first with their reason line, then the rest. Row: title, active time, portions. A meal a declared leftover left short of a product (`mealShortfalls`, `PoolMeal.shortfalls`, optional in the snapshot) adds one meta line « manque : comté 30 g, … ».
- The recipe view of such a meal shows the same list and an **Ajouter aux courses** button (existing `button` class) sending `meal.cover_shortfalls` (§6.5: free Reste stock, then Courses); the 5-second « Annuler » bar undoes it. The phone clears that meal's list at once and predicts nothing else (the Courses line, a shortfall a trim creates on another meal): the server's answer brings them. A CLI-only convention elsewhere, not enforcement: `HANDLERS` has no per-client allowlist.
- Tap → recipe view: ingredients scaled to the meal's portions, each marked « réservé » when held in Reste; numbered steps; source link; full-width **Cuisiné** button at the bottom.
- **Cuisiné sheet:** verdict (À refaire / Correct / Pas pour nous), note field, then each reserved Reste item with **Fini / Il en reste** (+ optional quantity text). Everything optional; a Fini on an item reserved for another meal opens the §10.4 warning first. One « Valider » sends one `meal.cook` op.
- Below the pool: « Cuisinés récemment » (collapsed; undo), then **Envies** with a one-line add field and the open envies.

### 10.2 Courses (leek) — « 14 à acheter »

- Add field for ajouts at the top (with a food / non-food toggle, default food).
- Lines grouped by category in a fixed order (fruits-légumes, boucherie-volaille, poissonnerie, crèmerie, épicerie, surgelés, then ajouts non alimentaires). Row: tick area, name, quantity, **estimated price right-aligned** (tabular figures). Ajouts and staples hors budget marked in `--muted`.
- Tapping the row ticks it; it moves to « Dans le panier » at the bottom.
- One row per product, unit and kind (decided 2026-10-14, `src/domain/course-groups.ts`): lines two plannings (or rebuys) each listed show as one row, quantities and prices summed. Data keeps one line each. A tick sends one `shopping.buy` per line the row was drawn with, so a line added since stays on the list; « Annuler » and an untick in « Dans le panier » take all of them back. The count « N à acheter » counts rows.
- **« Retirer » on every unbought row** (decided 2026-10-26): an ajout goes at once; a planned line or a staple opens a sheet (`#/courses/retirer/<id>`) titled « Retirer <product> », naming the open meals the row serves (« pour Cuisses de poulet rôties, … », the snapshot's `mealRefs` on each line, the open meals it serves by id and recipe (id and title); the sheet joins the row's lines by meal id, one name per recipe (counted by recipe id, so two different recipes with one title are listed apart), « ×2 » after a title two distinct open meals of one recipe share, even on two lines, and only those of the lines the sheet was drawn with when it opened, the ones the tap removes, read from their live data (decided 2026-10-27); nothing when none) and asking why: **« On en a déjà »** (`reason: a_la_maison`, the item enters Reste) or **« On n'en prend pas »** (`pas_achete`, a non-staple meal shows « manque » and « Ajouter aux courses » on its recipe; a staple is put back by the next planning if still low), and Annuler. A row of several lines sends one `shopping.remove` per line through one tap, and the 5 s « Annuler » bar takes them all back. The phone predicts only that the lines leave Courses; the Reste row and the « manque » come with the server's answer.
- Footer: « Total estimé 58 € · budget 70 € » (planning lines of the open plannings), then **Passage en caisse** → sheet: place, receipt total (optional), date (today).
- **Checkout: lines not on this receipt** (decided 2026-10-26): the sheet lists the basket's rows (`groupCourseLines`) as checkboxes, all checked. An unchecked row starts on **« Acheté sans ticket »** (decided 2026-10-26: the non-destructive answer, since the « Annuler » bar undoes a trip but never re-ticks an untick) and chooses **« Pas acheté »** (the untick of « Dans le panier »: `undo` of each line's buy; disabled, with « acheté il y a trop longtemps pour être annulé », when any line of the row has no `buyOpId`) or **« Acheté sans ticket »** (a `trip.record { noReceipt: true }`, place « autre », dated as the receipt (the sheet's date field), which stays visible, default today, when only « Acheté sans ticket » rows remain (decided 2026-10-26), no total, §6.5). On « Valider », once every check passed (a « Pas acheté » row whose untick is null, its undo window closed while the sheet was open, refuses with « <row> : acheté il y a trop longtemps pour être annulé » and sends nothing; decided 2026-10-27; the rows stay those pinned when the sheet opened, but whether each can still be taken back, for the disabled « Pas acheté » and for this refusal, is read from the live basket's lines of the same ids, decided 2026-10-27); a row a line of which has left the live basket cannot be taken back either but carries no « trop longtemps » note, since the sheet's changed-basket banner explains it (decided 2026-10-27), `sent` is set, the « Pas acheté » undos are sent, then one `actMany` carries the receipt `trip.record` (checked lines, place, total, date) and the no-receipt one, each only when its list is non-empty; no row checked → place and total are hidden (the date stays while a row is « Acheté sans ticket ») and no receipt trip is sent, except that a total field still holding text stays visible and « Valider » refuses with « Aucune ligne cochée pour ce ticket » until it is cleared or a row is checked (decided 2026-10-27: a typed total is never dropped unseen). The checkout is applied in parts: each `trip.record` is all-or-nothing on its own list (§6.5), but the undos and the two trips are independent ops, so a refused receipt trip leaves its lines in the basket with the refusal banner while the rest stands, and the owners check out again. « Pas acheté » is no op of its own but the undo of each line's buy, so it relies on that buy's undo window (§6.6, decided 2026-10-11: a line bought too long ago cannot be un-bought; the snapshot gives it no `buyOpId`, and the row offers « Acheté sans ticket » alone); a refused undo leaves its line in the basket with the usual refusal banner, whatever the trips did. The 5 s « Annuler » bar takes back both trips; it does not re-tick the « Pas acheté » rows.

### 10.3 Reste (tomato) — « 11 au frigo et au placard »

Sections in order: **À utiliser vite** (≤ 2 days, past dates included), **Réservé** (with « 100 g pour Salade d'endives »), **Libre** (with « ≈ 50 g libres » when computable), **Placard** (staples). Add field. Tap a row → sheet: Fini / Il en reste / Changer la date.

### 10.4 Reservation warning

On Fini for a reserved item: « Réservé pour Salade d'endives » with two actions, **Retirer le repas** and **Racheter**, plus Annuler. The op is sent only with the chosen resolution.

### 10.5 Common

- Tap targets ≥ 44 px; the whole row is the target.
- Every tick shows « Annuler » for 5 s.
- Empty states name the next step (« Rien à cuisiner. Prochaine planification dans Claude Code. »).
- No login screen (Access). Light/dark via `prefers-color-scheme`.
- Every screen passes a design critique of the rendered page (both schemes, phone width) before it is called done.

## 11. Testing

- **Integers everywhere** (cents, base units): equality assertions, no tolerance.
- **Domain unit tests:** every rule in `rules.config.ts` (each block and warn case); every op in §6 including each refusal; shelf-life and opened-date logic; season lookup with exceptions; unit conversion.
- **Property tests** (`fast-check`, ≥ 1000 runs, `*.property.test.ts`):
  1. aggregation conserves quantities: list qty per (product, unit) = Σ needs − libre stock reserved;
  2. the domain invariants (`src/domain/invariants.ts`) hold **after every op**: reservations on existing rows, on unfinished items, for open meals, within what an item holds; every open meal covered exactly at its need, less what a declared leftover (§6.3) or a line removed « On n'en prend pas » (§6.5, at most that line's share per meal, product and unit, of the meals open at the removal) left it short of; an open second round with a closed first round holds its plat cuisiné; no cooked second round before its first; no dropped meal's share on Courses; no open meal's share on a removed line (decided 2026-10-27); after every meal needing an item is cooked or dropped, no unreleased reservation remains;
  3. idempotence: any op sequence applied twice = applied once;
  4. offline = online: a sequence queued then replayed = the same taps applied live;
  5. each planning's `estimate_cents` = Σ its lines at commit; after drops, every priced line without a pack stays proportional to its remaining quantity (within half a cent per share taken off), a line with one stays in whole packs and is priced pro rata of its quantity, a drop never raises a line's qty or price, and the Courses total = Σ its lines.
- **API tests through the real Worker entry point** with the JWT check in the path: no token → 401; wrong `aud` → 401; bypass only with `DEV_SKIP_ACCESS=1`. Run on local D1 with real migrations (`@cloudflare/vitest-plugin`).
- **CLI tests:** one fixture per violation (must exit 1 naming the rule) and one clean fixture (must exit 0); missing keychain secret → exit 2.
- **Seed data tests:** every `is_fresh_produce` product has `season_months` or is an exception; every category and role is in the known vocabulary; every product with a perishable category has `shelf_life_days`.
- **End-to-end (Playwright, two browser contexts):** offline tick → reload → online → server state; two phones tick the same line → one applied, one noop; **acceptance scenario, the cheese story:** plan two recipes × 100 g comté → buy 200 g → cook the first → the other context shows « réservé : 100 g pour … » → Fini → reservation warning.
- **UI:** no component unit tests (portfolio convention); the build gate catches broken imports; design-critique on every screen.
- Every bug fix lands with a regression test (`// Regression: <hash> — <description>`).

## 12. Out of scope (decided)

- **Push notifications** for urgency (planned later, the owners' choice).
- **Nutrition numbers** (CIQUAL per-portion estimates) — composition rules only; numbers are a later add-on if missed.
- **Live sync** between phones — refresh on open/focus/online is enough.
- Meals other than those eaten together at home; calendar days on meals; per-meal price bounds; quantity arithmetic on Reste beyond purchase amounts; history/spending screens; a dedicated cooking view.
- Any user other than the two owners.

## 13. Changes to the existing scaffold

**Superseded.** Done when the app replaced the scaffold, in October 2026: the first migration became the §4 schema, and the README and the planning skill describe the app as it is. [README.md](../README.md) is the current entry point.
