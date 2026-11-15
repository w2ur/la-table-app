/**
 * True only in `vite build --mode demo` (vite.config.ts `define`), false in every other build. A literal replaced at
 * build time, never read from a `.env` file: every demo branch tests it, so each build drops the other side whole
 * (src/app/demo/bundle.test.ts).
 */
declare const __LA_TABLE_DEMO__: boolean;
