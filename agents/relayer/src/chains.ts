import { defineChain } from "viem";

/** Wormhole chain ids. relayer-engine's SDK enum predates Hydration, so these are plain numbers. */
export const WORMHOLE = {
  solana: 1,
  ethereum: 2,
  sui: 21,
  base: 30,
  hydration: 73,
} as const;

/** Hydration's EVM chain id — asserted at startup so a misconfigured RPC fails loudly. */
export const HYDRATION_EVM_CHAIN_ID = 222222;

export const hydration = defineChain({
  id: HYDRATION_EVM_CHAIN_ID,
  name: "Hydration",
  nativeCurrency: { name: "WETH", symbol: "WETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});
