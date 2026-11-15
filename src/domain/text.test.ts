import { describe, expect, it } from "vitest";
import { formatDay, formatDayMonth, isWebUrl, normalizeName } from "./text";

describe("text", () => {
  it("normalises names for comparison", () => {
    expect(normalizeName("  Poireau ")).toBe("poireau");
    expect(normalizeName("Crème  fraîche")).toBe("crème fraîche");
    // Regression: review of product.upsert — « huile d’olive » from a phone became a second product beside « huile d'olive »
    expect(normalizeName("Huile d’olive")).toBe(normalizeName("huile d'olive"));
  });
  it("formats a day in French", () => {
    expect(formatDay("2026-10-15")).toBe("jeudi 15");
  });
  it("formats a day with its month in French", () => {
    expect(formatDayMonth("2026-10-15")).toBe("jeudi 15 octobre");
    expect(formatDayMonth("2026-10-12")).toBe("lundi 12 octobre");
    expect(formatDayMonth("2027-01-01")).toBe("vendredi 1 janvier");
  });
});

describe("isWebUrl", () => {
  // Regression: d6862d6 — any text was taken as an address and rendered as a link, a « javascript: » one included
  it("takes an http or https address only", () => {
    for (const ok of ["https://example.org/tarte", "http://autre.fr", "HTTPS://fr.wikipedia.org/wiki/Phở_(soupe)"]) expect(isWebUrl(ok), ok).toBe(true);
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<p>x</p>", "vbscript:x", "ftp://x.fr", "//x.fr", "tarte", "", null, 3]) {
      expect(isWebUrl(bad), String(bad)).toBe(false);
    }
  });
});
