import { describe, expect, it } from "vitest";
import placeholder, { audience } from "./worker";

const jwt = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("the placeholder Worker", () => {
  it("answers 503 to everything, naming no data, and says whether Access passed a JWT for which audience", async () => {
    const bare = placeholder.fetch(new Request("https://la-table.w2ur.workers.dev/"));
    expect(bare.status).toBe(503);
    expect(await bare.json()).toEqual({ ok: false, placeholder: true, error: "La Table n'est pas encore ouverte", jwt: false, aud: null });
    const behind = placeholder.fetch(new Request("https://la-table.w2ur.workers.dev/api/health", { headers: { "cf-access-jwt-assertion": jwt({ aud: ["a".repeat(64)], email: "x@example.test" }) } }));
    expect(await behind.json()).toMatchObject({ jwt: true, aud: ["a".repeat(64)] });
  });

  it("reads the audience of a string or list claim, and nothing from garbage", () => {
    expect(audience(jwt({ aud: "b".repeat(64) }))).toEqual(["b".repeat(64)]);
    expect(audience(jwt({ aud: ["x", 1, "y"] }))).toEqual(["x", "y"]);
    for (const bad of [null, "", "nodots", "h.%%%.s", jwt({ sub: "no aud" }), jwt(null)]) expect(audience(bad)).toBeNull();
  });
});
