import { chmod, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = new URL("../dist/", import.meta.url);
const outputFile = new URL("rogue.js", outputDirectory);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [new URL("../src/cli.ts", import.meta.url).pathname],
  outfile: outputFile.pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  minify: true,
  legalComments: "none",
  sourcemap: false,
  treeShaking: true,
});

await chmod(outputFile, 0o755);
