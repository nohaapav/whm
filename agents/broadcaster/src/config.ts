/**
 * Env holds only what changes between deployments: the signing key, the RPCs, and the polling
 * knobs. What an app publishes — emitters, symbols, program ids — is a constant in its `routes.ts`.
 */

/**
 * Read a required env var.
 *
 * @param name Variable name.
 * @returns Its value.
 * @throws When unset or empty.
 */
export function req(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

/**
 * Read an optional numeric env var with a fallback.
 *
 * @param name Variable name.
 * @param fallback Value to use when unset.
 * @returns The parsed number.
 */
export function optNum(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : Number(value);
}

/**
 * Read a chain's RPC from `RPC_<CHAIN>`, matching the migrations' env convention.
 *
 * @param chain Chain name, lowercase.
 * @returns The RPC URL.
 * @throws When unset.
 */
export function rpc(chain: string): string {
  return req(`RPC_${chain.toUpperCase()}`);
}

/**
 * The process's signing key, in whatever encoding its chain uses — base58 for Solana, hex for EVM.
 * One name across every app; the app validates the encoding.
 *
 * @returns The raw key.
 * @throws When unset.
 */
export function privateKey(): string {
  return req("PRIVKEY").trim();
}
