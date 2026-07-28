import esbuild from "esbuild";
import { copyFileSync, mkdirSync, cpSync, existsSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const watch = process.argv.includes("--watch");

/** Electron main process (ESM, Node). Keep node_modules external. */
const main = {
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: true,
  banner: {
    // Allow __dirname / require in the ESM main bundle.
    js: "import { createRequire } from 'module'; import { fileURLToPath } from 'url'; import { dirname } from 'path'; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);",
  },
};

/** Preload (CommonJS for contextBridge safety). */
const preload = {
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
};

/** Renderer (browser, React bundled in). */
const renderer = {
  entryPoints: ["src/renderer/main.tsx"],
  outfile: "dist/renderer.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  jsx: "automatic",
  sourcemap: true,
  loader: { ".css": "css", ".woff2": "dataurl", ".png": "dataurl" },
};

async function run() {
  if (watch) {
    for (const cfg of [main, preload, renderer]) {
      const ctx = await esbuild.context(cfg);
      await ctx.watch();
    }
    console.log("esbuild watching…");
  } else {
    await Promise.all([esbuild.build(main), esbuild.build(preload), esbuild.build(renderer)]);
  }
  copyFileSync("src/renderer/index.html", "dist/index.html");
  if (existsSync("assets")) cpSync("assets", "dist/assets", { recursive: true });
  console.log("build complete");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
