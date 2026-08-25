import type { Address } from "viem";

/** Ethereum mainnet — the chain the emitters below live on. */
export const CHAIN_ID = 1;

export interface EmitterRoute {
  /** Namespaces this route's feeds in state, and prefixes them in logs. */
  label: string;
  /** OracleEmitter proxy. */
  emitter: Address;
  /** What to publish: assetId = keccak256(symbol), which needs no log scan. */
  symbols: string[];
  /** FeedRegistered scan floor, used only when `symbols` is empty. Needs an archive RPC. */
  fromBlock: bigint;
}

/**
 * Mainnet routes, from deployments/prod/oracle-relay-ethereum.json.
 */
export const ROUTES: EmitterRoute[] = [
  {
    label: "oracle",
    emitter: "0xfbf682642a6a28760e717b637f12d014bd5db4b9",
    symbols: ["WSTETH", "APYUSD"],
    fromBlock: 0n,
  },
];
