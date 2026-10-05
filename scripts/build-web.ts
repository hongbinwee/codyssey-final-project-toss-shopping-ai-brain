import { build } from "esbuild";

await build({
  entryPoints: ["src/web/app.tsx"],
  bundle: true,
  outfile: "web/app.js",
  jsx: "automatic",
  format: "esm",
  logLevel: "info",
});
