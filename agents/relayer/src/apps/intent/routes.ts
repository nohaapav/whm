import { isAddress, type Address } from "viem";

/**
 * Mainnet addresses, from deployments/prod/intent.json.
 */
const ADDRESSES = {
  /** WormholeTransceiver (WETH) on Hydration — publishes the settlement we subscribe to. */
  transceiver: "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae",
  /** IntentEmitter on Hydration — publishes the forwarding instruction beside each settlement. */
  emitter: "0x98f1ebC9dcC8Ab7bA54D83C98500e9e313F793f2",
  /** IntentReceiver proxy on Ethereum. */
  receiver: "0x2173F6ecE25768e7EFc5199f70f8783d88Ba63c8",
};

export interface IntentRoute {
  transceiver: Address;
  emitter: Address;
  receiver: Address;
}

/**
 * The deployed intents route.
 *
 * @returns Its three addresses, validated.
 * @throws When one is still unset or malformed.
 */
export function route(): IntentRoute {
  for (const [name, value] of Object.entries(ADDRESSES)) {
    if (!isAddress(value)) {
      throw new Error(`intent ${name} is not set — fill it in apps/intent/routes.ts`);
    }
  }
  return ADDRESSES as IntentRoute;
}
