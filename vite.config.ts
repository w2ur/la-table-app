import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";
// with their extension: an extensionless relative import makes Vite 8 print a configLoader warning on every build
import { ICONS, pngIcon } from "./scripts/icons.ts";
import { injectManifest, listFiles, precacheList, swVersion } from "./scripts/sw-manifest.ts";

const SW_SOURCE = fileURLToPath(new URL("./src/app/sw.ts", import.meta.url));
const ICON_SVG = fileURLToPath(new URL("./public/icon.svg", import.meta.url));

/**
 * Draws the home-screen PNGs (apple-touch-icon, the manifest's icons) from public/icon.svg into the build, so they are
 * never committed: a change to the SVG is a change to every icon, and to the service worker's version.
 */
function homeScreenIcons(): Plugin {
  return {
    name: "la-table-icons",
    apply: "build",
    generateBundle() {
      const svg = readFileSync(ICON_SVG, "utf8");
      for (const { name, size } of ICONS) this.emitFile({ type: "asset", fileName: name, source: pngIcon(svg, size) });
    },
  };
}

/**
 * Builds src/app/sw.ts to dist/sw.js, then, once every file is written (public/ included), writes in the precache list
 * and a version hashed from every served byte: any change to the app gives phones a new worker to install.
 */
function serviceWorker(): Plugin {
  let outDir = "";
  return {
    name: "la-table-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      this.emitFile({ type: "chunk", id: SW_SOURCE, fileName: "sw.js" });
    },
    closeBundle() {
      const files = listFiles(outDir).filter((name) => name !== "sw.js");
      const version = swVersion(files.map((name) => ({ name, content: readFileSync(join(outDir, name)) })));
      const path = join(outDir, "sw.js");
      writeFileSync(path, injectManifest(readFileSync(path, "utf8"), { version, urls: precacheList(files) }));
    },
  };
}

/**
 * Everything follows the mode. `vite build` is the app (dist/). `vite build --mode demo` (`npm run build:demo`) is the
 * static demo (dist-demo/): `__LA_TABLE_DEMO__` true, so main.tsx answers from the in-page server and every real network
 * path drops out, and no service worker. The flag is a `define`, never a `.env` file (`.gitignore` drops those).
 */
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    root: "src/app",
    publicDir: "../../public",
    define: { __LA_TABLE_DEMO__: JSON.stringify(demo) },
    plugins: [preact(), homeScreenIcons(), ...(demo ? [] : [serviceWorker()])],
    build: {
      outDir: demo ? "../../dist-demo" : "../../dist",
      emptyOutDir: true,
      // the polyfill fetches module preloads itself: the demo keeps no call to the network in its bundle
      // and stays one script: main.tsx imports the demo dynamically (so the real bundle never holds it), and one script
      // asks the server for nothing more at boot
      ...(demo ? { modulePreload: { polyfill: false }, rolldownOptions: { output: { codeSplitting: false } } } : {}),
    },
  };
});
