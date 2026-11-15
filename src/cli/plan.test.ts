import { describe, expect, it } from "vitest";
import { snapshot } from "../domain/snapshot";
import { NOW, fixtureProposal, fixtureState } from "../domain/test-fixtures";
import type { CliDeps } from "./plan";
import { run } from "./plan";

const SECRETS: Record<string, string> = { "la-table-access-client-id": "id", "la-table-access-client-secret": "secret" };

function deps(over: Partial<CliDeps> = {}) {
  const out: string[] = [], err: string[] = [], posts: { opId: string }[] = [];
  const files = new Map<string, string>([["p.json", JSON.stringify(fixtureProposal())]]);
  const { appliedOps: _o, ...state } = fixtureState();
  const d: CliDeps = {
    fetch: async (url, init) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/history")) return json(state);
      const ops = JSON.parse(String(init?.body)).ops as { opId: string }[];
      posts.push(...ops);
      return json({ results: ops.map((o) => ({ opId: o.opId, status: "applied", reason: null })), unrecorded: [], snapshot: snapshot(fixtureState(), NOW) });
    },
    readSecret: (s) => SECRETS[s] ?? null,
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    writeFile: (path, text) => void files.set(path, text),
    now: () => NOW,
    // DEFAULT_URL once filled: the committed one names the provisional subdomain, to which the token never goes
    env: {},
    platform: "darwin",
    defaultUrl: "https://la-table.w2ur.workers.dev",
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    uuid: () => "u-1",
    ...over,
  };
  return { d, out, err, posts, files };
}

describe("plan CLI", () => {
  it("status and check exit 0 on the fixture", async () => {
    expect(await run(["status"], deps().d)).toBe(0);
    expect(await run(["check", "p.json"], deps().d)).toBe(0);
  });

  it("exits 2 with the keychain entry named when the secret is missing, before any request", async () => {
    let called = false;
    const { d, err } = deps({ readSecret: () => null, fetch: async () => { called = true; return new Response("{}"); } });
    expect(await run(["status"], d)).toBe(2);
    expect(called).toBe(false);
    expect(err.join("\n")).toMatch(/la-table-access-client-id/);
  });

  it("takes the token from LA_TABLE_CLI_ACCESS_CLIENT_ID / _SECRET when the keychain is empty, and sends it", async () => {
    const sent: unknown[] = [];
    const base = deps();
    const { d } = deps({
      readSecret: () => null,
      env: { LA_TABLE_CLI_ACCESS_CLIENT_ID: "env-id", LA_TABLE_CLI_ACCESS_CLIENT_SECRET: "env-s" },
      fetch: async (url, init) => { sent.push(init?.headers); return base.d.fetch(url, init); },
    });
    expect(await run(["status"], d)).toBe(0);
    expect(sent[0]).toMatchObject({ "CF-Access-Client-Id": "env-id", "CF-Access-Client-Secret": "env-s" });
    // the control: the same environment on a non-darwin platform, with a keychain that would answer, still uses the variables
    sent.length = 0;
    expect(await run(["status"], { ...d, platform: "linux", readSecret: (s) => SECRETS[s] ?? null })).toBe(0);
    expect(sent[0]).toMatchObject({ "CF-Access-Client-Id": "env-id" });
  });

  it("--local needs no keychain", async () => {
    expect(await run(["status", "--local"], deps({ readSecret: () => null }).d)).toBe(0);
  });

  it("exits 2 when the proposal file cannot be read, and 1 when it is not JSON", async () => {
    const a = deps();
    expect(await run(["check", "absent.json"], a.d)).toBe(2);
    expect(a.err.join("\n")).toMatch(/absent\.json/);
    const b = deps();
    b.files.set("bad.json", "{ not json");
    expect(await run(["check", "bad.json"], b.d)).toBe(1);
    expect(b.out.join("\n")).toContain("[schema]");
  });

  it("stock reads its inventory file and sends stock.add; without the file it exits 2 naming it", async () => {
    const t = deps();
    t.files.set("inv.json", JSON.stringify({ items: [{ product: "riz complet", qty: "120 g" }] }));
    expect(await run(["stock", "inv.json"], t.d)).toBe(0);
    expect(t.posts).toMatchObject([{ type: "stock.add", payload: { productId: 6, label: "riz complet", qtyText: "120 g", useBy: null } }]);
    const u = deps();
    expect(await run(["stock"], u.d)).toBe(2);
    expect(u.err.join("\n")).toMatch(/fichier d.inventaire manquant/);
  });

  it("fini refuses a missing or malformed id before the keychain is read", async () => {
    for (const bad of [["fini"], ["fini", "x"], ["fini", "101", "1,5"]]) {
      const read: string[] = [];
      const u = deps({ readSecret: (name) => { read.push(name); return SECRETS[name] ?? null; } });
      expect(await run(bad, u.d)).toBe(2);
      expect({ bad, read, posts: u.posts }).toEqual({ bad, read: [], posts: [] });
    }
  });

  it("reste joins its words, strips the flags, and sends stock.partial; usage mistakes exit 2 before any request", async () => {
    const state = fixtureState();
    state.stockItems.push({ id: 64, productId: 2, label: "comté", qty: 0, unit: "g", qtyText: null, isLow: true, useBy: null, openedAt: null, finishedAt: null, origin: "ajout", sourceShoppingItemId: null, sourceMealId: null, createdAt: NOW });
    const { appliedOps: _o, ...history } = state;
    const sent: { type: string; payload: unknown }[] = [];
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const t = deps({
      fetch: async (url, init) => {
        if (url.endsWith("/api/history")) return json(history);
        const ops = JSON.parse(String(init?.body)).ops as { opId: string; type: string; payload: unknown }[];
        sent.push(...ops);
        return json({ results: ops.map((o) => ({ opId: o.opId, status: "applied", reason: null })), unrecorded: [], snapshot: snapshot(state, NOW) });
      },
    });
    expect(await run(["reste", "64", "125", "g", "--pas-low"], t.d)).toBe(0);
    expect(sent).toMatchObject([{ type: "stock.partial", payload: { itemId: 64, qtyText: "125 g", low: false } }]);
    await run(["reste", "64", "125g"], t.d);
    expect(sent[1]).toMatchObject({ payload: { qtyText: "125g", low: true } });
    for (const bad of [["reste"], ["reste", "64"], ["reste", "x", "125g"], ["reste", "64", "125g", "--low", "--pas-low"]]) {
      const read: string[] = [];
      const u = deps({ readSecret: (name) => { read.push(name); return SECRETS[name] ?? null; } });
      expect(await run(bad, u.d)).toBe(2);
      expect(u.posts).toEqual([]);
      // Regression: 03e177e — a malformed id was refused only after the keychain was read
      expect({ bad, read }).toEqual({ bad, read: [] });
    }
  });

  it("bought joins its words, strips --oui, and exits 2 on a usage mistake before the keychain is read", async () => {
    const state = fixtureState();
    state.shoppingItems.push({ id: 46, productId: 2, label: "comté", qty: 200, unit: "g", plannedQty: null, estPriceCents: 500, kind: "planning", planningId: 1,
      forMeals: [], isFood: true, boughtAt: NOW, tripId: null, removedAt: null, createdAt: NOW });
    const { appliedOps: _o, ...history } = state;
    const sent: { type: string; payload: unknown }[] = [];
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const t = deps({
      fetch: async (url, init) => {
        if (url.endsWith("/api/history")) return json(history);
        const ops = JSON.parse(String(init?.body)).ops as { opId: string; type: string; payload: unknown }[];
        sent.push(...ops);
        return json({ results: ops.map((o) => ({ opId: o.opId, status: "refused", reason: "pas d'article en Reste" })), unrecorded: [], snapshot: snapshot(state, NOW) });
      },
    });
    expect(await run(["bought", "46", "2,1", "kg", "--oui"], t.d)).toBe(1);
    expect(sent).toMatchObject([{ type: "shopping.set_bought_qty", payload: { itemId: 46, qty: 2100 } }]);
    expect(t.err.join("\n")).toBe("✗ #46 comté : refusé (pas d'article en Reste)");
    for (const bad of [["bought"], ["bought", "46"], ["bought", "x", "1 kg"], ["bought", "--oui", "46"]]) {
      const read: string[] = [];
      const u = deps({ readSecret: (name) => { read.push(name); return SECRETS[name] ?? null; } });
      expect(await run(bad, u.d)).toBe(2);
      expect({ bad, read, posts: u.posts }).toEqual({ bad, read: [], posts: [] });
    }
  });

  it("manques exits 2 on a malformed meal id before the keychain is read, and says « Manques : aucun » on a clean state", async () => {
    const read: string[] = [];
    const u = deps({ readSecret: (name) => { read.push(name); return SECRETS[name] ?? null; } });
    expect(await run(["manques", "x"], u.d)).toBe(2);
    expect({ read, posts: u.posts }).toEqual({ read: [], posts: [] });
    const t = deps();
    expect(await run(["manques"], t.d)).toBe(0);
    expect(t.out).toEqual(["Manques : aucun"]);
  });

  it("catalogue reads its products file and sends product.upsert; without the file it exits 2 naming it", async () => {
    const t = deps();
    const p = { name: "origan", category: "epicerie", is_staple: true, roles: [], is_fresh_produce: false, season_months: null, shelf_life_days: null, opened_shelf_life_days: null, default_unit: "g" };
    t.files.set("cat.json", JSON.stringify({ products: [p] }));
    expect(await run(["catalogue", "cat.json"], t.d)).toBe(0);
    expect(t.posts).toMatchObject([{ type: "product.upsert", payload: p }]);
    const u = deps();
    expect(await run(["catalogue"], u.d)).toBe(2);
    expect(u.err.join("\n")).toMatch(/fichier de produits manquant/);
  });

  it("nutrition reads its products file and sends product.nutrition; without the file it exits 2 naming it", async () => {
    const t = deps();
    const n = { ciqual_code: "20049", per_100g: { kcal: 31, protein_g: 2, carbs_g: 3, fat_g: 0.3, fibre_g: 2, salt_g: 0 }, grams_per_piece: null, grams_per_ml: null, edible_pct: 100 };
    t.files.set("nut.json", JSON.stringify({ products: [{ name: "poireau", nutrition: n }] }));
    expect(await run(["nutrition", "nut.json"], t.d)).toBe(0);
    expect(t.posts).toMatchObject([{ type: "product.nutrition", payload: { name: "poireau", nutrition: n } }]);
    const u = deps();
    expect(await run(["nutrition"], u.d)).toBe(2);
    expect(u.err.join("\n")).toMatch(/fichier de produits manquant[\s\S]*usage/);
  });

  it("commit records its op id next to the proposal before sending it", async () => {
    let journaledAtSend: unknown[] = [];
    const t = deps();
    const serve = t.d.fetch;
    t.d.fetch = async (url, init) => {
      if (url.endsWith("/api/ops")) journaledAtSend = Object.values(JSON.parse(t.files.get("p.json.envois.json")!));
      return serve(url, init);
    };
    expect(await run(["commit", "p.json"], t.d)).toBe(0);
    expect(t.posts.map((p) => p.opId)).toEqual(["commit-u-1"]);
    expect(journaledAtSend).toEqual(["commit-u-1"]);
    expect(JSON.parse(t.files.get("p.json.envois.json")!)).toEqual({}); // the final answer clears it
  });

  it("commit exits 2 and sends nothing when the journal cannot be written", async () => {
    const t = deps({ writeFile: () => { throw new Error("EACCES"); } });
    expect(await run(["commit", "p.json"], t.d)).toBe(2);
    expect(t.posts).toEqual([]);
  });

  it("commit exits 2 asking for the same command when the journal cannot be cleared after the answer, and that rerun replays it", async () => {
    const t = deps();
    const write = t.d.writeFile;
    t.d.writeFile = (path, text) => { if (text === "{}") throw new Error("EACCES"); write(path, text); };
    expect(await run(["commit", "p.json"], t.d)).toBe(2);
    expect(t.err.join("\n")).toMatch(/réponse du serveur est arrivée, relancez la même commande/);
    t.d.writeFile = write;
    expect(await run(["commit", "p.json"], t.d)).toBe(0);
    expect(t.posts.map((p) => p.opId)).toEqual(["commit-u-1", "commit-u-1"]);
  });

  it("price and total send integer cents, and refuse a bad amount or id without a request", async () => {
    const a = deps();
    expect(await run(["price", "7", "3,5"], a.d)).toBe(0);
    expect(a.posts).toEqual([{ opId: "u-1", type: "shopping.set_price", at: NOW, payload: { itemId: 7, estPriceCents: 350 } }]);
    const b = deps();
    expect(await run(["total", "2", "41,80"], b.d)).toBe(0);
    expect(b.posts).toEqual([{ opId: "u-1", type: "trip.set_total", at: NOW, payload: { tripId: 2, totalCents: 4180 } }]);
    // Regression: 57006c8 — `status` skipped the extra-argument check, so a typo such as `--locla` hit the real host
    for (const args of [["price", "7", "-1"], ["price", "x", "3"], ["price", "7"], ["price", "7", "3", "50"], ["total", "2", "3", "50"], ["check", "p.json", "x"], ["commit", "p.json", "x"], ["total", "2", "3,505"], ["total", "2", "12345678"], ["status", "x"], ["status", "--locla"], ["frobnicate"], []]) {
      const c = deps();
      expect(await run(args, c.d), args.join(" ")).toBe(2);
      expect(c.posts).toEqual([]);
    }
  });

  // Regression: 6153148 — `total <trip> 0` set a 0-cent trip total and pushed a 0 ratio into calibration
  it("total refuses 0 € as a usage error without a request, while price still accepts it", async () => {
    for (const zero of ["0", "0,00", "0.0"]) {
      const c = deps();
      expect(await run(["total", "2", zero], c.d), zero).toBe(2);
      expect(c.posts).toEqual([]);
    }
    const p = deps();
    expect(await run(["price", "7", "0"], p.d)).toBe(0);
  });

  // Regression: 9a9ee68 — a truncated journal read as empty, so a rerun lost its op id and hit the no-repeat gate
  it("commit exits 2 and sends nothing when the journal is truncated or not string-valued", async () => {
    for (const bad of ["{ trunc", '{"k":3}', "[]", "null"]) {
      const t = deps();
      t.files.set("p.json.envois.json", bad);
      expect(await run(["commit", "p.json"], t.d), bad).toBe(2);
      expect(t.posts).toEqual([]);
      expect(t.err.join("\n")).toContain("illisible");
    }
    // Regression: 89e1004 — only ENOENT (by code) reads as no journal; EACCES must not read as empty
    const u = deps({ readFile: (p) => { if (p.endsWith(".envois.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); return deps().files.get(p)!; } });
    expect(await run(["commit", "p.json"], u.d), "EACCES").toBe(2);
    expect(u.posts).toEqual([]);
    expect(u.err.join("\n")).toContain("illisible");
  });

  it("price exits 1 with the reason when the server refuses", async () => {
    const { d, err } = deps({
      fetch: async (_u, init) => new Response(JSON.stringify({ results: [{ opId: JSON.parse(String(init?.body)).ops[0].opId, status: "refused", reason: "article retiré" }], unrecorded: [], snapshot: snapshot(fixtureState(), NOW) }), { headers: { "content-type": "application/json" } }),
    });
    expect(await run(["price", "7", "2"], d)).toBe(1);
    expect(err.join("\n")).toContain("article retiré");
  });

  // Regression: e00dbcb — price and total read a refusal the Worker did not record (conflict, erreur interne) as « Refusé », exit 1
  it("price and total exit 2, not 1, when the server answers without recording the op", async () => {
    for (const args of [["price", "7", "2"], ["total", "2", "41,80"]]) {
      const { d, err } = deps({
        fetch: async (_u, init) => {
          const opId = JSON.parse(String(init?.body)).ops[0].opId as string;
          return new Response(JSON.stringify({ results: [{ opId, status: "refused", reason: "trop de modifications simultanées, réessayez" }], unrecorded: [opId], snapshot: null }), { headers: { "content-type": "application/json" } });
        },
      });
      expect(await run(args, d), args.join(" ")).toBe(2);
      expect(err.join("\n")).toMatch(/non définitive.*réessayez/);
      expect(err.join("\n")).not.toContain("Refusé");
    }
  });
});
