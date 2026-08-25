import type { Address } from "viem";

import type { ChainId } from "../../types";

/** Wormhole chain ids. relayer-engine's SDK enum predates Hydration, so these are plain numbers. */
export const CHAIN = {
  solana: 1,
  ethereum: 2,
} as const;

export interface OracleRoute {
  source: string;
  sourceChain: ChainId;
  /**
   * Origin emitter. Solana gives the oracle-emitter program id — its emitter PDA is
   * `seeds = [b"emitter"]`, which relayer-engine derives before subscribing.
   */
  sourceEmitter: string;
  /** OracleReceiver on Hydration for this source. Each source has its own deployment. */
  receiver: Address;
}

/**
 * Mainnet routes, from deployments/prod/oracle-relay-&#42;.json.
 */
export const ORACLE_ROUTES: OracleRoute[] = [
  {
    source: "solana",
    sourceChain: CHAIN.solana,
    sourceEmitter: "AN6yxTepWFFjQWbo4448bNHHQR1Je48ppTkgBEpZ1SoJ",
    receiver: "0x582e2fac5af62dc024396b5e7f549c72273a69c3",
  },
  {
    source: "ethereum",
    sourceChain: CHAIN.ethereum,
    sourceEmitter: "0xfbf682642a6a28760e717b637f12d014bd5db4b9",
    receiver: "0x6913770466fed4dbc24337cd7f1ae92af4321083",
  },
];
