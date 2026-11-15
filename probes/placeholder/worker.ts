/**
 * The inert Worker deployed as `la-table` before Access protects it. It serves no page and no data: every
 * request it sees gets a 503 saying the app is not open, and tells the probe whether Access passed it a JWT and for which
 * audience (the AUD tag, not a secret: wrangler.jsonc carries it). It has the app's shape (static assets in front, the
 * Worker first on /api/*), so what Access hands it is what the app will get. The app replaces it only through
 * scripts/deploy-ci.ts, which first sees Access in front of the live address.
 */
export default {
  fetch(request: Request): Response {
    const token = request.headers.get("cf-access-jwt-assertion");
    return Response.json(
      { ok: false, placeholder: true, error: "La Table n'est pas encore ouverte", jwt: token !== null, aud: audience(token) },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  },
};

/** The `aud` claim of a JWT, read without verifying it (the probe compares it with wrangler.jsonc's ACCESS_AUD), or null. */
export function audience(token: string | null): string[] | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { aud?: unknown } | null;
    const aud = claims?.aud;
    if (typeof aud === "string") return [aud];
    return Array.isArray(aud) ? aud.filter((a): a is string => typeof a === "string") : null;
  } catch {
    return null;
  }
}
