import { describe, expect, it } from "vitest";
import { CliError, clientConfig, fetchState, onPlaceholder, postOp, tokenAddressRefusal, type FetchLike } from "./client";

const secrets = (map: Record<string, string>) => (s: string) => map[s] ?? null;
/** DEFAULT_URL once the deploy setup has written the account's subdomain in place of `replace-me`. */
const FILLED = "https://la-table.w2ur.workers.dev";
const PLACEHOLDER_URL = "https://la-table.replace-me.workers.dev";
const remote = () =>
  clientConfig({ local: false, env: {}, defaultUrl: FILLED, readSecret: secrets({ "la-table-access-client-id": "id.access", "la-table-access-client-secret": "s3cret" }) });
const answer = (body: unknown, init: ResponseInit = {}): FetchLike => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "application/json; charset=utf-8" },
  });
const SNAPSHOT = { menu: { pool: [{ id: 1 }] }, courses: { lines: [], estimateCents: 0, budgetCents: 3000 } };
const exitOf = async (p: Promise<unknown>) => p.then(() => 0, (e) => (e instanceof CliError ? e.exitCode : -1));

describe("clientConfig", () => {
  it("sends the service token headers to the remote host", () => {
    expect(remote()).toEqual({
      baseUrl: FILLED,
      headers: { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s3cret" },
    });
  });

  it("exits 2 naming the missing keychain entry, and never builds an unauthenticated config", () => {
    const maps: Record<string, string>[] = [{}, { "la-table-access-client-id": "id" }, { "la-table-access-client-id": "id", "la-table-access-client-secret": "" }];
    for (const map of maps) {
      let err: unknown;
      try { clientConfig({ local: false, env: {}, defaultUrl: FILLED, readSecret: secrets(map) }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).message).toMatch(/la-table-access-client-(id|secret)/);
    }
  });

  it("targets localhost without headers in --local, and honours the URL overrides", () => {
    expect(clientConfig({ local: true, env: {}, readSecret: () => null })).toEqual({ baseUrl: "http://localhost:8787", headers: {} });
    expect(clientConfig({ local: true, env: { LA_TABLE_LOCAL_URL: "http://127.0.0.1:9000" }, readSecret: () => null }).baseUrl).toBe("http://127.0.0.1:9000");
    const cfg = clientConfig({ local: false, env: { LA_TABLE_URL: "http://localhost:9000" }, readSecret: secrets({}) });
    expect(cfg.baseUrl).toBe("http://localhost:9000");
  });

  // Regression: 8325f7a — the CLI read the keychain and sent the service token to DEFAULT_URL while it still named the provisional replace-me subdomain, which any account can claim, or to any LA_TABLE_URL, http:// included
  it("exits 2 before reading the keychain when the token would go to the provisional subdomain or in cleartext off this machine", () => {
    const refused: { env: Record<string, string>; defaultUrl: string }[] = [
      { env: {}, defaultUrl: PLACEHOLDER_URL },
      ...[PLACEHOLDER_URL, "https://x.replace-me.workers.dev", "http://la-table.w2ur.workers.dev", "http://x.test", "http://localhost.evil.test:8787", "not an address"].map((url) => ({ env: { LA_TABLE_URL: url }, defaultUrl: FILLED })),
    ];
    for (const { env, defaultUrl } of refused) {
      const read: string[] = [];
      let err: unknown;
      try { clientConfig({ local: false, env, defaultUrl, readSecret: (s) => { read.push(s); return "x"; } }); } catch (e) { err = e; }
      expect({ env, defaultUrl, exit: (err as CliError | undefined)?.exitCode, read }).toEqual({ env, defaultUrl, exit: 2, read: [] });
    }
    expect((() => { try { clientConfig({ local: false, env: {}, defaultUrl: PLACEHOLDER_URL, readSecret: () => "x" }); } catch (e) { return (e as Error).message; } })()).toContain("provisoire");
    // the control: DEFAULT_URL itself still gets the token
    expect(clientConfig({ local: false, env: { LA_TABLE_URL: FILLED }, defaultUrl: FILLED, readSecret: () => "x" }).headers["CF-Access-Client-Id"]).toBe("x");
  });

  // Regression: 2527b42 — an LA_TABLE_URL=http://localhost:8787 left in the shell sent the non-expiring service token to whatever listens on that port (wrangler dev's default, shared by every Worker project)
  it("sends no token and reads no keychain entry to a loopback address", () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1:9000", "http://[::1]:8787"]) {
      const read: string[] = [];
      const cfg = clientConfig({ local: false, env: { LA_TABLE_URL: url }, defaultUrl: FILLED, readSecret: (s) => { read.push(s); return "x"; } });
      expect({ url, cfg, read }).toEqual({ url, cfg: { baseUrl: url, headers: {} }, read: [] });
    }
  });

  // Regression: 4e8df93 — a trailing dot (and a :443) on the provisional hostname passed the string comparison, so the token went to a subdomain anyone can claim
  it("refuses the provisional subdomain spelled with a root dot or the default port", () => {
    for (const url of ["https://la-table.replace-me.workers.dev.", "https://la-table.replace-me.workers.dev.:443", "https://la-table.replace-me.workers.dev:443", "https://replace-me.workers.dev."]) {
      expect({ url, onPlaceholder: onPlaceholder(url), refusal: tokenAddressRefusal(url) !== null }).toEqual({ url, onPlaceholder: true, refusal: true });
      expect(() => clientConfig({ local: false, env: { LA_TABLE_URL: url }, defaultUrl: FILLED, readSecret: () => "x" })).toThrow(CliError);
    }
    expect(onPlaceholder("https://la-table.w2ur.workers.dev.")).toBe(false);
  });

  // Regression: e379192 — any https:// LA_TABLE_URL got the service token, another account's la-table.<x>.workers.dev left in the shell included; the probes took DEFAULT_URL only
  it("exits 2 before reading the keychain when LA_TABLE_URL is another https address than DEFAULT_URL", () => {
    for (const url of ["https://x.test", "https://la-table.other.workers.dev", `${FILLED}/`, `${FILLED}/app`, "https://evil.test@la-table.w2ur.workers.dev"]) {
      const read: string[] = [];
      let err: unknown;
      try { clientConfig({ local: false, env: { LA_TABLE_URL: url }, defaultUrl: FILLED, readSecret: (s) => { read.push(s); return "x"; } }); } catch (e) { err = e; }
      expect({ url, exit: (err as CliError | undefined)?.exitCode, read }).toEqual({ url, exit: 2, read: [] });
      expect((err as CliError).message).toContain(FILLED);
    }
    expect(clientConfig({ local: false, env: { LA_TABLE_URL: FILLED }, defaultUrl: FILLED, readSecret: () => "x" }).baseUrl).toBe(FILLED);
  });
});

describe("clientConfig, the token from the environment", () => {
  const KEYCHAIN = { "la-table-access-client-id": "kc-id", "la-table-access-client-secret": "kc-s" };
  const CLI_ENV = { LA_TABLE_CLI_ACCESS_CLIENT_ID: "env-id", LA_TABLE_CLI_ACCESS_CLIENT_SECRET: "env-s" };
  const BUILD_ENV = { LA_TABLE_ACCESS_CLIENT_ID: "build-id", LA_TABLE_ACCESS_CLIENT_SECRET: "build-s" };
  const headers = (id: string, s: string) => ({ "CF-Access-Client-Id": id, "CF-Access-Client-Secret": s });
  const spy = (env: Record<string, string>, read: string[]) => new Proxy(env, { get: (t, k) => { read.push(String(k)); return t[k as string]; } });
  const cfg = (platform: string, env: Record<string, string>, keychain: Record<string, string>, read: string[] = []) =>
    clientConfig({ local: false, env, defaultUrl: FILLED, fallback: { platform, env }, readSecret: (s) => { read.push(s); return keychain[s] ?? null; } });
  const failure = (f: () => unknown): CliError => { try { f(); } catch (e) { return e as CliError; } throw new Error("did not throw"); };

  it("takes the pair from the environment when the keychain holds neither entry", () => {
    expect(cfg("darwin", CLI_ENV, {}).headers).toEqual(headers("env-id", "env-s"));
  });

  it("takes the keychain alone as before", () => {
    expect(cfg("darwin", {}, KEYCHAIN).headers).toEqual(headers("kc-id", "kc-s"));
  });

  it("lets the keychain win on darwin when both hold a token", () => {
    expect(cfg("darwin", CLI_ENV, KEYCHAIN).headers).toEqual(headers("kc-id", "kc-s"));
  });

  it("takes the environment on any other platform, and never opens the keychain there", () => {
    for (const platform of ["linux", "win32"]) {
      const read: string[] = [];
      expect({ platform, headers: cfg(platform, CLI_ENV, KEYCHAIN, read).headers, read }).toEqual({ platform, headers: headers("env-id", "env-s"), read: [] });
    }
  });

  it("exits 2 naming the variables outside darwin without them", () => {
    const err = failure(() => cfg("linux", {}, KEYCHAIN));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("LA_TABLE_CLI_ACCESS_CLIENT_ID");
    expect(err.message).toContain("LA_TABLE_CLI_ACCESS_CLIENT_SECRET");
  });

  it("exits 2 on darwin naming both sources when neither holds a token", () => {
    const err = failure(() => cfg("darwin", {}, {}));
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/la-table-access-client-id/);
    expect(err.message).toContain("LA_TABLE_CLI_ACCESS_CLIENT_ID");
  });

  it("exits 2 when only one of the pair is set, whatever the platform, empty counting as unset", () => {
    for (const platform of ["darwin", "linux"]) {
      for (const env of [{ LA_TABLE_CLI_ACCESS_CLIENT_ID: "env-id" }, { LA_TABLE_CLI_ACCESS_CLIENT_SECRET: "env-s" }, { ...CLI_ENV, LA_TABLE_CLI_ACCESS_CLIENT_SECRET: "" }] as Record<string, string>[]) {
        const err = failure(() => cfg(platform, env, {}));
        expect({ platform, exit: err.exitCode, names: /incomplet/.test(err.message) }).toEqual({ platform, exit: 2, names: true });
      }
    }
  });

  it("exits 2 naming the CLI variables when only the build's names are set, and never uses them as the token", () => {
    for (const platform of ["darwin", "linux"]) {
      for (const env of [BUILD_ENV, { LA_TABLE_ACCESS_CLIENT_ID: "build-id" }]) {
        const err = failure(() => cfg(platform, env, {}));
        expect(err.exitCode).toBe(2);
        expect(err.message).toContain("LA_TABLE_CLI_ACCESS_CLIENT_ID");
        expect(err.message).toContain("LA_TABLE_CLI_ACCESS_CLIENT_SECRET");
        expect(err.message).toContain("jeton de build");
      }
    }
  });

  it("prefers the CLI pair when the build's names are set beside it", () => {
    expect(cfg("linux", { ...BUILD_ENV, ...CLI_ENV }, {}).headers).toEqual(headers("env-id", "env-s"));
  });

  it("keeps the keychain's missing-entry error when it holds only one entry, the environment unused", () => {
    const err = failure(() => cfg("darwin", CLI_ENV, { "la-table-access-client-id": "kc-id" }));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("la-table-access-client-secret");
  });

  it("reads neither source for a refused address, and sends no token to loopback", () => {
    for (const url of ["https://x.test", PLACEHOLDER_URL, "http://x.test"]) {
      const read: string[] = [];
      const env = { ...CLI_ENV, LA_TABLE_URL: url };
      const err = failure(() => clientConfig({ local: false, env: spy(env, read), defaultUrl: FILLED, fallback: { platform: "linux", env: spy(env, read) }, readSecret: (s) => { read.push(s); return "x"; } }));
      expect({ url, exit: err.exitCode, read: read.filter((k) => k !== "LA_TABLE_URL") }).toEqual({ url, exit: 2, read: [] });
    }
    expect(cfg("linux", { ...CLI_ENV, LA_TABLE_URL: "http://localhost:8787" }, {}).headers).toEqual({});
  });

  it("never reads the environment's token for a call that passes no fallback (the probes)", () => {
    const read: string[] = [];
    const err = failure(() => clientConfig({ local: false, env: spy({ ...CLI_ENV, ...BUILD_ENV }, read), defaultUrl: FILLED, readSecret: () => null }));
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/trousseau/);
    expect(read.filter((k) => /ACCESS_CLIENT/.test(k))).toEqual([]);
    // the control: the same environment, handed over as a fallback, is read
    const withFallback: string[] = [];
    clientConfig({ local: false, env: {}, defaultUrl: FILLED, fallback: { platform: "linux", env: spy(CLI_ENV, withFallback) }, readSecret: () => null });
    expect(withFallback.some((k) => /ACCESS_CLIENT/.test(k))).toBe(true);
  });
});

describe("fetchState", () => {
  const body = { version: 4, products: [], recipes: [], recipeIngredients: [], plannings: [], meals: [], shoppingItems: [], trips: [], stockItems: [], reservations: [], envies: [] };

  it("reads /api/history with the headers and adds empty op records", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const state = await fetchState(remote(), async (url, init) => { seen = { url, init }; return answer(body)(url); });
    expect(seen!.url).toBe(`${FILLED}/api/history`);
    expect(seen!.init?.redirect).toBe("manual");
    expect((seen!.init?.headers as Record<string, string>)["CF-Access-Client-Id"]).toBe("id.access");
    expect(state).toEqual({ ...body, lastIds: {}, appliedOps: {} }); // a server older than meta.last_ids sends none
    const withIds = { ...body, lastIds: { trips: 3 } };
    expect(await fetchState(remote(), async (url) => answer(withIds)(url))).toEqual({ ...withIds, appliedOps: {} });
  });

  it("exits 2 with the diagnosis on an Access redirect, a refusal or an HTML login page", async () => {
    const cases: [Promise<unknown>, RegExp][] = [
      [fetchState(remote(), answer("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } })), /jeton refusé ou expiré/],
      [fetchState(remote(), answer({ ok: false }, { status: 401 })), /vérifiez le jeton Access/],
      [fetchState(remote(), answer({ ok: false }, { status: 403 })), /vérifiez le jeton Access/],
      [fetchState(remote(), answer("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } })), /reconnexion/],
    ];
    for (const [p, message] of cases) {
      await expect(p).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(message) });
    }
  });

  // Regression: e390bb9 — a non-JSON 5xx (a Cloudflare error page) was diagnosed as an Access login to redo
  it("names a server error, not a login, when a 5xx comes back as HTML", async () => {
    for (const status of [500, 502, 503]) {
      const p = fetchState(remote(), answer("<html>Bad gateway</html>", { status, headers: { "content-type": "text/html" } }));
      await expect(p, String(status)).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(new RegExp(`erreur serveur ${status}`)) });
    }
  });

  it("exits 2 on an HTML body, a server error, a malformed body or a network failure", async () => {
    expect(await exitOf(fetchState(remote(), answer(body, { status: 200, headers: { "content-type": "text/html" } })))).toBe(2);
    expect(await exitOf(fetchState(remote(), answer({ ok: false }, { status: 500 })))).toBe(2);
    expect(await exitOf(fetchState(remote(), answer({ version: 1 })))).toBe(2);
    expect(await exitOf(fetchState(remote(), answer("{ not json")))).toBe(2);
    expect(await exitOf(fetchState(remote(), async () => { throw new TypeError("fetch failed"); }))).toBe(2);
  });
});

describe("postOp", () => {
  const op = { opId: "o1", type: "shopping.set_price", at: "2026-10-12T10:00:00.000Z", payload: { itemId: 3, estPriceCents: 250 } };

  it("posts JSON with the headers and returns the op's result", async () => {
    let init: RequestInit | undefined;
    const r = await postOp(remote(), async (_url, i) => { init = i; return answer({ results: [{ opId: "o1", status: "refused", reason: "article retiré" }], unrecorded: [], snapshot: SNAPSHOT })(""); }, op);
    expect(r).toEqual({ result: { opId: "o1", status: "refused", reason: "article retiré" }, snapshot: SNAPSHOT });
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ ops: [op] });
  });

  it("exits 2 when the response carries no result for the op", async () => {
    expect(await exitOf(postOp(remote(), answer({ results: [] }), op))).toBe(2);
  });

  it("exits 2 when the server did not record the op, or does not say which ops it recorded", async () => {
    const refused = { opId: "o1", status: "refused", reason: "erreur interne : D1 injoignable" };
    await expect(postOp(remote(), answer({ results: [refused], unrecorded: ["o1"], snapshot: null }), op)).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/non définitive/) });
    expect(await exitOf(postOp(remote(), answer({ results: [refused], snapshot: {} }), op))).toBe(2);
    expect(await exitOf(postOp(remote(), answer({ results: [refused], unrecorded: [1], snapshot: {} }), op))).toBe(2);
    expect(await exitOf(postOp(remote(), answer({ results: [refused], unrecorded: ["other"], snapshot: SNAPSHOT }), op))).toBe(0);
  });

  it("exits 2 when a final answer comes without a usable snapshot", async () => {
    const applied = { opId: "o1", status: "applied", reason: null };
    for (const snapshot of [undefined, null, {}, { ...SNAPSHOT, courses: { lines: [] } }, { ...SNAPSHOT, menu: { pool: [{}] } }]) {
      expect(await exitOf(postOp(remote(), answer({ results: [applied], unrecorded: [], snapshot }), op)), JSON.stringify(snapshot)).toBe(2);
    }
  });

  it("exits 2 when the result status is outside applied/noop/refused", async () => {
    expect(await exitOf(postOp(remote(), answer({ results: [{ opId: "o1", status: "weird" }], unrecorded: [] }), op))).toBe(2);
  });
});
