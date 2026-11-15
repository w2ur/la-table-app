import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { makeAccessVerifier } from "./auth";

const TEAM = "test.cloudflareaccess.com";
const AUD = "test-aud";
let verify: ReturnType<typeof makeAccessVerifier>;
let sign: (claims: { aud?: string; iss?: string; exp?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  verify = makeAccessVerifier(() => jwks);
  sign = async ({ aud = AUD, iss = `https://${TEAM}`, exp = "1h" }) =>
    new SignJWT({ email: "william@example.test" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setAudience(aud).setIssuer(iss).setIssuedAt().setExpirationTime(exp).sign(privateKey);
});

const req = (token?: string) => new Request("https://table.test/api/state", token ? { headers: { "cf-access-jwt-assertion": token } } : {});
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

describe("Access verifier", () => {
  it("accepts a valid token", async () => {
    expect(await verify(req(await sign({})), env)).toBe(true);
  });
  it("rejects a missing token, a wrong audience, a wrong issuer and an expired token", async () => {
    expect(await verify(req(), env)).toBe(false);
    expect(await verify(req(await sign({ aud: "other" })), env)).toBe(false);
    expect(await verify(req(await sign({ iss: "https://evil.test" })), env)).toBe(false);
    expect(await verify(req(await sign({ exp: "-1m" })), env)).toBe(false);
  });
  it("rejects everything when the Access config is missing", async () => {
    expect(await verify(req(await sign({})), {})).toBe(false);
  });
  it("bypasses only when DEV_SKIP_ACCESS is exactly '1' and the request is to this machine", async () => {
    const local = (host: string) => new Request(`http://${host}/api/state`);
    for (const host of ["localhost", "localhost:8787", "127.0.0.1:8789", "[::1]:8787"]) {
      expect({ host, ok: await verify(local(host), { DEV_SKIP_ACCESS: "1" }) }).toEqual({ host, ok: true });
    }
    expect(await verify(local("localhost"), { ...env, DEV_SKIP_ACCESS: "true" })).toBe(false);
  });
  // Regression: dd0a9c8 — DEV_SKIP_ACCESS=1 left as a Worker secret or dashboard variable opened the deployed API to anyone past Access
  it("ignores DEV_SKIP_ACCESS on any other host, so a deployed Worker still requires the token", async () => {
    for (const url of ["https://la-table.w2ur.workers.dev/api/state", "http://la-table.w2ur.workers.dev/api/state", "https://0b7c3d4e-la-table.w2ur.workers.dev/api/state", "https://localhost.evil.test/api/state", "https://127.0.0.1.nip.io/api/state"]) {
      expect({ url, ok: await verify(new Request(url), { ...env, DEV_SKIP_ACCESS: "1" }) }).toEqual({ url, ok: false });
    }
    expect(await verify(new Request("https://la-table.w2ur.workers.dev/api/state", { headers: { "cf-access-jwt-assertion": await sign({}) } }), { ...env, DEV_SKIP_ACCESS: "1" })).toBe(true);
  });
});
