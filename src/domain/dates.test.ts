import { describe, expect, it } from "vitest";
import { addDays, clampToNow, daysBetween, parisDate, parisMonth } from "./dates";

describe("Paris dates", () => {
  it("uses the Paris calendar day, not UTC", () => {
    expect(parisDate("2026-10-11T23:30:00Z")).toBe("2026-10-12");
    expect(parisDate("2026-10-11T21:30:00Z")).toBe("2026-10-11");
    expect(parisMonth("2026-09-30T22:30:00Z")).toBe(10);
  });
  // the checkout proposes this day as the receipt's, also between midnight and two in the morning
  it("gives the Paris day across midnight UTC and the year end", () => {
    expect(parisDate("2026-10-11T22:30:00.000Z")).toBe("2026-10-12");
    expect(parisDate("2026-10-12T21:59:59.000Z")).toBe("2026-10-12");
    expect(parisDate("2026-12-31T23:30:00.000Z")).toBe("2027-01-01");
  });
  it("adds days across month ends and counts days between dates", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(daysBetween("2026-10-12", "2026-10-15")).toBe(3);
    expect(daysBetween("2026-10-12", "2026-10-10")).toBe(-2);
  });
  it("clamps a future client time to the server time", () => {
    expect(clampToNow("2026-10-12T12:00:00Z", "2026-10-12T10:00:00Z")).toBe("2026-10-12T10:00:00Z");
    expect(clampToNow("2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z")).toBe("2026-10-12T09:00:00Z");
  });
});
