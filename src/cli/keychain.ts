import { execFileSync } from "node:child_process";
import type { SecretReader } from "./client";

/**
 * macOS's keychain tool, by absolute path: never through PATH, whose first directory may be Node's, where `npm i -g`
 * puts every global package's bins (the deploy runs git, tar, find and ln the same way, `systemTools`).
 */
export const SECURITY_BIN = "/usr/bin/security";

/** Runs a command and returns its standard output; throws when it fails. */
export type RunCommand = (cmd: string, args: readonly string[]) => string;

const runCommand: RunCommand = (cmd, args) => execFileSync(cmd, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** A keychain reader running SECURITY_BIN through `run`; an absent entry, a locked keychain or a failed run read as null. */
export function keychainReader(run: RunCommand): SecretReader {
  return (service) => {
    try {
      const value = run(SECURITY_BIN, ["find-generic-password", "-s", service, "-w"]).trim();
      return value === "" ? null : value;
    } catch {
      return null;
    }
  };
}

/** macOS login keychain; an absent entry, a locked keychain or a non-GUI session all read as null (exit 2 upstream). */
export const readKeychain: SecretReader = keychainReader(runCommand);
