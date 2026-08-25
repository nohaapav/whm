import { opt, optNum, req, reqPrivateKey} from "./env";

/** Hydration's EVM chain id — asserted at startup so a misconfigured RPC fails loudly. */
export const HYDRATION_EVM_CHAIN_ID = 222222;

export function hydrationConfig() {
  return {
    /**
     * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the
     * existing queue and missed-VAA cursors. See engine/app.ts.
     */
    name: opt("APP_NAME", "hydration-ntt-relayer"),

    privateKey: reqPrivateKey("PRIVKEY"),
    rpc: opt("HYDRATION_RPC", "https://hydration-rpc.n.dwellir.com"),

    /** Cold-start floors per origin chain; ignored once a safeSequence exists in Redis. */
    fromSequence: {
      ethereum: BigInt(opt("NTT_ETH_FROM_SEQ", "0")),
      base: BigInt(opt("NTT_BASE_FROM_SEQ", "0")),
      solana: BigInt(opt("NTT_SOLANA_FROM_SEQ", "0")),
      sui: BigInt(opt("NTT_SUI_FROM_SEQ", "0")),
    },

    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    warnMultiplier: BigInt(opt("GAS_WARN_MULTIPLIER", "50")),
    retries: optNum("NTT_RETRIES", 8),
  };
}

export type HydrationConfig = ReturnType<typeof hydrationConfig>;
