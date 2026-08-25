import { isAddress, type Address } from "viem";

/**
 * Read a required env var.
 *
 * @param name Variable name.
 * @returns Its value.
 * @throws When unset or empty.
 */
export function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

/**
 * Read a required env var that must hold an EVM address.
 *
 * @param name Variable name.
 * @returns The checksummed-or-not address, validated.
 * @throws When unset or not an address.
 */
export function reqAddress(name: string): Address {
  const v = req(name);
  if (!isAddress(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}

/**
 * Read a required env var holding a secp256k1 private key.
 *
 * @param name Variable name.
 * @returns The key, 0x-prefixed.
 * @throws When unset, or not 32 bytes of hex.
 * @remarks viem requires the prefix where ethers did not, so bare-hex keys carried over from an
 *          earlier deployment are accepted and normalized rather than rejected at startup.
 */
export function reqPrivateKey(name: string): `0x${string}` {
  const raw = req(name).trim();
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} is not a 32-byte hex private key (got ${hex.length} hex chars)`);
  }
  return `0x${hex.toLowerCase()}`;
}

/**
 * Read an optional env var with a fallback.
 *
 * @param name Variable name.
 * @param fallback Value to use when unset.
 * @returns Either the set value or the fallback.
 */
export function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * Read an optional numeric env var with a fallback.
 *
 * @param name Variable name.
 * @param fallback Value to use when unset.
 * @returns The parsed number.
 */
export function optNum(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
}

/** Shared across every role: the spy stream and the Redis the engine keeps its state in. */
export function engineConfig() {
  return {
    spyEndpoint: opt("SPY_ENDPOINT", "localhost:7073"),
    redis: {
      host: opt("REDIS_HOST", "localhost"),
      port: optNum("REDIS_PORT", 6379),
    },
  };
}

export type EngineConfig = ReturnType<typeof engineConfig>;
