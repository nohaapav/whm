import {
  Environment,
  StandardRelayerApp,
  type StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";

import logger from "../logger";
import type { EngineConfig } from "../config";
import type { ChainId, RelayerApp } from "../types";

export interface AppOptions {
  /**
   * Engine namespace. LOAD-BEARING: every Redis key derives from it —
   *   queue          {name}:{name}-relays
   *   seen VAAs      {name}:missedVaasV3:seenVaas:{chain}:{emitter}
   *   safe sequence  {name}:missedVaasV3:safeSequence:{chain}:{emitter}
   * Changing it orphans the existing state, and the missed-VAA worker then rescans from
   * `startingSequence` — replaying a backlog or silently skipping. Never rename to tidy up.
   */
  name: string;
  /** Cold-start floor per chain. Ignored once a safeSequence exists in Redis. */
  startingSequence?: Record<ChainId, bigint>;
  /** Total attempts per VAA before the engine gives up. */
  retries?: number;
  /** Backoff between attempts: min(2^attempt * base, max). */
  backoff?: { baseMs: number; maxMs: number };
}

/**
 * Build the relayer app for one role.
 *
 * @param cfg Spy endpoint + Redis, shared by every role.
 * @param opts Namespace and retry policy for this role.
 * @returns The app, not yet listening.
 */
export function createApp(cfg: EngineConfig, opts: AppOptions): RelayerApp {
  // Namespace and floors decide what the missed-VAA worker rescans, and both are silent when wrong.
  logger.info(
    `  namespace:   ${opts.name}  floors ${JSON.stringify(opts.startingSequence ?? {}, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    )}`,
  );


  return new StandardRelayerApp<StandardRelayerContext>(Environment.MAINNET, {
    name: opts.name,
    logger,
    spyEndpoint: cfg.spyEndpoint,
    redis: cfg.redis,
    ...(opts.retries ? { workflows: { retries: opts.retries } } : {}),
    ...(opts.backoff
      ? {
          retryBackoffOptions: { baseDelayMs: opts.backoff.baseMs, maxDelayMs: opts.backoff.maxMs },
        }
      : {}),
    ...(opts.startingSequence
      ? { missedVaaOptions: { startingSequenceConfig: opts.startingSequence } }
      : {}),
  });
}

