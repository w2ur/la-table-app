import { devices } from "@playwright/test";

export const BASE_URL = `http://localhost:${process.env.E2E_PORT ?? "8789"}`;

/** A phone in Paris, in French: the app's only audience (spec §1, §10). */
export const PHONE = { ...devices["Pixel 7"], baseURL: BASE_URL, locale: "fr-FR", timezoneId: "Europe/Paris" };
