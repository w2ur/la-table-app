export function normalizeName(name: string): string {
  // a phone types ’ where a laptop types ': the same name either way
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR").replaceAll("\u2019", "'");
}

const DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", timeZone: "UTC" });

/** "2026-10-15" → "jeudi 15" */
export function formatDay(date: string): string {
  return DAY.format(new Date(`${date}T12:00:00Z`));
}

const DAY_MONTH = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** "2026-10-15" → "jeudi 15 octobre" */
export function formatDayMonth(date: string): string {
  return DAY_MONTH.format(new Date(`${date}T12:00:00Z`));
}

/** A web address a page may link to: http or https only, so a « javascript: » or « data: » text never becomes a link. */
export function isWebUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const { protocol } = new URL(v);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
