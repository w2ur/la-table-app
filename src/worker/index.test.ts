import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const env = { DB: {} as D1Database, ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher };
const app = createApp({ verify: async () => false });

describe("routing", () => {
  it("serves static assets for non-API paths without checking auth", async () => {
    expect(await (await app.fetch(new Request("https://t/"), env)).text()).toBe("asset");
  });
  it("returns 401 before 404 for unknown API paths when unauthenticated", async () => {
    expect((await app.fetch(new Request("https://t/api/nope"), env)).status).toBe(401);
  });
});

describe("GET /api/health", () => {
  const health = (extra: Record<string, unknown>) => app.fetch(new Request("https://t/api/health"), { ...env, ...extra } as never);

  it("answers the running version's id and tag, without auth, so a probe can tell the new version from the old", async () => {
    const res = await health({ CF_VERSION_METADATA: { id: "0b7c3d4e-aaaa-bbbb-cccc-123456789abc", tag: "86225a9f00aa", timestamp: "2026-10-13T08:00:00Z" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "0b7c3d4e-aaaa-bbbb-cccc-123456789abc", tag: "86225a9f00aa" });
  });

  it("answers null for a version without metadata or without a tag (wrangler dev, a version uploaded by hand)", async () => {
    expect(await (await health({})).json()).toEqual({ ok: true, version: null, tag: null });
    expect(await (await health({ CF_VERSION_METADATA: { id: "v", tag: "", timestamp: "" } })).json()).toEqual({ ok: true, version: "v", tag: null });
  });
});
