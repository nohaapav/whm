import * as anchor from "@coral-xyz/anchor";

import { privateKey, rpc } from "../../config.js";

export const RPC = rpc("solana");

/**
 * The signing keypair.
 *
 * @returns The keypair the program signs with.
 * @throws When PRIVKEY is not a base58 secret key.
 */
export function signingKeypair(): anchor.web3.Keypair {
  const decoded = anchor.utils.bytes.bs58.decode(privateKey());
  return anchor.web3.Keypair.fromSecretKey(decoded);
}
