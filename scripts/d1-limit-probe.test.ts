import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEASURES, verdict, type Answer } from "./d1-limit-probe";

const LIMIT = "Too many API requests by single worker invocation.";
const answers = (over: Record<string, Answer | null> = {}) => {
  const base: Record<string, Answer | null> = {
    "serial?n=50": { ok: true, done: 50 }, "serial?n=51": { ok: false, done: 50, error: LIMIT },
    "serial?n=1000": { ok: false, done: 50, error: LIMIT }, "serial?n=1001": { ok: false, done: 50, error: LIMIT },
    "batches?n=50": { ok: true, done: 50 }, "batches?n=51": { ok: false, done: 50, error: LIMIT },
    "wide?n=250": { ok: true, done: 250 },
  };
  return new Map(Object.entries({ ...base, ...over }));
};

describe("verdict", () => {
  it("passes when the limit is seen at 51 calls, a batch is one call whatever it holds, and 7 calls fit", () => {
    const v = verdict(answers());
    expect(v.exit).toBe(0);
    expect(v.limitError).toBe(LIMIT);
    expect(v.lines.at(-1)).toBe("verdict : dans le budget");
  });

  it("fails when Cloudflare counts the statements of a batch (a batch of 250 refused)", () => {
    const v = verdict(answers({ "wide?n=250": { ok: false, done: 0, error: LIMIT } }));
    expect(v.exit).toBe(1);
    expect(v.lines.at(-1)).toBe("verdict : HORS BUDGET, ne pas déployer");
  });

  it("fails when batches of one statement are counted differently from calls", () => {
    expect(verdict(answers({ "batches?n=51": { ok: true, done: 51 } })).exit).toBe(1);
  });

  it("accepts a limit of 1000 (the paid tier's) and still compares the worst request with it", () => {
    const v = verdict(answers({ "serial?n=51": { ok: true, done: 51 }, "serial?n=1000": { ok: true, done: 1000 }, "serial?n=1001": { ok: false, done: 1000, error: LIMIT }, "batches?n=51": { ok: true, done: 51 } }));
    expect(v.exit).toBe(0);
    expect(v.lines[0]).toContain("1000 appels");
  });

  // Regression: 23c3ad9 — a transient failure at call 3 of serial?n=51 was reported as a limit of 50, and its text kept as the limit's error
  it("cannot conclude (exit 2) when the failure past the limit came earlier than the limit", () => {
    const v = verdict(answers({ "serial?n=51": { ok: false, done: 3, error: "D1 unavailable" } }));
    expect(v.exit).toBe(2);
    expect(v.limitError).toBeNull();
    const batches = verdict(answers({ "batches?n=51": { ok: false, done: 3, error: "D1 unavailable" } }));
    expect(batches.exit).toBe(2);
    const paid = verdict(answers({ "serial?n=51": { ok: true, done: 51 }, "serial?n=1000": { ok: true, done: 1000 }, "serial?n=1001": { ok: false, done: 7, error: "x" } }));
    expect(paid.exit).toBe(2);
  });

  // Regression: 94db515 — a transient error on batches?n=50 or wide?n=250 was read as a measurement and gave exit 1, "HORS BUDGET"
  it("cannot conclude (exit 2) when batches?n=50 or wide?n=250 failed for a reason other than the limit", () => {
    const transient = { ok: false, done: 3, error: "D1 unavailable" };
    expect(verdict(answers({ "batches?n=50": transient })).exit).toBe(2);
    expect(verdict(answers({ "wide?n=250": transient })).exit).toBe(2);
    expect(verdict(answers({ "wide?n=250": { ok: false, done: 0, error: LIMIT } })).exit).toBe(1);
  });

  // Regression: 94db515 — batches?n=51 refused at 50 with another message than the limit's was accepted as the limit; a limit of 50 with serial?n=1000 passing was accepted too
  it("cannot conclude (exit 2) when batches?n=51 carries another error than the limit, or serial?n=1000 passes under a limit of 50", () => {
    expect(verdict(answers({ "batches?n=51": { ok: false, done: 50, error: "D1 unavailable" } })).exit).toBe(2);
    expect(verdict(answers({ "serial?n=1000": { ok: true, done: 1000 } })).exit).toBe(2);
  });

  it("cannot conclude (exit 2) when no limit was seen, or an answer is missing", () => {
    const none = Object.fromEntries(MEASURES.map(([m, n]) => [`${m}?n=${n}`, { ok: true, done: n }]));
    expect(verdict(answers(none)).exit).toBe(2);
    expect(verdict(answers({ "wide?n=250": null })).exit).toBe(2);
  });
});

describe("run as a script", () => {
  // Regression: 23c3ad9 — the entry guard compared process.argv[1] as typed, so a run through a symlink did nothing and exited 0, "dans le budget"
  it("runs (usage, exit 2) when started through a symlink, instead of exiting 0 having measured nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-link-"));
    try {
      const link = join(dir, "probe.ts");
      symlinkSync(join(process.cwd(), "scripts/d1-limit-probe.ts"), link);
      const r = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), [link], { encoding: "utf8", cwd: process.cwd() });
      expect({ status: r.status, usage: r.stderr.includes("usage :") }).toEqual({ status: 2, usage: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
