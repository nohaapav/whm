import { opt, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the existing
 * queue and missed-VAA cursors, and the worker then rescans from FROM_SEQUENCE. Overridable only so
 * a second deployment can run beside the live one.
 */
export const APP_NAME = opt("APP_NAME", "intent-relayer");

export const RPC_ETHEREUM = rpc("ethereum", "https://eth.llamarpc.com");
/** Read-only: the source tx receipt the forwarding instruction is found in. */
export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");

export const QUOTER_URL = opt("QUOTER_URL", "http://localhost:8080");

/** Passed to the quoter so the fee reflects what processOrder actually costs. */
export const GAS_LIMIT = "500000";

/** Cold-start floor; ignored once a safeSequence exists in Redis. */
export const FROM_SEQUENCE = { [WORMHOLE.hydration]: 0n };

/**
 * Re-quote and retry an unprofitable order before dropping it — gas can fall within minutes, so a
 * fee currently above the user's maxRelayFee may become payable shortly. Retries ride the engine's
 * Redis-backed delayed queue, so they survive restarts. Backoff is min(2^attempt * base, max):
 * 2, 4, 8, 16, 32, 64 min. The age cap is the real terminator; RETRIES is a ceiling so nothing
 * sticks forever.
 */
export const RETRIES = 8;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 70 * 60_000;
export const MAX_VAA_AGE_MS = 60 * 60_000;
