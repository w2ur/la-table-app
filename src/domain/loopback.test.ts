import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./loopback";

describe("isLoopbackHost", () => {
  it("names this machine as a URL's hostname spells it, and nothing else", () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1:9000", "http://[::1]:8787"]) expect(isLoopbackHost(new URL(url).hostname)).toBe(true);
    for (const host of ["localhost.evil.test", "127.0.0.1.nip.io", "::1", "127.0.0.2", "la-table.w2ur.workers.dev", ""]) expect(isLoopbackHost(host)).toBe(false);
  });
});
