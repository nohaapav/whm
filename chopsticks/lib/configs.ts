/**
 * Chopsticks fork configs for the chains WHM spans. Endpoints mirror the
 * galacticcouncil/chopsticks presets. Feature scripts add their own
 * import-storage (funding/whitelisting) on top via Network.setStorage.
 */
export interface ChainSpec {
  key: string;
  name: string;
  /** Substrate wss endpoint(s) of the live chain to fork (first reachable wins). */
  endpoint: string | string[];
  /** Local chopsticks ws port. */
  port: number;
  /** Parachain id (used to wire HRMP / derive sovereign + MDA accounts). */
  paraId: number;
}

export const hydration: ChainSpec = {
  key: "hydration",
  name: "Hydration",
  endpoint: ["wss://rpc-catfish-1.catfish.hydration.cloud", "wss://hydration-rpc.n.dwellir.com"],
  port: 8061,
  paraId: 2034,
};

export const configs = { hydration } as const;
