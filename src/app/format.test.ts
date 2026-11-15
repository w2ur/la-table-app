import { describe, expect, it } from "vitest";
import { applyOp } from "../domain/ops/apply";
import { snapshot, type ResteItem } from "../domain/snapshot";
import { NOW, P, fixtureProposal, fixtureState, op } from "../domain/test-fixtures";
import { COURSE_GROUPS, GROUP_LABELS } from "../domain/vocabulary";
import {
  ACTION_LABEL, cookedMeta, mealNutritionMeta, nutritionLine, countLine, counts, dateLabel, droppedSheetLine, envieMeta, ingredientMeta, lineMeta, mealMeta, parseEnvie, recipeMeta, shortfallMeta, parseReceipt, parseTripDate,
  finishFromRow, parseUseBy, priceText, qtyText, RECEIPT_MESSAGES, refusalLine, reservedFor, resolutionMeta, resteMeta, statusLine, totalsLine, VERDICTS,
} from "./format";

describe("countLine", () => {
  it("writes the count under each list name, and names an empty list", () => {
    expect(countLine("menu", 5)).toBe("5 repas à cuisiner");
    expect(countLine("menu", 1)).toBe("1 repas à cuisiner");
    expect(countLine("menu", 0)).toBe("rien à cuisiner");
    expect(countLine("courses", 14)).toBe("14 à acheter");
    expect(countLine("courses", 0)).toBe("rien à acheter");
    expect(countLine("reste", 11)).toBe("11 au frigo et au placard");
    expect(countLine("reste", 0)).toBe("rien au frigo ni au placard");
  });
});

describe("counts", () => {
  it("counts the pool, the lines still to buy and every Reste section", () => {
    let s = applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;
    const comte = s.shoppingItems.find((l) => l.productId === P.comte)!;
    s = applyOp(s, op("shopping.buy", { itemId: comte.id }), NOW).state;
    const snap = snapshot(s, NOW);
    expect(counts(snap)).toEqual({ menu: 3, courses: snap.courses.lines.length - 1, reste: 1 });
  });

  it("counts a product two plannings each listed as one row to buy, as Courses shows it", () => {
    const snap = snapshot(applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state, NOW);
    const poireau = snap.courses.lines.find((l) => l.label === "poireau")!;
    const twice = { ...snap, courses: { ...snap.courses, lines: [...snap.courses.lines, { ...poireau, id: 99 }] } };
    expect(counts(twice).courses).toBe(snap.courses.lines.length);
  });
});

describe("quantities, prices, dates", () => {
  it("writes quantities as the app does, and nothing when unknown", () => {
    expect(qtyText(1500, "g")).toBe("1,5 kg");
    expect(qtyText(250, "ml")).toBe("25 cl");
    expect(qtyText(3, "piece")).toBe("3 pièces");
    expect(qtyText(1, "piece")).toBe("1 pièce");
    expect(qtyText(null, null)).toBe("");
    expect(qtyText(5, null)).toBe("");
  });

  it("writes a price with a comma and the euro sign, and nothing when unknown", () => {
    expect(priceText(1250)).toBe("12,50 €");
    expect(priceText(1200)).toBe("12 €");
    expect(priceText(null)).toBe("");
  });

  it("writes a date as its day within six days of today, and with its month beyond", () => {
    expect(dateLabel("2026-10-15", "2026-10-12")).toBe("jeudi 15");
    expect(dateLabel("2026-10-11", "2026-10-12")).toBe("dimanche 11");
    expect(dateLabel("2026-10-31", "2026-10-12")).toBe("samedi 31 octobre");
    expect(dateLabel("2026-10-05", "2026-10-12")).toBe("lundi 5 octobre");
  });
});

describe("row metas", () => {
  it("describes a pool meal", () => {
    expect(mealMeta({ activeMin: 25, portions: 2, isSecondRound: false })).toBe("25 min · 2 portions");
    expect(mealMeta({ activeMin: 20, portions: 1, isSecondRound: true })).toBe("20 min · 1 portion · second tour");
  });

  it("names what a pool meal lacks, and nothing for a meal that lacks none or a snapshot stored before the field", () => {
    expect(shortfallMeta({ shortfalls: [{ label: "comté", qty: 30, unit: "g" }, { label: "œuf", qty: 2, unit: "piece" }] })).toBe("manque : comté 30 g, œuf 2 pièces");
    expect(shortfallMeta({ shortfalls: [] })).toBe("");
    expect(shortfallMeta({})).toBe("");
  });

  it("describes a recipe under its title, its total time when longer, and only what a recent meal stored by an older app has", () => {
    expect(recipeMeta({ activeMin: 20, totalMin: 50, portions: 2, isSecondRound: false })).toBe("20 min · 2 portions · 50 min en tout");
    expect(recipeMeta({ activeMin: 20, totalMin: 20, portions: 2, isSecondRound: false })).toBe("20 min · 2 portions");
    expect(recipeMeta({ portions: 3 })).toBe("3 portions");
    expect(recipeMeta({})).toBe("");
    // an ingredient of a cooked meal carries no reservation
    expect(ingredientMeta({ qty: 100, unit: "g" })).toBe("100 g");
  });

  it("describes a Courses line: quantity, then what keeps it out of the budget, then « en attente »", () => {
    expect(lineMeta({ qty: 400, unit: "g", kind: "planning", isFood: true })).toBe("400 g");
    expect(lineMeta({ qty: 150, unit: "g", kind: "staple_hors_budget", isFood: true })).toBe("150 g · hors budget");
    expect(lineMeta({ qty: null, unit: null, kind: "ajout", isFood: true })).toBe("ajout");
    expect(lineMeta({ qty: null, unit: null, kind: "ajout", isFood: false, pending: true })).toBe("ajout non alimentaire · en attente");
  });

  it("offers « Fini » on the row of a synced item at a known 0 that no meal holds, and only there", () => {
    const at0 = { qty: 0, reservations: [] };
    expect(finishFromRow(at0)).toBe(true);
    expect(finishFromRow({ ...at0, qty: 50 })).toBe(false);
    expect(finishFromRow({ ...at0, qty: null })).toBe(false);
    expect(finishFromRow({ ...at0, pending: true })).toBe(false);
    expect(finishFromRow({ ...at0, reservations: [{ mealId: 2, mealTitle: "Salade", qty: 0, unit: "g" as const }] })).toBe(false);
  });

  it("describes a Reste item: amount, low, date, what it is reserved for, and what is left libre", () => {
    const item: ResteItem = {
      id: 1, label: "comté", qty: 200, unit: "g", qtyText: null, isLow: false, useBy: "2026-10-15", daysLeft: 3, libreQty: 100,
      reservations: [{ mealId: 2, mealTitle: "Salade d'endives", qty: 100, unit: "g" }], isStaple: false,
    };
    expect(resteMeta(item, "2026-10-12")).toBe("200 g · jusqu'au jeudi 15 · 100 g pour Salade d'endives · ≈ 100 g libres");
    expect(resteMeta({ ...item, reservations: [], libreQty: 200 }, "2026-10-12")).toBe("200 g · jusqu'au jeudi 15");
    expect(resteMeta({
      ...item, qty: null, unit: null, qtyText: "un peu", isLow: true, useBy: "2026-10-11", daysLeft: -1, libreQty: null,
      reservations: [{ mealId: 2, mealTitle: "Gratin", qty: null, unit: null }],
    }, "2026-10-12")).toBe("un peu · presque fini · date passée : dimanche 11 · réservé pour Gratin");
    expect(resteMeta({
      ...item, qty: 3, unit: "piece", useBy: null, daysLeft: null, libreQty: 1,
      reservations: [{ mealId: 4, mealTitle: "Omelette", qty: 2, unit: "piece" }],
    }, "2026-10-12")).toBe("3 pièces · 2 pièces pour Omelette · ≈ 1 pièce libre");
  });

  // Regression: ad72d1e — a Reste date read « jusqu'au » after it had passed, from the snapshot's day offline
  it("says a Reste date has passed by today's day, even when the snapshot was made before it", () => {
    const item: ResteItem = {
      id: 1, label: "crème", qty: 200, unit: "ml", qtyText: null, isLow: false, useBy: "2026-10-11", daysLeft: 1, libreQty: 20,
      reservations: [], isStaple: false,
    }; // daysLeft from a snapshot made on the 10th
    expect(resteMeta(item, "2026-10-12")).toBe("20 cl · date passée : dimanche 11");
    expect(resteMeta(item, "2026-10-11")).toBe("20 cl · jusqu'au dimanche 11");
  });
});

describe("status lines", () => {
  it("says nothing when synced, and names why ops wait otherwise (spec §8.3)", () => {
    expect(statusLine("online", 3)).toBeNull();
    expect(statusLine("offline", 0)).toBeNull();
    expect(statusLine("offline", 1)).toBe("Hors ligne · 1 action en attente");
    expect(statusLine("offline", 3)).toBe("Hors ligne · 3 actions en attente");
    expect(statusLine("reauth", 0)).toBe("Reconnexion nécessaire");
    expect(statusLine("reauth", 2)).toBe("Reconnexion nécessaire · 2 actions en attente");
    expect(statusLine("server", 1)).toBe("Serveur injoignable · 1 action en attente");
    expect(statusLine("server", 0)).toBeNull();
  });

  it("lists refused actions with their reason, agreeing in number", () => {
    expect(refusalLine([{ label: "Acheté : comté", reason: "déjà passé en caisse" }])).toBe(
      "1 action n'a pas pu s'appliquer : Acheté : comté (déjà passé en caisse)",
    );
    expect(refusalLine([{ label: "A", reason: "r1" }, { label: "B", reason: "r2" }])).toBe("2 actions n'ont pas pu s'appliquer : A (r1) ; B (r2)");
  });

  it("says which Cuisiné sheets the other phone's cook made the server drop", () => {
    expect(droppedSheetLine([ACTION_LABEL.cook("Colin au comté")])).toBe(
      "Déjà cuisiné sur l'autre téléphone : votre avis et vos « Fini » n'ont pas été enregistrés (Cuisiné : Colin au comté).",
    );
    expect(droppedSheetLine(["Cuisiné : A", "Cuisiné : B"])).toBe(
      "Déjà cuisiné sur l'autre téléphone : votre avis et vos « Fini » n'ont pas été enregistrés (Cuisiné : A ; Cuisiné : B).",
    );
  });

  it("writes the Courses total against the budget, or alone when no planning budget is shown", () => {
    expect(totalsLine(5800, 7000)).toBe("Total estimé 58 € · budget 70 €");
    expect(totalsLine(5840, 0)).toBe("Total estimé 58,40 €");
  });
});

describe("course groups", () => {
  it("keeps the shop's order and the CLI's labels, ajouts last", () => {
    expect(COURSE_GROUPS.map((g) => GROUP_LABELS[g])).toEqual([
      "Fruits et légumes", "Boucherie, volaille", "Poissonnerie", "Crèmerie", "Épicerie", "Surgelés", "Ajouts",
    ]);
  });
});

describe("checkout input", () => {
  it("accepts a past or today's date and refuses a later one or a malformed one", () => {
    expect(parseTripDate("2026-10-12", "2026-10-12")).toEqual({ ok: true, date: "2026-10-12" });
    expect(parseTripDate("2026-10-01", "2026-10-12")).toEqual({ ok: true, date: "2026-10-01" });
    expect(parseTripDate("2026-10-13", "2026-10-12")).toEqual({ ok: false, message: "La date ne peut pas être après aujourd'hui." });
    for (const bad of ["", "2026-02-31", "12/10/2026", "2026-1-5"]) expect(parseTripDate(bad, "2026-10-12"), bad).toEqual({ ok: false, message: "Choisissez une date." });
  });

  // a receipt typed loosely becomes exact cents, or a message before anything is sent
  it("reads a receipt total into integer cents, empty as « no total yet », and refuses the rest in French", () => {
    const cents = (text: string) => parseReceipt(text);
    expect(cents("42,50")).toEqual({ ok: true, cents: 4250 });
    expect(cents("42,5")).toEqual({ ok: true, cents: 4250 });
    expect(cents("42.5")).toEqual({ ok: true, cents: 4250 });
    expect(cents("42")).toEqual({ ok: true, cents: 4200 });
    expect(cents(" 42,50 € ")).toEqual({ ok: true, cents: 4250 });
    expect(cents("42,50€")).toEqual({ ok: true, cents: 4250 });
    expect(cents("")).toEqual({ ok: true, cents: null });
    expect(cents("   ")).toEqual({ ok: true, cents: null });
    for (const zero of ["0", "0,00", "0 €"]) expect(cents(zero), zero).toEqual({ ok: false, message: RECEIPT_MESSAGES.zero });
    for (const bad of ["42,555", "-3", "abc", "1 234,50", "12345678", "4,2,5", "€"]) expect(cents(bad), bad).toEqual({ ok: false, message: RECEIPT_MESSAGES.format });
    expect(parseReceipt("", true)).toEqual({ ok: false, message: RECEIPT_MESSAGES.missing });
    expect(parseReceipt("18,90", true)).toEqual({ ok: true, cents: 1890 });
  });
});

describe("Menu and Reste actions", () => {
  it("marks a reserved ingredient, and says when a meal was cooked, by the Paris day, and that its undo waits", () => {
    expect(ingredientMeta({ qty: 100, unit: "g", reserved: true })).toBe("100 g · réservé");
    expect(ingredientMeta({ qty: 2, unit: "piece", reserved: false })).toBe("2 pièces");
    // 22:30 UTC on the 12th is 00:30 on Tuesday 13 in Paris
    expect(cookedMeta("2026-10-12T22:30:00.000Z", "2026-10-13", false)).toBe("cuisiné mardi 13");
    expect(cookedMeta("2026-10-12T09:00:00.000Z", "2026-10-13", true)).toBe("cuisiné lundi 12 · annulation en attente");
  });

  it("names the meals a reserved item is held for once each, and every action by what it touched", () => {
    expect(reservedFor(["Salade d'endives"])).toBe("Réservé pour Salade d'endives");
    expect(reservedFor(["Gratin", "Salade", "Gratin"])).toBe("Réservé pour Gratin, Salade");
    expect(ACTION_LABEL.cook("Gratin")).toBe("Cuisiné : Gratin");
    expect(ACTION_LABEL.finish("comté")).toBe("Fini : comté");
    expect(VERDICTS.map((v) => v.label)).toEqual(["À refaire", "Correct", "Pas pour nous"]);
    expect(resolutionMeta("drop_meal", ["Salade", "Salade"])).toBe("Fini · Salade : retiré du menu");
    expect(resolutionMeta("rebuy", ["Salade", "Gratin"])).toBe("Fini · racheté pour Salade, Gratin");
  });

  it("reads an envie typed on one line, its first web address as its link, and nothing from blanks", () => {
    expect(parseEnvie("  un curry   de lentilles ")).toEqual({ text: "un curry de lentilles", url: null });
    expect(parseEnvie("tarte https://example.org/tarte?x=1 ou http://autre.fr")).toEqual({
      text: "tarte https://example.org/tarte?x=1 ou http://autre.fr", url: "https://example.org/tarte?x=1",
    });
    // Regression: 52cd380 — a link closing a sentence kept its full stop
    expect(parseEnvie("voir https://x.fr/tarte.")?.url).toBe("https://x.fr/tarte");
    expect(parseEnvie("(voir https://x.fr/tarte?a=1), merci")?.url).toBe("https://x.fr/tarte?a=1");
    // Regression: 9bf7aae — a link ending on a « ) » it opened itself lost it, and pointed at another page
    expect(parseEnvie("https://fr.wikipedia.org/wiki/Phở_(soupe)")?.url).toBe("https://fr.wikipedia.org/wiki/Phở_(soupe)");
    expect(parseEnvie("un phở (https://fr.wikipedia.org/wiki/Phở_(soupe)).")?.url).toBe("https://fr.wikipedia.org/wiki/Phở_(soupe)");
    expect(parseEnvie("   ")).toBeNull();
    // Regression: 80e3012 — a mistyped address the domain refuses made the whole envie refused, its text lost with it
    for (const typed of ["voir https://x.fr:abc", "tarte http://[x"]) {
      const envie = parseEnvie(typed);
      expect(envie, typed).toEqual({ text: typed, url: null });
      expect(applyOp(fixtureState(), op("envie.add", envie), NOW).result, typed).toEqual({ status: "applied", reason: null });
    }
    expect(envieMeta({ status: "ouverte" })).toBe("");
    expect(envieMeta({ status: "gardee", pending: false })).toBe("gardée pour plus tard");
    expect(envieMeta({ status: "ouverte", pending: true })).toBe("en attente");
  });

  it("takes any real day as a use-by, a past one included, and says « en attente » under an item not yet synced", () => {
    expect(parseUseBy("2026-10-01")).toEqual({ ok: true, date: "2026-10-01" });
    expect(parseUseBy("2027-01-31")).toEqual({ ok: true, date: "2027-01-31" });
    for (const bad of ["", "2026-02-30", "31/10/2026"]) expect(parseUseBy(bad), bad).toEqual({ ok: false, message: "Choisissez une date." });
    const item: ResteItem = {
      id: -1, label: "olives", qty: null, unit: null, qtyText: null, isLow: false, useBy: null, daysLeft: null, libreQty: null, reservations: [], isStaple: false,
    };
    expect(resteMeta({ ...item, pending: true }, "2026-10-12")).toBe("en attente");
    expect(resteMeta({ ...item, qtyText: "un bocal", pending: false }, "2026-10-12")).toBe("un bocal");
  });
});

describe("nutrition", () => {
  // the same text with every no-break space read as a space
  const plain = (s: string | null) => s?.replaceAll("\u00a0", " ") ?? null;
  const n = (missing: string[] = []) => ({ perPortion: { kcal: 539.6, proteinG: 27.5, carbsG: 61.2, fatG: 18.4, fibreG: 8.6, saltG: 1.24 }, missing });

  it("rounds kcal and grams to the unit and salt to one decimal, with a French comma", () => {
    expect(plain(nutritionLine(n()))).toBe("540 kcal · 28 g protéines · 61 g glucides · 18 g lipides · 9 g fibres · 1,2 g sel");
    expect(plain(nutritionLine({ perPortion: { kcal: 0.4, proteinG: 0, carbsG: 0.49, fatG: 0, fibreG: 0, saltG: 0.04 }, missing: [] }))).toBe(
      "0 kcal · 0 g protéines · 0 g glucides · 0 g lipides · 0 g fibres · 0,0 g sel",
    );
    // a figure never wraps away from its unit and nutrient; the line breaks only between them
    expect(nutritionLine(n())).toContain("28\u00a0g\u00a0protéines · 61\u00a0g\u00a0glucides");
    expect(nutritionLine(n())).not.toMatch(/\d (g|kcal)|g (protéines|glucides|lipides|fibres|sel)/);
  });

  it("says which ingredients were not counted", () => {
    expect(plain(nutritionLine(n(["riz complet", "crème fraîche"])))).toBe(
      "540 kcal · 28 g protéines · 61 g glucides · 18 g lipides · 9 g fibres · 1,2 g sel · partiel : sans riz complet, crème fraîche",
    );
  });

  // a snapshot stored or served by the previous build has no `nutrition` on its pool meals
  it("writes « Par portion » under a meal with values, and nothing under one without or from an older snapshot", () => {
    expect(plain(mealNutritionMeta({ nutrition: n() }))).toBe("Par portion : 540 kcal · 28 g protéines · 61 g glucides · 18 g lipides · 9 g fibres · 1,2 g sel");
    expect(mealNutritionMeta({ nutrition: null })).toBeNull();
    expect(mealNutritionMeta({})).toBeNull();
  });
});
