import type { PublicClient } from "viem";

/**
 * Discriminated rather than a bag of optionals: viem's write params are a union of legacy and
 * EIP-1559 shapes, and spreading a half-set object satisfies neither.
 */
export type FeeOverrides =
  | { kind: "legacy"; gasPrice: bigint }
  | { kind: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/**
 * Hydration currently wants no priority fee, and some compatible RPCs do not expose
 * `eth_maxPriorityFeePerGas` at all — so fall back to zero rather than to a library default, which
 * would overpay on every submission.
 */
async function priorityFee(client: PublicClient): Promise<bigint> {
  try {
    const hex = await client.request({
      method: "eth_maxPriorityFeePerGas" as never,
      params: [] as never,
    });
    return BigInt(hex as string);
  } catch {
    return 0n;
  }
}

/**
 * Fee overrides for a Hydration submission.
 *
 * @param client Hydration public client.
 * @returns EIP-1559 fields when the chain reports a base fee, legacy `gasPrice` otherwise.
 */
export async function hydrationFees(client: PublicClient): Promise<FeeOverrides> {
  const block = await client.getBlock();

  if (!block.baseFeePerGas) {
    return { kind: "legacy", gasPrice: await client.getGasPrice() };
  }

  const maxPriorityFeePerGas = await priorityFee(client);
  return {
    kind: "eip1559",
    maxPriorityFeePerGas,
    maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas,
  };
}
