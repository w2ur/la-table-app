import { isEntry } from "../src/cli/entry.ts";

/**
 * The build watch paths of the demo's Workers Builds entry (`la-table-demo`): a push that changes none of them does not
 * rebuild the demo. `node scripts/demo-watch-paths.ts` prints them, one per line, for the dashboard. The list is
 * written here only: `scripts/demo-watch-paths.test.ts` fails when the demo build, its Vite configuration or
 * `scripts/deploy-demo.ts` reads a file none of them covers. A `dir/**` entry covers everything under `dir/`.
 */
export const DEMO_WATCH_PATHS = [
  "src/app/**",
  "src/domain/**",
  "src/cli/entry.ts",
  "data/**",
  "public/**",
  "scripts/icons.ts",
  "scripts/sw-manifest.ts",
  "scripts/deploy-demo.ts",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.base.json",
  "wrangler.demo.jsonc",
  "package.json",
  "package-lock.json",
] as const;

/** Whether a repository-relative path is under one of the watch paths. */
export function watched(path: string, paths: readonly string[] = DEMO_WATCH_PATHS): boolean {
  return paths.some((p) => (p.endsWith("/**") ? path.startsWith(p.slice(0, -2)) : path === p));
}

if (isEntry(import.meta.url)) console.log(DEMO_WATCH_PATHS.join("\n"));
