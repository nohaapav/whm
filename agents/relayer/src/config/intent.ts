import { opt, optNum, req, reqAddress } from "./env";

/** Hydration's Wormhole chain id. Absent from relayer-engine's SDK, which predates the chain. */
export const HYDRATION_CHAIN = 73;

export function intentConfig() {
  return {
    /**
     * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the
     * existing queue and missed-VAA cursors. See engine/app.ts.
     */
    name: opt("INTENT_APP_NAME", "intent-relayer"),

    /** Reimbursed signing wallet, separate from the generic relayer key. */
    privateKey: req("INTENT_PRIVKEY") as `0x${string}`,

    /** WormholeTransceiver (WETH) on Hydration — publishes the settlement we subscribe to. */
    transceiver: reqAddress("NTT_TRANSCEIVER"),
    /** IntentEmitter on Hydration — publishes the forwarding instruction beside each settlement. */
    emitter: reqAddress("INTENT_EMITTER"),
    /** IntentReceiver proxy on Ethereum. */
    receiver: reqAddress("INTENT_RECEIVER"),

    ethRpc: opt("ETH_RPC", "https://eth.llamarpc.com"),
    /** Reads the source tx receipt to find the instruction the emitter published. */
    hydrationRpc: opt("HYDRATION_RPC", "https://hydration-rpc.n.dwellir.com"),

    quoterUrl: opt("QUOTER_URL", "http://localhost:8080"),
    /** Passed to the quoter so the fee reflects what processOrder actually costs. */
    gasLimit: opt("INTENT_GAS_LIMIT", "500000"),

    /** Cold-start floor; ignored once a safeSequence exists in Redis. */
    fromSequence: BigInt(opt("HYDRATION_FROM_SEQ", "0")),

    /**
     * Re-quote and retry an unprofitable order before dropping it — gas can fall within minutes, so
     * a fee currently above the user's maxRelayFee may become payable shortly. Retries ride the
     * engine's Redis-backed delayed queue, so they survive restarts. Backoff is
     * min(2^attempt * base, max): 2, 4, 8, 16, 32, 64 min. The age cap is the real terminator;
     * retries is a ceiling so nothing sticks forever.
     */
    retries: optNum("INTENT_RETRIES", 8),
    retryBaseMs: optNum("INTENT_RETRY_BASE_MS", 60_000),
    retryMaxMs: optNum("INTENT_RETRY_MAX_MS", 70 * 60_000),
    maxVaaAgeMs: optNum("INTENT_MAX_VAA_AGE_MS", 60 * 60_000),

    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    warnMultiplier: BigInt(opt("GAS_WARN_MULTIPLIER", "50")),
  };
}

export type IntentConfig = ReturnType<typeof intentConfig>;
