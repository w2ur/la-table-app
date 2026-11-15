import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_TOKEN = "__LA_TABLE_SW_MANIFEST__";

/** What the service worker precaches: the shell at "/" and every built file but the HTML (served as "/"), the worker and maps. */
export function precacheList(files: readonly string[]): string[] {
  const urls = files.filter((f) => f !== "index.html" && f !== "sw.js" && !f.endsWith(".map")).map((f) => `/${f}`);
  return ["/", ...urls.sort()];
}

/** A version that changes whenever any served byte or file name changes, whatever order the files are listed in. */
export function swVersion(files: readonly { name: string; content: string | Uint8Array }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** Puts the manifest into the built worker in place of the quoted token; throws when the token is gone (a worker that would precache nothing). */
export function injectManifest(code: string, manifest: { version: string; urls: string[] }): string {
  const quoted = new RegExp(`(["'\`])${MANIFEST_TOKEN}\\1`);
  if (!quoted.test(code)) throw new Error("sw.js: manifest token not found");
  return code.replace(quoted, () => JSON.stringify(JSON.stringify(manifest)));
}

export function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(dir, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
    .sort();
}
