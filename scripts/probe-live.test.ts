import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDeployConfig } from "./deploy-config";
import { accessConfig, baseRefusal, ICON_PATHS, liveArgs, liveChecks, liveReport, placeholderChecks, PROBE_CONFIG_PATH, versionUrl, waitForTag, type IconMode } from "./probe-live";

const BASE = "https://la-table.w2ur.workers.dev";
const HOST = "la-table.w2ur.workers.dev";
const TEAM = "revah.cloudflareaccess.com";
const AUD = "a".repeat(64);
const TOKEN = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };
const VERSION_URL = "https://0b7c3d4e-la-table.w2ur.workers.dev";
const PLACEHOLDER_URL = "https://la-table.replace-me.workers.dev";
const isIcon = (path: string) => (ICON_PATHS as readonly string[]).includes(path);

type Route = (path: string, authed: boolean | "wrong") => Response;
const login = () => new Response(null, { status: 302, headers: { location: `https://${TEAM}/cdn-cgi/access/login/${HOST}?kid=k` } });
/** Cloudflare as deployed: Access in front of everything (the icons too, or not, per the owner's choice), then the Worker and its assets. */
const healthy = (icons: IconMode): Route => (path, authed) => {
  if (!(icons === "public" && isIcon(path)) && authed !== true) return authed === "wrong" ? new Response("Forbidden", { status: 403 }) : login();
  if (isIcon(path)) return path.endsWith(".png") ? new Response("png", { headers: { "content-type": "image/png" } }) : Response.json({ name: "La Table" });
  if (path === "/api/health") return Response.json({ ok: true, version: "0b7c3d4e-aaaa-bbbb-cccc-123456789abc", tag: "86225a9f00aa" });
  if (path === "/api/state") return Response.json({ menu: { pool: [] } });
  if (path.startsWith("/api/")) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  if (path === "/") return new Response('<link rel="apple-touch-icon" href="/apple-touch-icon.png" /><link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />', { headers: { "content-type": "text/html" } });
  if (path === "/sw.js") return new Response("self.addEventListener", { headers: { "content-type": "application/javascript" } });
  return new Response("not found", { status: 404 });
};

const authOf = (init?: RequestInit) => {
  const h = new Headers(init?.headers);
  return h.get("CF-Access-Client-Id") === null ? false : h.get("CF-Access-Client-Secret") === "secret" ? true : "wrong";
};
/** `versionServes`: the version URL answers the app without Access (preview_urls left on, Access only on the main host). */
const fetcher = (route: Route, versionServes = false) => async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  if (url.hostname === new URL(VERSION_URL).hostname) return versionServes ? Response.json({ ok: true, version: "v" }) : login();
  if (url.hostname !== HOST) return new Response("nothing here", { status: 404 });
  return route(url.pathname, authOf(init));
};

const run = (route: Route, o: { icons?: IconMode; versionServes?: boolean } = {}) =>
  liveChecks(fetcher(route, o.versionServes), { base: BASE, team: TEAM, headers: TOKEN, icons: o.icons ?? "access", others: [VERSION_URL] });
const failed = async (route: Route, o: { icons?: IconMode; versionServes?: boolean } = {}) => (await run(route, o)).filter((c) => !c.ok).map((c) => c.name);

describe("versionUrl", () => {
  it("is the version's own workers.dev address, from the first 8 characters of its id", () => {
    expect(versionUrl(BASE, "0b7c3d4e-aaaa-bbbb-cccc-123456789abc")).toBe(VERSION_URL);
    expect(versionUrl(BASE, null)).toBeNull();
    expect(versionUrl("https://x.test", "0b7c3d4e-aaaa")).toBeNull();
  });
});

describe("liveChecks", () => {
  it("passes every check against the deployed shape, icons behind Access or public", async () => {
    for (const icons of ["access", "public"] as const) {
      const checks = await run(healthy(icons), { icons });
      expect({ icons, failed: checks.filter((c) => !c.ok) }).toEqual({ icons, failed: [] });
      expect(checks).toHaveLength(17);
    }
  });

  it("fails when Access is not in front: the page served, or the API answered by the Worker's own 401", async () => {
    const open: Route = (path, authed) => (path === "/" && !authed ? new Response("<html>") : healthy("access")(path, authed));
    expect(await failed(open)).toEqual(["sans jeton, / → connexion Access"]);
    const workerOnly: Route = (path, authed) => (path === "/api/state" && !authed ? new Response('{"ok":false,"error":"unauthorized"}', { status: 401 }) : healthy("access")(path, authed));
    expect(await failed(workerOnly)).toEqual(["sans jeton, /api/state → arrêté par Access, pas par le Worker"]);
  });

  // Regression: 47e8c2c — without a token, /api/state failed only on a 200 or the Worker's exact 401 body: a 500, a 404, or the Worker's 401 with one more field passed as Access
  it("without a token, takes only Access's answer on /api/state: its login, or a 401/403 that is not the Worker's", async () => {
    const answering = (res: () => Response): Route => (path, authed) => (path === "/api/state" && !authed ? res() : healthy("access")(path, authed));
    for (const res of [
      () => new Response("Internal Server Error", { status: 500 }),
      () => Response.json({ ok: false, error: "not_found" }, { status: 404 }),
      () => Response.json({ ok: false, error: "unauthorized", hint: "x" }, { status: 401 }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
    ]) {
      expect(await failed(answering(res))).toEqual(["sans jeton, /api/state → arrêté par Access, pas par le Worker"]);
    }
    for (const res of [() => new Response("Forbidden", { status: 403 }), () => new Response("<html>Unauthorized</html>", { status: 401 })]) {
      expect(await failed(answering(res))).toEqual([]);
    }
  });

  it("fails when a redirect goes anywhere but the team's login", async () => {
    const elsewhere: Route = (path, authed) => (path === "/" && !authed ? new Response(null, { status: 302, headers: { location: "https://evil.test/" } }) : healthy("access")(path, authed));
    expect(await failed(elsewhere)).toEqual(["sans jeton, / → connexion Access"]);
  });

  it("fails when the icons are not as the owner set them, or missing behind Access", async () => {
    expect(await failed(healthy("access"), { icons: "public" })).toEqual(ICON_PATHS.map((p) => `sans jeton, ${p} → public`));
    expect(await failed(healthy("public"), { icons: "access" })).toEqual(ICON_PATHS.map((p) => `sans jeton, ${p} → connexion Access`));
    const missing: Route = (path, authed) => (path === "/icon-512.png" && authed === true ? new Response("not found", { status: 404 }) : healthy("access")(path, authed));
    expect(await failed(missing)).toEqual(["jeton, /icon-512.png → servi"]);
  });

  it("fails when the Worker refuses the Access JWT (wrong AUD or team domain)", async () => {
    const wrongAud: Route = (path, authed) => (authed === true && path === "/api/state" ? new Response('{"ok":false,"error":"unauthorized"}', { status: 401 }) : healthy("access")(path, authed));
    expect(await failed(wrongAud)).toEqual(["jeton, /api/state → le Worker accepte le JWT d'Access"]);
  });

  it("fails the 404 control when every path answers 200, and the token control when a wrong secret passes", async () => {
    const catchAll: Route = (path, authed) => (path === "/api/inexistant" ? Response.json({ ok: true }) : healthy("access")(path, authed));
    expect(await failed(catchAll)).toEqual(["jeton, /api/inexistant → 404 du Worker (témoin)"]);
    const anyToken: Route = (path, authed) => healthy("access")(path, authed === "wrong" ? true : authed);
    expect(await failed(anyToken)).toEqual(["jeton faux, /api/state → refusé par Access (témoin)"]);
  });

  // Regression: 4d4fe3f — the wrong-token control passed on any answer but a 200, the Worker's own 401 included: Access letting a wrong token through to the Worker went unseen
  it("takes only Access's refusal of a wrong token: the Worker's own 401, a 500 or a 404 fail the control", async () => {
    const wrongAnswered = (res: () => Response): Route => (path, authed) => (authed === "wrong" ? res() : healthy("access")(path, authed));
    for (const res of [
      () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 }),
      () => new Response("Internal Server Error", { status: 500 }),
      () => Response.json({ ok: false, error: "not_found" }, { status: 404 }),
    ]) {
      expect(await failed(wrongAnswered(res))).toEqual(["jeton faux, /api/state → refusé par Access (témoin)"]);
    }
    // the control: Access's own 401/403 (strict service token authentication), or its login, pass
    for (const res of [() => new Response("Forbidden", { status: 403 }), () => new Response("<html>Unauthorized</html>", { status: 401 }), login]) {
      expect(await failed(wrongAnswered(res))).toEqual([]);
    }
  });

  it("fails when the version's own URL serves the app without Access", async () => {
    expect(await failed(healthy("access"), { versionServes: true })).toEqual([`${VERSION_URL} ne sert pas l'app sans Access`]);
  });

  // Regression: c207b3a — an address that never answered (DNS, TLS, network down) failed every check: exit 1 (a finding) where nothing could be checked (2)
  it("reports an unreachable host as checks it could not make, not a crash and not a finding", async () => {
    const checks = await liveChecks(async () => { throw new Error("ENOTFOUND"); }, { base: BASE, team: TEAM, headers: TOKEN, icons: "access", others: [] });
    expect(checks.every((c) => !c.ok && c.unreached === true && c.detail.startsWith("injoignable"))).toBe(true);
    const r = liveReport(checks);
    expect(r.exit).toBe(2);
    expect(r.lines.every((l) => l.startsWith("NON VÉRIFIÉ"))).toBe(true);
  });

  // Regression: c207b3a — one check unreached must not hide a wrong answer elsewhere: a finding outranks an unknown
  it("still fails (1) when one address never answered and another check got a wrong answer", async () => {
    const flaky = fetcher(healthy("access"));
    const checks = await liveChecks(async (input, init) => {
      if (input.endsWith("/sw.js")) throw new Error("ECONNRESET");
      if (input === `${BASE}/` && new Headers(init?.headers).get("CF-Access-Client-Id") === null) return new Response("<html>");
      return flaky(input, init);
    }, { base: BASE, team: TEAM, headers: TOKEN, icons: "access", others: [] });
    expect(liveReport(checks).exit).toBe(1);
    expect(liveReport(checks.filter((c) => c.name !== "sans jeton, / → connexion Access")).exit).toBe(2);
  });
});

describe("placeholderChecks", () => {
  const jwt = (aud: string) => `h.${Buffer.from(JSON.stringify({ aud: [aud] })).toString("base64url")}.s`;
  /** probes/placeholder behind Access (or not yet): Access passes the token with a JWT for `aud`, the Worker answers 503. */
  const site = (o: { front: boolean; icons: IconMode; aud?: string | null }) => async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const authed = authOf(init);
    const passes = !o.front || authed === true || (o.icons === "public" && isIcon(path));
    if (!passes) return authed === "wrong" ? new Response("Forbidden", { status: 403 }) : login();
    const token = o.front && authed === true && o.aud !== null ? jwt(o.aud ?? AUD) : null;
    return Response.json({ ok: false, placeholder: true, jwt: token !== null, aud: token ? [o.aud ?? AUD] : null }, { status: 503 });
  };
  const check = (o: { front: boolean; icons: IconMode; aud?: string | null }, icons: IconMode = o.icons) =>
    placeholderChecks(site(o), { base: BASE, team: TEAM, aud: AUD, headers: TOKEN, icons });
  const failedOf = async (p: ReturnType<typeof check>) => (await p).filter((c) => !c.ok).map((c) => c.name);

  it("passes once Access is in front and hands the Worker a JWT for the configured AUD, icons either way", async () => {
    for (const icons of ["access", "public"] as const) expect(await failedOf(check({ front: true, icons }))).toEqual([]);
  });

  it("fails before Access is turned on: the placeholder answers by itself, with no JWT (the control)", async () => {
    expect(await failedOf(check({ front: false, icons: "access" }))).toEqual([
      "sans jeton, / → connexion Access",
      "sans jeton, /api/health → connexion Access",
      ...ICON_PATHS.map((p) => `sans jeton, ${p} → connexion Access`),
      "jeton, /api/health → Access passe au Worker un JWT pour l'AUD de wrangler.jsonc",
      "jeton faux, /api/health → refusé par Access avant le Worker (témoin)",
    ]);
  });

  it("fails when Access hands the Worker no JWT, or one for another application", async () => {
    expect(await failedOf(check({ front: true, icons: "access", aud: null }))).toEqual(["jeton, /api/health → Access passe au Worker un JWT pour l'AUD de wrangler.jsonc"]);
    expect(await failedOf(check({ front: true, icons: "access", aud: "b".repeat(64) }))).toEqual(["jeton, /api/health → Access passe au Worker un JWT pour l'AUD de wrangler.jsonc"]);
  });

  // Regression: 4d4fe3f — the placeholder's wrong-token control passed on anything but the placeholder's own answer, a 500 or a 404 from elsewhere included
  it("takes only Access's refusal of a wrong token on the placeholder: a 500 or a 404 fail the control", async () => {
    for (const res of [() => new Response("Internal Server Error", { status: 500 }), () => new Response("not found", { status: 404 })]) {
      const f = async (input: string, init?: RequestInit) => (authOf(init) === "wrong" ? res() : site({ front: true, icons: "access" })(input, init));
      expect(await failedOf(placeholderChecks(f, { base: BASE, team: TEAM, aud: AUD, headers: TOKEN, icons: "access" }))).toEqual(["jeton faux, /api/health → refusé par Access avant le Worker (témoin)"]);
    }
  });

  it("fails when the icon bypass is expected and absent, or present and not expected", async () => {
    expect(await failedOf(check({ front: true, icons: "access" }, "public"))).toEqual(ICON_PATHS.map((p) => `sans jeton, ${p} → laissé passer par Access`));
    expect(await failedOf(check({ front: true, icons: "public" }, "access"))).toEqual(ICON_PATHS.map((p) => `sans jeton, ${p} → connexion Access`));
  });
});

describe("waitForTag", () => {
  const opts = (log: string[], sleeps: number[]) => ({ rounds: 4, intervalMs: 10_000, sleep: async (ms: number) => { sleeps.push(ms); }, log: (s: string) => log.push(s) });

  it("asks again while the edge answers the old version, and stops at the expected one", async () => {
    const answers = ["5ff7756aaaaa", null, "5ff7756aaaaa", "86225a9f00aa"];
    const log: string[] = [];
    const sleeps: number[] = [];
    expect(await waitForTag(async () => answers.shift() ?? null, "86225a9f00aa", opts(log, sleeps))).toBe(true);
    expect(log).toEqual(["tour 1 : version 5ff7756aaaaa", "tour 2 : version illisible", "tour 3 : version 5ff7756aaaaa", "tour 4 : version 86225a9f00aa (attendue)"]);
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
  });

  it("gives up after the last round, and survives a read that throws", async () => {
    const log: string[] = [];
    expect(await waitForTag(async () => { throw new Error("reset"); }, "86225a9f00aa", opts(log, []))).toBe(false);
    expect(log).toHaveLength(4);
  });
});

describe("liveArgs", () => {
  it("reads the flags, with the defaults the docs give", () => {
    expect(liveArgs([])).toEqual({ placeholder: false, icons: "access", expect: undefined, rounds: 30, anyBase: false });
    expect(liveArgs(["--placeholder", "--icons", "public"])).toEqual({ placeholder: true, icons: "public", expect: undefined, rounds: 30, anyBase: false });
    expect(liveArgs(["--expect", "86225a9f00aa", "--rounds", "90"])).toEqual({ placeholder: false, icons: "access", expect: "86225a9f00aa", rounds: 90, anyBase: false });
  });

  // Regression: 4541622 — a trailing `--expect` (an unquoted empty substitution) was read as absent: no version rounds, exit 0 against any version
  it("refuses a flag that takes a value and has none, last or followed by another flag", () => {
    for (const argv of [["--expect"], ["--icons", "public", "--expect"], ["--expect", "--icons", "public"], ["--rounds"], ["--icons", "--placeholder"], ["--expect", "--placeholder"], ["--expect", "--any-base"]]) {
      expect(liveArgs(argv)).toHaveProperty("error");
    }
  });

  // Regression: edeb05d — `--placeholder --expect <commit>` was accepted and the version rounds silently skipped
  it("refuses --expect or --rounds with --placeholder, which waits for no version", () => {
    for (const argv of [["--placeholder", "--expect", "86225a9f00aa"], ["--rounds", "90", "--placeholder"], ["--placeholder", "--icons", "public", "--expect", "86225a9f00aa", "--rounds", "5"]]) {
      expect(liveArgs(argv)).toHaveProperty("error");
    }
  });

  it("refuses an unknown argument, a repeated flag, a bad icon mode or round count", () => {
    for (const argv of [["--expected", "abc"], ["--expect", "a", "--expect", "b"], ["--icons", "both"], ["--rounds", "0"], ["--rounds", "361"], ["--rounds", "2.5"]]) {
      expect(liveArgs(argv)).toHaveProperty("error");
    }
  });
});

describe("accessConfig", () => {
  it("gives the team domain and AUD tag of the configuration", () => {
    expect(accessConfig(() => ({ vars: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } }))).toEqual({ team: TEAM, aud: AUD });
    expect(accessConfig(() => ({ vars: { ACCESS_TEAM_DOMAIN: TEAM } }))).toHaveProperty("error");
  });

  // Regression: 11f0ca6 — an unreadable wrangler.jsonc escaped main as an exception, exit 1 (a finding) instead of 2 (could not run)
  it("turns an unreadable configuration into a refusal, never a throw", () => {
    const result = accessConfig(() => { throw new Error("ENOENT wrangler.jsonc"); });
    expect(result).toEqual({ error: "wrangler.jsonc illisible : ENOENT wrangler.jsonc" });
  });

  it("reads the repository's wrangler.jsonc, not one relative to the working directory", () => {
    expect(PROBE_CONFIG_PATH).toBe(resolve(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc"));
    const vars = readDeployConfig(PROBE_CONFIG_PATH).vars ?? {};
    expect([typeof vars.ACCESS_TEAM_DOMAIN, typeof vars.ACCESS_AUD]).toEqual(["string", "string"]);
    expect(JSON.stringify(accessConfig(() => readDeployConfig(PROBE_CONFIG_PATH)))).not.toContain("illisible");
  });

  // Regression: 4ad4f61 — the committed REPLACE_ME team domain and AUD were accepted: every Access check then failed, exit 1 (a finding) where nothing could be checked (2)
  it("refuses an unfilled or malformed team domain or AUD tag, an uppercase team domain included", () => {
    for (const vars of [
      { ACCESS_TEAM_DOMAIN: "REPLACE_ME.cloudflareaccess.com", ACCESS_AUD: "REPLACE_ME" },
      { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "REPLACE_ME" },
      { ACCESS_TEAM_DOMAIN: "REPLACE_ME.cloudflareaccess.com", ACCESS_AUD: AUD },
      { ACCESS_TEAM_DOMAIN: "Revah.cloudflareaccess.com", ACCESS_AUD: AUD },
      { ACCESS_TEAM_DOMAIN: "revah.example.com", ACCESS_AUD: AUD },
      { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD.toUpperCase() },
    ]) {
      expect(accessConfig(() => ({ vars }))).toHaveProperty("error");
    }
  });
});

describe("baseRefusal", () => {
  it("accepts the Worker's own address, DEFAULT_URL exactly", () => {
    expect(baseRefusal(BASE, false, BASE)).toBeNull();
  });

  // Regression: 3f23107 — an LA_TABLE_URL left set from a local test was probed and could pass with nothing naming it
  it("refuses any other address unless --any-base asks for it", () => {
    for (const base of ["http://localhost:8791", "https://table.revah.paris", "https://other.w2ur.workers.dev", `${BASE}/app`]) {
      expect(baseRefusal(base, false, BASE)).toContain(base);
      expect(baseRefusal(base, true, BASE)).toBeNull();
    }
    expect(liveArgs(["--any-base"])).toMatchObject({ anyBase: true });
  });

  // Regression: 2305315 — any la-table.<subdomain>.workers.dev was accepted, the provisional replace-me (first come, first served) included: the service token went to an address the owner may not own
  it("refuses another account's workers.dev address and the provisional subdomain, even under --any-base for the latter", () => {
    expect(baseRefusal(PLACEHOLDER_URL, false, BASE)).toContain(PLACEHOLDER_URL);
    expect(baseRefusal(PLACEHOLDER_URL, true, BASE)).toContain(PLACEHOLDER_URL);
    expect(baseRefusal(`${PLACEHOLDER_URL}/app`, true, BASE)).toContain("provisoire");
    // DEFAULT_URL itself, until the account's subdomain fills it
    expect(baseRefusal(PLACEHOLDER_URL, false, PLACEHOLDER_URL)).toContain("provisoire");
    expect(baseRefusal("https://la-table.other.workers.dev", false, BASE)).toContain("https://la-table.other.workers.dev");
    expect(baseRefusal("https://la-table.other.workers.dev", false)).toContain("https://la-table.other.workers.dev");
  });

  // Regression: 4e8df93 — the provisional hostname spelled with a root dot passed `--any-base`
  it("refuses the provisional subdomain spelled with a root dot or :443, under --any-base too", () => {
    for (const base of [`${PLACEHOLDER_URL}.`, `${PLACEHOLDER_URL}.:443`, `${PLACEHOLDER_URL}:443`]) {
      expect(baseRefusal(base, true, BASE)).toContain("provisoire");
    }
  });

  // Regression: 2305315 — --any-base accepted http:// anywhere, so the Client Secret could go out in cleartext
  it("under --any-base, refuses cleartext except to this machine, and what is not an address", () => {
    for (const base of ["http://table.revah.paris", "http://192.168.1.10:8787", "ftp://localhost", "pas une adresse"]) expect(baseRefusal(base, true, BASE)).toContain(base);
    for (const base of ["http://localhost:8791", "http://127.0.0.1:8791", "http://[::1]:8791", "https://table.revah.paris"]) expect(baseRefusal(base, true, BASE)).toBeNull();
  });
});

describe("liveReport", () => {
  const pass = { name: "a", ok: true, detail: "200" };
  it("exits 0 when every check passed and none was left unmade", () => {
    expect(liveReport([pass, pass])).toEqual({ lines: ["ok     a (200)", "ok     a (200)"], exit: 0 });
  });

  it("exits 1 on a failed check, whatever else could not be made", () => {
    expect(liveReport([pass, { name: "b", ok: false, detail: "302" }], ["x"]).exit).toBe(1);
  });

  // Regression: 3f23107 — the version URL check, when it could not be made, was a log line and the probe still exited 0
  it("exits 2 when nothing was checked, or a check could not be made, naming it", () => {
    expect(liveReport([]).exit).toBe(2);
    const r = liveReport([pass], ["l'adresse de la version en cours (version illisible)"]);
    expect(r.exit).toBe(2);
    expect(r.lines.at(-1)).toBe("NON VÉRIFIÉ l'adresse de la version en cours (version illisible)");
  });
});
