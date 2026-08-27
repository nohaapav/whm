import { spawn } from "node:child_process";

import esbuild from "esbuild";

import { config } from "../../esbuild.config.mjs";
import { entryPoints, multiEntry } from "./esbuild.entries.mjs";

// `pnpm dev <domain>` — one container's worth at a time, since they are separate processes.
const domain = process.argv[2] ?? "ingest";
const entry = `${domain}/app`;
if (!entryPoints[entry]) {
  console.error(`unknown domain "${domain}" — one of ${Object.keys(entryPoints).map((e) => e.split("/")[0]).join(", ")}`);
  process.exit(1);
}

const ctx = await esbuild.context({
  ...multiEntry(config),
  entryPoints: { [entry]: entryPoints[entry] },
});
await ctx.rebuild();
await ctx.watch();

spawn("node", ["--watch", "--env-file=.env", `dist/${entry}.js`], { stdio: "inherit" });
