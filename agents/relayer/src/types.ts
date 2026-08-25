import type {
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";

/**
 * relayer-engine's chain ids come from its own SDK enum, which predates Hydration and cannot express
 * chain 73. Everything here is a plain number instead.
 */
export type ChainId = number;

/**
 * What the engine hands a handler.
 *
 * `StandardRelayerContext` is an intersection of the middleware contexts, so this intersects rather
 * than extends — and `vaa`, optional upstream, is always present by the time a handler runs.
 */
export type RelayerCtx = StandardRelayerContext & {
  vaa: ParsedVaa;
};

/** The parsed VAA on `ctx`, narrowed to the fields apps actually read. */
export interface ParsedVaa {
  bytes: Buffer;
  payload: Buffer;
  sequence: bigint;
  emitterChain: number;
  emitterAddress: Buffer;
  timestamp: number;
}

/** Next-middleware callback. */
export type Next = () => Promise<void> | void;

export type RelayerApp = StandardRelayerApp<StandardRelayerContext>;
