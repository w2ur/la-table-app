import { daysBetween, parisDate } from "../domain/dates";
import { groupCourseLines } from "../domain/course-groups";
import type { RecipeNutrition } from "../domain/nutrition";
import type { CourseLine, PoolMeal, ResteItem } from "../domain/snapshot";
import type { EnvieStatus, Verdict } from "../domain/types";
import { formatDay, formatDayMonth, isWebUrl } from "../domain/text";
import { formatEuros, formatQty, parseEuros, unitName, type Unit } from "../domain/units";
import type { ConnStatus, Refusal } from "./sync/types";

export type Tab = "menu" | "courses" | "reste";
export const TABS: readonly Tab[] = ["menu", "courses", "reste"];
export const TAB_TITLE: Record<Tab, string> = { menu: "Menu", courses: "Courses", reste: "Reste" };

/** The count under the list name in the field (spec §10): « 5 repas à cuisiner », « 14 à acheter », « 11 au frigo et au placard ». */
export function countLine(tab: Tab, n: number): string {
  if (tab === "menu") return n === 0 ? "rien à cuisiner" : `${n} repas à cuisiner`;
  if (tab === "courses") return n === 0 ? "rien à acheter" : `${n} à acheter`;
  return n === 0 ? "rien au frigo ni au placard" : `${n} au frigo et au placard`;
}

/** What `counts` reads: a snapshot or the app's projected view. */
export interface Countable {
  menu: { pool: readonly unknown[] };
  courses: { lines: readonly CourseLine[] };
  reste: { urgent: readonly unknown[]; reserved: readonly unknown[]; libre: readonly unknown[]; placard: readonly unknown[] };
}

export function counts(view: Countable): Record<Tab, number> {
  const { urgent, reserved, libre, placard } = view.reste;
  return {
    menu: view.menu.pool.length,
    // rows, as Courses shows them: one per product, unit and kind
    courses: groupCourseLines(view.courses.lines.filter((l) => l.boughtAt === null)).length,
    reste: urgent.length + reserved.length + libre.length + placard.length,
  };
}

/** A quantity as the app writes it (`1,5 kg`, `25 cl`, `3 pièces`); nothing when unknown. */
export function qtyText(qty: number | null, unit: Unit | null): string {
  if (qty === null || unit === null) return "";
  return unit === "piece" ? `${qty} ${unitName(unit, qty)}` : formatQty(qty, unit);
}

/** A price cell: `12,50 €`; nothing when unknown (ajouts are priced at the next planning, spec §5.5). */
export function priceText(cents: number | null): string {
  return cents === null ? "" : formatEuros(cents);
}

/** « jeudi 16 » within six days of today, « samedi 31 octobre » beyond. */
export function dateLabel(date: string, today: string): string {
  return Math.abs(daysBetween(today, date)) <= 6 ? formatDay(date) : formatDayMonth(date);
}

/** What the recipe meta reads; a recent meal stored by an older app has none of it (snapshot.ts `RecentMeal`). */
type MealTimes = Partial<Pick<PoolMeal, "activeMin" | "totalMin" | "portions" | "isSecondRound">>;

const timesParts = (meal: MealTimes): string[] => {
  const parts: string[] = [];
  if (meal.activeMin !== undefined) parts.push(`${meal.activeMin} min`);
  if (meal.portions !== undefined) parts.push(`${meal.portions} portion${meal.portions > 1 ? "s" : ""}`);
  if (meal.isSecondRound === true) parts.push("second tour");
  return parts;
};

/** Under a pool meal short of a product (a declared leftover trimmed its hold, spec §6.3): « manque : comté 30 g, œuf 2 pièces »; nothing when it lacks none, or its snapshot predates the field. */
export function shortfallMeta(meal: Pick<PoolMeal, "shortfalls">): string {
  const lacks = (meal.shortfalls ?? []).map((s) => `${s.label} ${qtyText(s.qty, s.unit)}`);
  return lacks.length === 0 ? "" : `manque : ${lacks.join(", ")}`;
}

export function mealMeta(meal: Pick<PoolMeal, "activeMin" | "portions" | "isSecondRound">): string {
  return timesParts(meal).join(" · ");
}

/** Under a recipe's title (spec §10.1): the meal meta, then the total time when longer; only the parts the meal has. */
export function recipeMeta(meal: MealTimes): string {
  const parts = timesParts(meal);
  if (meal.totalMin !== undefined && meal.totalMin > (meal.activeMin ?? 0)) parts.push(`${meal.totalMin} min en tout`);
  return parts.join(" · ");
}

const NB = "\u00a0";

/**
 * One portion's nutrition (Ciqual values): kcal and grams to the unit, salt to one decimal, then the ingredients not
 * counted when there are any (no values, or no weight for their unit). No-break spaces keep a figure with its unit and
 * nutrient when the line wraps on a phone.
 */
export function nutritionLine(n: RecipeNutrition): string {
  const p = n.perPortion;
  const grams = (g: number, name: string) => `${Math.round(g)}${NB}g${NB}${name}`;
  const line = [
    `${Math.round(p.kcal)}${NB}kcal`, grams(p.proteinG, "protéines"), grams(p.carbsG, "glucides"), grams(p.fatG, "lipides"), grams(p.fibreG, "fibres"),
    `${p.saltG.toFixed(1).replace(".", ",")}${NB}g${NB}sel`,
  ].join(" · ");
  return n.missing.length > 0 ? `${line} · partiel : sans ${n.missing.join(", ")}` : line;
}

/** Under the recipe's meta: « Par portion : … », or nothing (`!= null`: a snapshot stored by an older app has no nutrition). */
export function mealNutritionMeta(meal: { nutrition?: RecipeNutrition | null }): string | null {
  return meal.nutrition != null ? `Par portion : ${nutritionLine(meal.nutrition)}` : null;
}

/** Under a Courses line: its quantity, what keeps it out of the budget (spec §10.2), and « en attente » while unsynced. */
export function lineMeta(line: Pick<CourseLine, "qty" | "unit" | "kind" | "isFood"> & { pending?: boolean }): string {
  const parts = [qtyText(line.qty, line.unit)];
  if (line.kind === "staple_hors_budget") parts.push("hors budget");
  if (line.kind === "ajout") parts.push(line.isFood ? "ajout" : "ajout non alimentaire");
  if (line.pending) parts.push("en attente");
  return parts.filter((p) => p !== "").join(" · ");
}

/**
 * Whether a Reste row offers « Fini » beside it (decided 2026-10-25): an item at a known 0 that no meal holds, synced.
 * Nothing is finished without a tap (§6.7); this one tap replaces opening the sheet. A held item keeps the sheet and its
 * reservation warning (§10.4); words of unknown quantity are not a zero.
 */
export function finishFromRow(item: Pick<ResteItem, "qty" | "reservations"> & { pending?: boolean }): boolean {
  return item.qty === 0 && item.reservations.length === 0 && item.pending !== true;
}

/**
 * Under a Reste item (spec §10.3): amount, low, date, each reservation, and the libre remainder of a reserved item.
 * Whether the date has passed is judged against `today`, not the snapshot's `daysLeft`: offline, the snapshot can be days old.
 */
export function resteMeta(item: ResteItem & { pending?: boolean }, today: string): string {
  const parts: string[] = [];
  const amount = item.qtyText ?? qtyText(item.qty, item.unit);
  if (amount !== "") parts.push(amount);
  if (item.isLow) parts.push("presque fini");
  if (item.useBy !== null) {
    parts.push(daysBetween(today, item.useBy) < 0 ? `date passée : ${dateLabel(item.useBy, today)}` : `jusqu'au ${dateLabel(item.useBy, today)}`);
  }
  for (const r of item.reservations) parts.push(`${qtyText(r.qty, r.unit) || "réservé"} pour ${r.mealTitle}`);
  if (item.reservations.length > 0 && item.libreQty !== null && item.libreQty > 0 && item.unit !== null) {
    parts.push(`≈ ${qtyText(item.libreQty, item.unit)} ${item.libreQty > 1 ? "libres" : "libre"}`);
  }
  if (item.pending) parts.push("en attente");
  return parts.join(" · ");
}

const WAITING_BECAUSE: Record<Exclude<ConnStatus, "online">, string> = {
  offline: "Hors ligne",
  reauth: "Reconnexion nécessaire",
  server: "Serveur injoignable",
};

/** The muted line under the field (spec §8.3): nothing when synced; a lapsed login shows even with nothing waiting. */
export function statusLine(status: ConnStatus, waiting: number): string | null {
  if (status === "online") return null;
  const why = WAITING_BECAUSE[status];
  if (waiting === 0) return status === "reauth" ? why : null;
  return `${why} · ${waiting} action${waiting > 1 ? "s" : ""} en attente`;
}

/** « N action(s) n'a/ont pas pu s'appliquer : … » (spec §8.3). */
export function refusalLine(refusals: readonly Refusal[]): string {
  const n = refusals.length;
  const what = refusals.map((r) => `${r.label} (${r.reason})`).join(" ; ");
  return `${n} action${n > 1 ? "s n'ont" : " n'a"} pas pu s'appliquer : ${what}`;
}

/**
 * A Cuisiné sheet the other phone's cook made the server drop (outbox.ts `sheetDropped`): « Déjà cuisiné sur l'autre téléphone : votre avis et vos « Fini » n'ont pas été enregistrés (Cuisiné :
 * Colin au comté). » Its own line, not « n'a pas pu s'appliquer »: the meal is cooked, as the tap asked.
 */
export function droppedSheetLine(labels: readonly string[]): string {
  return `Déjà cuisiné sur l'autre téléphone : votre avis et vos « Fini » n'ont pas été enregistrés (${labels.join(" ; ")}).`;
}

/** « Total estimé 58 € · budget 70 € » (spec §10.2), the budget left out when no planning line is shown. */
export function totalsLine(estimateCents: number, budgetCents: number): string {
  const total = `Total estimé ${formatEuros(estimateCents)}`;
  return budgetCents > 0 ? `${total} · budget ${formatEuros(budgetCents)}` : total;
}

export const RECEIPT_MESSAGES = {
  format: "Montant en euros, par exemple 42,50.",
  zero: "Un total de 0 € n'est pas un ticket.",
  missing: "Saisissez le total du ticket.",
} as const;

/**
 * A receipt total typed on the phone → integer cents, through the CLI's own parser; a trailing « € » is allowed. Empty
 * is « no total yet » (spec §6.5 `trip.record`, total optional) unless `required` (the later ticket sheet). 0 € is no
 * ticket, as the CLI's `total` says. With `required`, a total that parses is never null.
 */
export function parseReceipt(text: string, required: true): { ok: true; cents: number } | { ok: false; message: string };
export function parseReceipt(text: string, required?: boolean): { ok: true; cents: number | null } | { ok: false; message: string };
export function parseReceipt(text: string, required = false): { ok: true; cents: number | null } | { ok: false; message: string } {
  const typed = text.trim().replace(/\s*€$/, "");
  if (typed === "") {
    if (text.trim() !== "") return { ok: false, message: RECEIPT_MESSAGES.format }; // « € » alone
    return required ? { ok: false, message: RECEIPT_MESSAGES.missing } : { ok: true, cents: null };
  }
  const cents = parseEuros(typed);
  if (cents === null) return { ok: false, message: RECEIPT_MESSAGES.format };
  if (cents === 0) return { ok: false, message: RECEIPT_MESSAGES.zero };
  return { ok: true, cents };
}

/** A YYYY-MM-DD that names a day that exists (no 31 February). */
function isCalendarDay(text: string): boolean {
  const day = new Date(`${text}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
}

/** A trip date from the date field: a real calendar day, not after today. */
export function parseTripDate(text: string, today: string): { ok: true; date: string } | { ok: false; message: string } {
  if (!isCalendarDay(text)) return { ok: false, message: "Choisissez une date." };
  if (text > today) return { ok: false, message: "La date ne peut pas être après aujourd'hui." };
  return { ok: true, date: text };
}

/** A use-by from « Changer la date »: any real calendar day, a past one included (a correction, spec §6.5). */
export function parseUseBy(text: string): { ok: true; date: string } | { ok: false; message: string } {
  return isCalendarDay(text) ? { ok: true, date: text } : { ok: false, message: "Choisissez une date." };
}

/** The verdicts of the Cuisiné sheet (spec §10.1), in the order shown. */
export const VERDICTS: readonly { value: Verdict; label: string }[] = [
  { value: "a_refaire", label: "À refaire" },
  { value: "correct", label: "Correct" },
  { value: "pas_pour_nous", label: "Pas pour nous" },
];

/** What names each phone action in « Annuler », « en échec » and refusals. */
export const ACTION_LABEL = {
  cook: (title: string) => `Cuisiné : ${title}`,
  drop: (title: string) => `Retiré du menu : ${title}`,
  cover: (title: string) => `Ajouté aux courses : ${title}`,
  finish: (label: string) => `Fini : ${label}`,
  partial: (label: string) => `Il en reste : ${label}`,
  useBy: (label: string) => `Nouvelle date : ${label}`,
  stockAdd: (label: string) => `Ajouté au Reste : ${label}`,
  envie: (text: string) => `Envie : ${text}`,
} as const;

/**
 * An ingredient in the recipe view, scaled to the meal (spec §10.1): its quantity, and « réservé » when Reste holds it
 * for an open meal (a cooked one holds nothing).
 */
export function ingredientMeta(ingredient: Pick<PoolMeal["ingredients"][number], "qty" | "unit"> & { reserved?: boolean }): string {
  const amount = qtyText(ingredient.qty, ingredient.unit);
  return ingredient.reserved ? `${amount} · réservé` : amount;
}

/** Under a meal of « Cuisinés récemment »: the day it was cooked, and that its undo waits while it does. */
export function cookedMeta(cookedAt: string, today: string, undoing: boolean): string {
  const day = `cuisiné ${dateLabel(parisDate(cookedAt), today)}`;
  return undoing ? `${day} · annulation en attente` : day;
}

/** The reservation warning (spec §10.4): « Réservé pour Salade d'endives », each meal named once. */
export function reservedFor(titles: readonly string[]): string {
  return `Réservé pour ${[...new Set(titles)].join(", ")}`;
}

/**
 * An envie typed on one line (a dish, a link, « quelque chose avec des poireaux »): its first web address is its link,
 * when it parses as one. A mistyped address is left in the text without a link, since the domain refuses the envie it
 * would be the link of.
 */
export function parseEnvie(typed: string): { text: string; url: string | null } | null {
  const text = typed.trim().replace(/\s+/g, " ");
  if (text === "") return null;
  const found = /https?:\/\/\S+/i.exec(text)?.[0];
  const url = found === undefined ? null : trimLinkEnd(found);
  return { text, url: isWebUrl(url) ? url : null };
}

/** The punctuation a sentence puts after a link, off its end; a « ) » only when no « ( » of the link opens it. */
function trimLinkEnd(found: string): string {
  let url = found;
  for (;;) {
    url = url.replace(/[.,;:!?»]+$/, "");
    if (!url.endsWith(")") || url.split("(").length >= url.split(")").length) return url;
    url = url.slice(0, -1);
  }
}

/** Under an envie: kept by a planning for a later one, and « en attente » while unsynced. */
export function envieMeta(envie: { status: EnvieStatus; pending?: boolean }): string {
  const parts: string[] = [];
  if (envie.status === "gardee") parts.push("gardée pour plus tard");
  if (envie.pending) parts.push("en attente");
  return parts.join(" · ");
}

/** Under an item answered « Fini » once the reservation warning chose (spec §10.4): what happens to the meals it held. */
export function resolutionMeta(resolution: "drop_meal" | "rebuy", titles: readonly string[]): string {
  const meals = [...new Set(titles)].join(", ");
  return resolution === "drop_meal" ? `Fini · ${meals} : retiré du menu` : `Fini · racheté pour ${meals}`;
}
