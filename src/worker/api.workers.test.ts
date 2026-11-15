import { SELF, env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { WIDEST_BATCH, WORST_CALLS } from "./d1-budget";
import worker from "./index";

const allow = createApp({ verify: async () => true, now: () => "2026-10-12T10:00:00Z" });
const call = (path: string, init?: RequestInit) => allow.fetch(new Request(`https://table.test${path}`, init), env as never);
const post = (ops: unknown[]) => call("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) });

describe("API through the real entry point", () => {
  it("answers health without auth and refuses /api/state without an Access token", async () => {
    const health = await SELF.fetch("https://table.test/api/health");
    expect(health.status).toBe(200);
    // the version_metadata binding of wrangler.jsonc reaches the entry point
    expect(await health.json()).toMatchObject({ ok: true, version: expect.any(String) });
    const res = await SELF.fetch("https://table.test/api/state");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });
});

describe("Access through the real entry point", () => {
  const TEAM = "test.cloudflareaccess.com";
  let sign: (aud: string) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] };
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json(jwks);
      return realFetch(input, init);
    });
    sign = (aud) => new SignJWT({ email: "william@example.test" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setAudience(aud).setIssuer(`https://${TEAM}`).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  });
  afterAll(() => vi.restoreAllMocks());

  const state = (token: string) => SELF.fetch("https://table.test/api/state", { headers: { "cf-access-jwt-assertion": token } });

  it("accepts a token for the configured audience and refuses one for another audience", async () => {
    expect((await state(await sign("test-aud"))).status).toBe(200);
    const res = await state(await sign("another-app"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  // Regression: b7c5086 — POST /api/ops took any content type, so a cross-site text/plain form post carrying the Access cookie was applied
  it("refuses an op post that is not application/json with 415, and applies one that is", async () => {
    const token = await sign("test-aud");
    const body = JSON.stringify({ ops: [{ opId: "csrf1", type: "stock.add", at: "2026-10-12T09:00:00Z", payload: { label: "piège", productId: null, qtyText: null, useBy: null } }] });
    const postAs = (contentType: string) => SELF.fetch("https://table.test/api/ops", {
      method: "POST", headers: { "cf-access-jwt-assertion": token, "content-type": contentType }, body,
    });
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await postAs(contentType);
      expect({ contentType, status: res.status, body: await res.json() }).toEqual({ contentType, status: 415, body: { ok: false, error: "json_expected" } });
    }
    const ok = await postAs("application/json; charset=utf-8");
    expect(ok.status).toBe(200);
    expect((await ok.json<{ results: { status: string }[] }>()).results.map((r) => r.status)).toEqual(["applied"]);
  });

  it("bypasses Access only when DEV_SKIP_ACCESS is exactly '1', on localhost", async () => {
    const request = () => new Request("http://localhost:8787/api/state");
    expect((await worker.fetch(request(), env as never)).status).toBe(401);
    expect((await worker.fetch(request(), { ...env, DEV_SKIP_ACCESS: "true" } as never)).status).toBe(401);
    expect((await worker.fetch(request(), { ...env, DEV_SKIP_ACCESS: "1" } as never)).status).toBe(200);
    // the same bypass on the deployed hostname: the entry point still asks for the token
    expect((await worker.fetch(new Request("https://la-table.w2ur.workers.dev/api/state"), { ...env, DEV_SKIP_ACCESS: "1" } as never)).status).toBe(401);
  });
});

describe("API behaviour", () => {
  it("returns an empty snapshot, then applies ops and returns per-op results with a fresh snapshot", async () => {
    const state = await (await call("/api/state")).json<{ menu: { pool: unknown[] } }>();
    expect(state.menu.pool).toEqual([]);
    const res = await post([
      { opId: "a1", type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: "soupe", url: null } },
      { opId: "a2", type: "menu.teleport", at: "2026-10-12T09:00:00Z", payload: {} },
      { opId: "a3", type: "shopping.add", at: "2026-10-12T09:00:00Z", payload: { label: "lait", isFood: true } },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json<{ results: { opId: string; status: string }[]; snapshot: { menu: { envies: unknown[] }; courses: { lines: unknown[] } } }>();
    expect(body.results.map((r) => [r.opId, r.status])).toEqual([["a1", "applied"], ["a2", "refused"], ["a3", "applied"]]);
    expect(body.snapshot.menu.envies).toHaveLength(1);
    expect(body.snapshot.courses.lines).toHaveLength(1);
  });

  it("rejects a malformed body with 400 and more than 100 ops with 413", async () => {
    expect((await call("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: "nope" })).status).toBe(400);
    expect((await post(Array.from({ length: 101 }, (_, i) => ({ opId: `x${i}` })))).status).toBe(413);
  });

  it("persists product.upsert in D1: an insert under the next id, then an update of that row, each bumping the version", async () => {
    type History = { version: number; products: { id: number; name: string; isStaple: boolean }[]; lastIds: { products?: number } };
    const read = async () => (await call("/api/history")).json<History>();
    const before = await read();
    const product = { name: "huile de sésame", category: "epicerie", is_staple: true, roles: [], is_fresh_produce: false,
      season_months: null, shelf_life_days: null, opened_shelf_life_days: null, default_unit: "ml" };
    const at = "2026-10-12T09:00:00Z";
    const added = await post([{ opId: "pu1", type: "product.upsert", at, payload: product }]);
    expect((await added.json<{ results: { status: string }[] }>()).results[0]!.status).toBe("applied");
    const afterAdd = await read();
    const id = Math.max(...before.products.map((p) => p.id)) + 1;
    expect(afterAdd.products.find((p) => p.name === "huile de sésame")).toMatchObject({ id, isStaple: true });
    expect(afterAdd.lastIds.products).toBe(id);
    expect(afterAdd.version).toBeGreaterThan(before.version);
    await post([{ opId: "pu2", type: "product.upsert", at, payload: { ...product, is_staple: false } }]);
    const afterUpdate = await read();
    expect(afterUpdate.products.filter((p) => p.name === "huile de sésame")).toEqual([expect.objectContaining({ id, isStaple: false })]);
    expect(afterUpdate.version).toBeGreaterThan(afterAdd.version);
  });

  it("persists product.nutrition in D1 on one product row, bumping the version", async () => {
    type History = { version: number; products: { name: string; category: string; nutrition: { ciqualCode: string; gramsPerPiece: number | null } | null }[] };
    const read = async () => (await call("/api/history")).json<History>();
    const before = await read();
    const target = before.products.find((p) => p.nutrition === null)!;
    const nutrition = { ciqual_code: "T0001", per_100g: { kcal: 30, protein_g: 1.5, carbs_g: 4.6, fat_g: 0.3, fibre_g: 3.2, salt_g: 0.02 }, grams_per_piece: 250, grams_per_ml: null, edible_pct: 100 };
    const res = await post([{ opId: "pn1", type: "product.nutrition", at: "2026-10-12T09:00:00Z", payload: { name: target.name, nutrition } }]);
    expect((await res.json<{ results: { status: string }[] }>()).results[0]!.status).toBe("applied");
    const after = await read();
    expect(after.products.find((p) => p.name === target.name)).toMatchObject({ category: target.category, nutrition: { ciqualCode: "T0001", gramsPerPiece: 250 } });
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("persists product.pack in D1 on one product row, bumping the version", async () => {
    type History = { version: number; products: { name: string; category: string; pack: { qty: number; unit: string } | null; price: { cents: number } | null }[] };
    const read = async () => (await call("/api/history")).json<History>();
    const before = await read();
    const target = before.products.find((p) => p.pack === null)!;
    const res = await post([{ opId: "pp1", type: "product.pack", at: "2026-10-12T09:00:00Z", payload: { name: target.name, pack: { qty: 250, unit: "g" }, price: { cents: 287, qty: 250, unit: "g" } } }]);
    expect((await res.json<{ results: { status: string }[] }>()).results[0]!.status).toBe("applied");
    const after = await read();
    expect(after.products.find((p) => p.name === target.name)).toMatchObject({ category: target.category, pack: { qty: 250, unit: "g" }, price: { cents: 287 } });
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("serves the full state on /api/history", async () => {
    const body = await (await call("/api/history")).json<{ products: unknown[]; appliedOps?: unknown }>();
    expect(body.products.length).toBeGreaterThan(100);
    expect(body.appliedOps).toBeUndefined();
  });
});

describe("a D1 failure", () => {
  // Regression: 62dc4b5 — a D1 error inside one op failed the whole request with a 500 and no JSON body
  it("answers JSON 200 with every op refused and recorded nowhere, so a resend applies them", async () => {
    let failing = true;
    let batches = 0;
    const flaky = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        batches += 1;
        if (failing && batches === 2) throw new Error("D1 indisponible"); // the load passes, the write fails
        return env.DB.batch(statements);
      },
    };
    const ops = [
      { opId: "f1", type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: "risotto", url: null } },
      { opId: "f2", type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: "gaspacho", url: null } },
    ];
    const send = () => allow.fetch(
      new Request("https://table.test/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) }),
      { ...env, DB: flaky } as never,
    );
    const res = await send();
    expect(res.status).toBe(200);
    const body = await res.json<{ results: { opId: string; status: string; reason: string | null }[]; snapshot: { menu: { envies: { text: string }[] } } }>();
    expect(body.results).toEqual([
      { opId: "f1", status: "refused", reason: "erreur interne : D1 indisponible" },
      { opId: "f2", status: "refused", reason: "erreur interne : D1 indisponible" },
    ]);
    expect(body.snapshot.menu.envies.map((e) => e.text)).not.toContain("risotto");
    failing = false;
    const retry = await (await send()).json<{ results: { status: string }[] }>();
    expect(retry.results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });
});

describe("a D1 failure after the write committed", () => {
  // Regression: b25e871 — the batch committed and the call then threw, so the app answered refused for an op D1 holds as applied
  it("answers each op D1 recorded with its stored status, and refuses only the others", async () => {
    let batches = 0;
    const lostAck = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        const r = await env.DB.batch(statements);
        batches += 1;
        if (batches === 2) throw new Error("connexion perdue"); // the write commits, its answer never arrives
        return r;
      },
    };
    const ops = [
      { opId: "lost1", type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: "blanquette", url: null } },
      { opId: "lost2", type: "menu.teleport", at: "2026-10-12T09:00:00Z", payload: {} },
      { type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: "sans id", url: null } },
    ];
    const res = await allow.fetch(
      new Request("https://table.test/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) }),
      { ...env, DB: lostAck } as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ results: { opId: string | null; status: string; reason: string | null }[]; snapshot: { menu: { envies: { text: string }[] } } }>();
    expect(body.results).toEqual([
      { opId: "lost1", status: "applied", reason: null },
      { opId: "lost2", status: "refused", reason: "opération inconnue" },
      { opId: null, status: "refused", reason: "opération mal formée" },
    ]);
    expect(body.snapshot.menu.envies.map((e) => e.text)).toContain("blanquette");
  });
});

describe("D1 calls per request", () => {
  /**
   * Counts every round trip to D1 (batches, and any statement run on its own) and the statements each carries. With
   * `conflict`, another writer bumps meta.version (uncounted) just before each write batch, whose version claim
   * (its first statement) then fails: every attempt conflicts.
   */
  function counted(options: { conflict?: boolean } = {}) {
    let calls = 0;
    let conflicts = 0;
    const sizes: number[] = [];
    const sql = new WeakMap<D1PreparedStatement, string>();
    const wrap = (st: D1PreparedStatement, text: string): D1PreparedStatement => {
      sql.set(st, text);
      for (const m of ["first", "all", "run", "raw"] as const) {
        const real = (st[m] as (...a: unknown[]) => unknown).bind(st);
        (st as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => { calls += 1; sizes.push(1); return real(...a); };
      }
      const bind = st.bind.bind(st);
      st.bind = (...values: unknown[]) => wrap(bind(...values), text);
      return st;
    };
    const db = {
      prepare: (text: string) => wrap(env.DB.prepare(text), text),
      batch: async (statements: D1PreparedStatement[]) => {
        calls += 1;
        sizes.push(statements.length);
        if (options.conflict && statements.length > 1 && /^UPDATE meta SET version = \? WHERE id = 1 AND version = \?$/.test(sql.get(statements[0]!) ?? "")) {
          conflicts += 1;
          await env.DB.prepare("UPDATE meta SET version = version + 1 WHERE id = 1").run();
        }
        return env.DB.batch(statements);
      },
      exec: (text: string) => { calls += 1; sizes.push(1); return env.DB.exec(text); },
    };
    return { db, calls: () => calls, sizes: () => [...sizes], conflicts: () => conflicts };
  }
  const send = (db: unknown, n: number, tag: string) => allow.fetch(
    new Request("https://table.test/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops:
      Array.from({ length: n }, (_, i) => ({ opId: `${tag}${i}`, type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: `${tag} ${i}`, url: null } })) }) }),
    { ...env, DB: db } as never,
  );

  it("costs a product.nutrition op no more D1 calls than any other op", async () => {
    const other = counted();
    expect((await send(other.db, 1, "n-other-")).status).toBe(200);
    const nutrition = counted();
    const body = { ops: [{ opId: "n-cost", type: "product.nutrition", at: "2026-10-12T09:00:00Z", payload: { name: "poireau", nutrition: null } }] };
    const res = await allow.fetch(new Request("https://table.test/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { ...env, DB: nutrition.db } as never);
    expect((await res.json<{ results: { status: string }[] }>()).results[0]!.status).toMatch(/applied|noop/);
    expect(nutrition.calls()).toBe(other.calls());
  });

  it("costs a product.pack op no more D1 calls than any other op", async () => {
    const other = counted();
    expect((await send(other.db, 1, "p-other-")).status).toBe(200);
    const pack = counted();
    const body = { ops: [{ opId: "p-cost", type: "product.pack", at: "2026-10-12T09:00:00Z", payload: { name: "poireau", pack: null, price: null } }] };
    const res = await allow.fetch(new Request("https://table.test/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { ...env, DB: pack.db } as never);
    expect((await res.json<{ results: { status: string }[] }>()).results[0]!.status).toMatch(/applied|noop/);
    expect(pack.calls()).toBe(other.calls());
  });

  // Regression: c3f190e — each op loaded every table and wrote its own batch, so a 100-op outbox made 200+ D1 calls against a budget of 50
  it("stays constant in the number of ops: one load and one write", async () => {
    const one = counted();
    expect((await send(one.db, 1, "c-one-")).status).toBe(200);
    const hundred = counted();
    const res = await send(hundred.db, 100, "c-hundred-");
    const body = await res.json<{ results: { status: string }[] }>();
    expect(body.results.filter((r) => r.status === "applied")).toHaveLength(100);
    expect(hundred.calls()).toBe(one.calls());
    expect(hundred.calls()).toBeLessThanOrEqual(4);
  });

  /**
   * The worst request the Worker serves, for Workers Free's D1 budget per invocation (50): a full outbox (100 ops) whose
   * first op is an undo — so the load carries 3a's row-undo statement and B18's later-writes statement — and whose
   * every attempt conflicts (3), then the reload that answers it. A measurement on Cloudflare (`probes/d1-limit`) tells whether the budget
   * counts calls or statements; these numbers are what that measurement is compared with.
   */
  it("costs 7 D1 calls at worst: 3 conflicting attempts of a 100-op request carrying an undo, then the reload", async () => {
    type Lines = { snapshot: { courses: { lines: { id: number; label: string }[] } } };
    const at = "2026-10-12T09:00:00Z";
    const added = await (await post([{ opId: "budget-add", type: "shopping.add", at, payload: { label: "budget-lait", isFood: true } }])).json<Lines>();
    const line = added.snapshot.courses.lines.find((l) => l.label === "budget-lait")!;
    await post([{ opId: "budget-buy", type: "shopping.buy", at, payload: { itemId: line.id } }]);
    const ops = [
      { opId: "budget-undo", type: "undo", at, payload: { targetOpId: "budget-buy" } },
      ...Array.from({ length: 99 }, (_, i) => ({ opId: `budget-envie-${i}`, type: "envie.add", at, payload: { text: `budget ${i}`, url: null } })),
    ];
    const postWith = (db: unknown) => allow.fetch(
      new Request("https://table.test/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) }),
      { ...env, DB: db } as never,
    );

    const worst = counted({ conflict: true });
    const lost = await (await postWith(worst.db)).json<{ unrecorded: string[] }>();
    expect(lost.unrecorded).toHaveLength(100); // every attempt conflicted: the worst case was reached, not assumed
    expect(worst.conflicts()).toBe(3);
    expect(worst.calls()).toBe(WORST_CALLS);
    // statements per call: load, write, three times, then the reload; a new statement in any of them shows here first
    expect(worst.sizes()).toEqual([14, 207, 14, 207, 14, 207, 12]);
    expect(Math.max(...worst.sizes())).toBe(WIDEST_BATCH);

    // control: the same request with no other writer lands in one load and one write, the undo applied
    const calm = counted();
    const landed = await (await postWith(calm.db)).json<{ results: { status: string }[]; unrecorded: string[] }>();
    expect(landed.unrecorded).toEqual([]);
    expect(landed.results[0]!.status).toBe("applied");
    expect(calm.calls()).toBe(2);
  });

  it("answers with the snapshot a fresh read gives", async () => {
    const res = await send(env.DB, 3, "snap-");
    const { snapshot } = await res.json<{ snapshot: unknown }>();
    expect(snapshot).toEqual(await (await call("/api/state")).json());
  });
});

describe("ops answered without a stored record", () => {
  const envie = (opId: string) => ({ opId, type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: opId, url: null } });
  const postTo = (db: unknown, ops: unknown[]) => allow.fetch(
    new Request("https://table.test/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) }),
    { ...env, DB: db } as never,
  );
  type Body = { results: { opId: string | null; status: string; reason: string | null }[]; unrecorded: string[] };

  // Regression: b9957d8 — « erreur interne » and an exhausted conflict were answered as plain refusals, so a client read « may not have landed » as final
  it("lists them in unrecorded, and never an op whose answer D1 holds", async () => {
    const ok = await (await post([envie("u-ok"), { ...envie("u-unknown"), type: "menu.teleport" }, { type: "envie.add" }, { ...envie("u-bad"), at: "hier" }])).json<Body>();
    expect(ok.results.map((r) => r.status)).toEqual(["applied", "refused", "refused", "refused"]);
    // a domain refusal is recorded; an op without an id cannot be resent by id; a malformed op gets the same answer on any resend
    expect(ok.unrecorded).toEqual([]);

    let rounds = 0;
    const conflicting = new Proxy(env.DB, { get(target, prop) {
      if (prop === "batch") return async (s: D1PreparedStatement[]) => {
        rounds += 1;
        if (rounds % 2 === 0) await target.prepare("UPDATE meta SET version = version + 1 WHERE id = 1").run(); // another writer before every write
        return target.batch(s);
      };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const lost = await (await postTo(conflicting, [envie("u-ok"), envie("u-conflict")])).json<Body>();
    expect(lost.results.map((r) => [r.opId, r.status])).toEqual([["u-ok", "applied"], ["u-conflict", "refused"]]);
    expect(lost.unrecorded).toEqual(["u-conflict"]);

    let writes = 0;
    const failingWrite = { prepare: (sql: string) => env.DB.prepare(sql), batch: async (s: D1PreparedStatement[]) => {
      writes += 1;
      if (writes === 2) throw new Error("D1 indisponible"); // the load passes, the write fails
      return env.DB.batch(s);
    } };
    const failed = await (await postTo(failingWrite, [envie("u-ok"), envie("u-fail")])).json<Body>();
    expect(failed.results.map((r) => [r.opId, r.status])).toEqual([["u-ok", "applied"], ["u-fail", "refused"]]);
    expect(failed.unrecorded).toEqual(["u-fail"]);

    let calls = 0;
    const unreachable = { prepare: (sql: string) => env.DB.prepare(sql), batch: async (s: D1PreparedStatement[]) => {
      calls += 1;
      if (calls >= 2) throw new Error("D1 injoignable"); // the write fails, and so does the read that would confirm it
      return env.DB.batch(s);
    } };
    const blind = await (await postTo(unreachable, [envie("u-ok"), envie("u-blind")])).json<Body>();
    expect(blind.results.map((r) => r.status)).toEqual(["refused", "refused"]);
    expect(blind.unrecorded).toEqual(["u-ok", "u-blind"]);
  });

  // Regression: 253355b — a malformed op with a string id was listed in unrecorded, so an outbox would resend it forever
  it("answers a malformed op as final, whether D1 is reachable or not", async () => {
    const bad = [{ ...envie("m-at"), at: "hier" }, { ...envie(""), opId: "" }, { ...envie("x".repeat(101)) }];
    const ok = await (await post([...bad, envie("m-ok")])).json<Body>();
    expect(ok.results.map((r) => [r.status, r.reason])).toEqual([...bad.map(() => ["refused", "opération mal formée"]), ["applied", null]]);
    expect(ok.unrecorded).toEqual([]);

    let calls = 0;
    const unreachable = { prepare: (sql: string) => env.DB.prepare(sql), batch: async (s: D1PreparedStatement[]) => {
      calls += 1;
      if (calls >= 2) throw new Error("D1 injoignable");
      return env.DB.batch(s);
    } };
    const blind = await (await postTo(unreachable, [...bad, envie("m-blind")])).json<Body>();
    expect(blind.results.map((r) => [r.status, r.reason])).toEqual([...bad.map(() => ["refused", "opération mal formée"]), ["refused", "erreur interne : D1 injoignable"]]);
    expect(blind.unrecorded).toEqual(["m-blind"]);
  });
});

describe("an op id that names an Object.prototype key", () => {
  // Regression: 8242232 — a stored op with the id "__proto__" was loaded by assignment, which replaced the prototype instead of storing it, so a resend was applied again
  it.each(["__proto__", "constructor"])("stores %s in D1 and answers a resend from the stored record", async (opId) => {
    const add = { opId, type: "envie.add", at: "2026-10-12T09:00:00Z", payload: { text: `velouté ${opId}`, url: null } };
    type Body = { results: { opId: string; status: string }[]; unrecorded: string[]; snapshot: { menu: { envies: { text: string }[] } } };
    const first = await (await post([add])).json<Body>();
    expect([first.results, first.unrecorded]).toEqual([[{ opId, status: "applied", reason: null }], []]);
    const again = await (await post([add])).json<Body>();
    expect([again.results, again.unrecorded]).toEqual([[{ opId, status: "applied", reason: null }], []]);
    expect(again.snapshot.menu.envies.filter((e) => e.text === `velouté ${opId}`)).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = ?").bind(opId).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("undo from a row", () => {
  type Answer = { snapshot: { courses: { lines: { id: number; label: string; buyOpId: string | null }[] } } };
  type Snap = Answer["snapshot"];

  // the op that bought a line travels with the line, in POST answers and GET /api/state alike, for 14 days
  it("names the buy op on its line in the POST answer and in /api/state, and not once the op is older than the window", async () => {
    const label = "undo-row-lait";
    const added = await (await post([{ opId: "row-add", type: "shopping.add", at: "2026-10-12T09:00:00Z", payload: { label, isFood: true } }])).json<Answer>();
    const line = added.snapshot.courses.lines.find((l) => l.label === label)!;
    expect(line.buyOpId).toBeNull();
    const bought = await (await post([{ opId: "row-buy", type: "shopping.buy", at: "2026-10-12T09:01:00Z", payload: { itemId: line.id } }])).json<Answer>();
    expect(bought.snapshot.courses.lines.find((l) => l.id === line.id)!.buyOpId).toBe("row-buy");
    const state = await (await call("/api/state")).json<Snap>();
    expect(state.courses.lines.find((l) => l.id === line.id)!.buyOpId).toBe("row-buy");

    // a phone replaces its base with every answer: a later, unrelated request must still name the earlier buy
    const unrelated = await (await post([{ opId: "row-other", type: "shopping.add", at: "2026-10-12T09:02:00Z", payload: { label: "undo-row-pain", isFood: true } }])).json<Answer>();
    expect(unrelated.snapshot.courses.lines.find((l) => l.id === line.id)!.buyOpId).toBe("row-buy");
    // and so must the answer rebuilt from a fresh read when the write committed but its acknowledgement was lost
    let batches = 0;
    const lostAck = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        const r = await env.DB.batch(statements);
        batches += 1;
        if (batches === 2) throw new Error("connexion perdue");
        return r;
      },
    };
    const lost = await (await allow.fetch(
      new Request("https://table.test/api/ops", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ops: [{ opId: "row-lost", type: "shopping.add", at: "2026-10-12T09:03:00Z", payload: { label: "undo-row-beurre", isFood: true } }] }),
      }),
      { ...env, DB: lostAck } as never,
    )).json<Answer & { results: { status: string }[] }>();
    expect(lost.results.map((r) => r.status)).toEqual(["applied"]);
    expect(lost.snapshot.courses.lines.find((l) => l.id === line.id)!.buyOpId).toBe("row-buy");
    // and so must the answer to a resend-only request, which writes nothing: a replay carries no record of its own
    const resent = await (await post([{ opId: "row-add", type: "shopping.add", at: "2026-10-12T09:00:00Z", payload: { label, isFood: true } }])).json<Answer & { results: { status: string }[]; unrecorded: string[] }>();
    expect([resent.results.map((r) => r.status), resent.unrecorded]).toEqual([["applied"], []]);
    expect(resent.snapshot.courses.lines.find((l) => l.id === line.id)!.buyOpId).toBe("row-buy");

    const later = createApp({ verify: async () => true, now: () => "2026-10-27T10:00:00Z" });
    const old = await (await later.fetch(new Request("https://table.test/api/state"), env as never)).json<Snap>();
    expect(old.courses.lines.find((l) => l.id === line.id)!.buyOpId).toBeNull();
  });
});
