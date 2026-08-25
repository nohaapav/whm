import { opt, optNum, req, reqPrivateKey} from "./env";

export function oracleConfig() {
  return {
    /**
     * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the
     * existing queue and missed-VAA cursors. See engine/app.ts.
     */
    name: opt("ORACLE_APP_NAME", "oracle-relayer"),

    privateKey: reqPrivateKey("ORACLE_PRIVKEY"),
    rpc: opt("HYDRATION_RPC", "https://hydration-rpc.n.dwellir.com"),

    /** Cold-start floors per origin chain; ignored once a safeSequence exists in Redis. */
    fromSequence: {
      solana: BigInt(opt("ORACLE_SOLANA_FROM_SEQ", "0")),
      ethereum: BigInt(opt("ORACLE_ETH_FROM_SEQ", "0")),
    },

    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    warnMultiplier: BigInt(opt("GAS_WARN_MULTIPLIER", "50")),
    retries: optNum("ORACLE_RETRIES", 8),
  };
}

export type OracleConfig = ReturnType<typeof oracleConfig>;
