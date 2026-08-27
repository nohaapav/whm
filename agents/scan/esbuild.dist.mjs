import esbuild from "esbuild";
import { writeFileSync } from "fs";

import { config } from "../../esbuild.config.mjs";
import { multiEntry } from "./esbuild.entries.mjs";

esbuild
  .build(multiEntry(config))
  .then(({ metafile }) => {
    writeFileSync("build-meta.json", JSON.stringify(metafile));
  })
  .catch(() => process.exit(1));
