const PARIS_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar day (YYYY-MM-DD) in Europe/Paris for an ISO timestamp. */
export function parisDate(iso: string): string {
  return PARIS_DAY.format(new Date(iso));
}

export function parisMonth(iso: string): number {
  return Number(parisDate(iso).slice(5, 7));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function clampToNow(at: string, now: string): string {
  return Date.parse(at) > Date.parse(now) ? now : at;
}
