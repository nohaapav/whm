import esbuild from "esbuild";

import { config } from "../../esbuild.config.mjs";

esbuild
  .build({
    ...config,
    bundle: true,
    /**
     * Dependencies are NOT bundled, and this is load-bearing rather than a preference.
     *
     * relayer-engine pulls @certusone/wormhole-sdk, which pulls the Injective/Cosmos SDKs. Those
     * have circular CJS requires and re-exported TS enums that esbuild cannot flatten correctly: the
     * bundle builds fine and then dies at load with `Cannot read properties of undefined (reading
     * 'Mainnet')` inside @injectivelabs/networks. Leaving packages external sidesteps the whole
     * class of problem — the Dockerfile installs them instead.
     */
    packages: "external",
    minify: false,
    sourcemap: true,
  })
  .catch(() => process.exit(1));
