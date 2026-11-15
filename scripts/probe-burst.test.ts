import { describe, expect, it } from "vitest";
import { burstArgs, burstBaseRefusal, burstOps, burstVerdict, type BurstAnswer } from "./probe-burst";

const ok = (unrecorded: string[] = []): BurstAnswer => ({ status: 200, results: [{ opId: "a", status: "applied", reason: null }], unrecorded });

describe("burstOps", () => {
  it("is the worst request of d1-budget.ts: 100 ops, the first an undo of the buy", () => {
    const ops = burstOps("r-1", "r-buy", "2026-10-13T09:00:00Z") as { opId: string; type: string; payload: unknown }[];
    expect(ops).toHaveLength(100);
    expect(ops[0]).toEqual({ opId: "r-1-undo", type: "undo", at: "2026-10-13T09:00:00Z", payload: { targetOpId: "r-buy" } });
    expect(new Set(ops.map((o) => o.opId)).size).toBe(100);
  });
});

describe("burstVerdict", () => {
  it("passes when every request got a 200, conflicts included (they are the point)", () => {
    const v = burstVerdict([ok(), ok(["x"]), ok(["y"])]);
    expect(v.exit).toBe(0);
    expect(v.lines[1]).toContain(": 2");
  });

  it("fails on an internal error, which is how a D1 budget overrun reaches the answer", () => {
    const over: BurstAnswer = { status: 200, results: [{ opId: "a", status: "refused", reason: "erreur interne : Too many API requests by single worker invocation." }], unrecorded: ["a"] };
    const v = burstVerdict([ok(), over, over]);
    expect(v.exit).toBe(1);
    expect(v.lines).toContain("erreur interne : Too many API requests by single worker invocation.");
  });

  it("fails when a request was answered with anything but a 200", () => {
    expect(burstVerdict([ok(), { status: 302, results: [], unrecorded: [] }]).exit).toBe(1);
  });

  // Regression: 4f8b1d4 — a request that never got an answer (the fetch threw: DNS, TLS, network) was a finding (exit 1) where nothing was measured (2)
  it("is unknown (2) when a request got no answer at all, unless another one is a finding", () => {
    const unanswered = burstVerdict([ok(["x"]), null]);
    expect(unanswered.exit).toBe(2);
    expect(unanswered.lines).toContain("requêtes sans réponse (réseau, DNS, TLS) : 1, la mesure n'est pas complète");
    expect(burstVerdict([null, { status: 302, results: [], unrecorded: [] }]).exit).toBe(1);
  });

  // Regression: 82a2547 — an empty burst, or one where no request used up its three attempts, exited 0 having measured nothing
  it("is unknown (2) when nothing was sent, or when no request used up its three attempts", () => {
    const none = burstVerdict([]);
    expect(none.exit).toBe(2);
    expect(none.lines.at(-1)).toContain("rien n'a été mesuré");
    const mild = burstVerdict([ok(), ok(), ok()]);
    expect(mild.exit).toBe(2);
    expect(mild.lines.at(-1)).toContain("le pire cas n'a pas eu lieu");
  });

  it("still fails (1) on an internal error even when no request was exhausted: a finding outranks an unknown", () => {
    const over: BurstAnswer = { status: 200, results: [{ opId: "a", status: "refused", reason: "erreur interne : boom" }], unrecorded: [] };
    expect(burstVerdict([over]).exit).toBe(1);
  });
});

describe("burstArgs", () => {
  it("sends 8 by default, or the number given, with or without --local", () => {
    expect(burstArgs([])).toEqual({ parallel: 8, local: false });
    expect(burstArgs(["--local", "16"])).toEqual({ parallel: 16, local: true });
  });

  // Regression: 82a2547 — `probe:burst -- 0` wrote the setup line and the buy, sent nothing and exited 0
  it("refuses a count below 1, a non-integer, a second count or an unknown argument", () => {
    for (const argv of [["0"], ["-3"], ["2.5"], ["abc"], ["8", "16"], ["--locale"]]) expect(burstArgs(argv)).toHaveProperty("error");
  });

  // Regression: a9f674c — `probe:burst -- 800` (a typo) fired 800 worst-case writes at once at the deployed Worker and D1
  it("refuses more than 50 requests at once, and accepts 50", () => {
    for (const argv of [["51"], ["800"], ["--local", "51"]]) expect(burstArgs(argv)).toHaveProperty("error");
    expect(burstArgs(["50"])).toEqual({ parallel: 50, local: false });
  });
});

describe("burstBaseRefusal", () => {
  const BASE = "https://la-table.w2ur.workers.dev";

  it("accepts the Worker's own address, and under --local the local one", () => {
    expect(burstBaseRefusal(BASE, false, BASE)).toBeNull();
    expect(burstBaseRefusal("http://localhost:8791", true, BASE)).toBeNull();
  });

  // Regression: 15b5229 — outside --local the burst wrote to LA_TABLE_URL as given: one left at a local wrangler dev, which enforces no D1 limit, got the token and exited 0 with Cloudflare never touched
  it("outside --local, refuses any address but DEFAULT_URL exactly, and the provisional subdomain", () => {
    for (const base of ["http://localhost:8791", "https://la-table.other.workers.dev", "https://la-table.replace-me.workers.dev"]) {
      expect(burstBaseRefusal(base, false, BASE)).toContain(base);
    }
    expect(burstBaseRefusal("https://la-table.replace-me.workers.dev", false, "https://la-table.replace-me.workers.dev")).toContain("provisoire");
  });
});
