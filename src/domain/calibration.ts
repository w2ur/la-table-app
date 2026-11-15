import { RULES } from "./rules.config";
import type { State, Trip } from "./types";

/** Whether a trip was recorded with its receipt: every trip but one `trip.record` sent `noReceipt: true` (null, a trip written before migration 0009, has one). */
export const hasReceipt = (trip: Pick<Trip, "noReceipt">): boolean => trip.noReceipt !== true;

export interface Calibration {
  /** median of actual ÷ estimated, ×1000; null below the minimum trip count */
  factorPermille: number | null;
  tripCount: number;
}

export function calibration(state: State): Calibration {
  const ratios: number[] = [];
  const trips = state.trips
    // recordTrip and setTripTotal already refuse a total on a no-receipt trip: this is a guard, not a reachable case
    .filter((t) => t.totalCents !== null && hasReceipt(t))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  for (const trip of trips) {
    if (ratios.length === RULES.calibrationTrips) break;
    const bought = state.shoppingItems.filter((l) => l.tripId === trip.id);
    // §5.5: an unpriced line (an ajout, a rebuy with no known price) would read as overspend; the trip waits for shopping.set_price.
    if (bought.some((l) => l.estPriceCents === null)) continue;
    const estimate = bought.reduce((sum, l) => sum + (l.estPriceCents ?? 0), 0);
    if (estimate === 0) continue;
    ratios.push(Math.round(((trip.totalCents ?? 0) * 1000) / estimate));
  }
  if (ratios.length < RULES.calibrationMinTrips) return { factorPermille: null, tripCount: ratios.length };
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 1 ? ratios[mid]! : Math.floor((ratios[mid - 1]! + ratios[mid]!) / 2);
  return { factorPermille: median, tripCount: ratios.length };
}

export function applyCalibration(cents: number, cal: Calibration): number | null {
  return cal.factorPermille === null ? null : Math.round((cents * cal.factorPermille) / 1000);
}
