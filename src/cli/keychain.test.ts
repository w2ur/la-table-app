import { accessSync, constants } from "node:fs";
import { describe, expect, it } from "vitest";
import { keychainReader, SECURITY_BIN, type RunCommand } from "./keychain";

describe("keychainReader", () => {
  // Regression: e02a3f4 — the keychain was read by running `security` through the caller's PATH, inside the
  // deploy's own process too, whose first directory may be Node's, where `npm i -g` puts every global bin
  it("runs /usr/bin/security by its absolute path, never a `security` found on PATH", () => {
    const ran: [string, readonly string[]][] = [];
    const run: RunCommand = (cmd, args) => { ran.push([cmd, args]); return "synthetic.secret\n"; };
    expect(keychainReader(run)("la-table-access-client-secret")).toBe("synthetic.secret");
    expect(ran).toEqual([["/usr/bin/security", ["find-generic-password", "-s", "la-table-access-client-secret", "-w"]]]);
  });

  it("reads an empty answer or a failed run as null", () => {
    expect(keychainReader(() => "\n")("x")).toBeNull();
    expect(keychainReader(() => { throw new Error("exit 44"); })("x")).toBeNull();
  });

  it.runIf(process.platform === "darwin")("names a tool this Mac can run", () => {
    expect(() => accessSync(SECURITY_BIN, constants.X_OK)).not.toThrow();
  });
});
