import { createPublicClient, http, type Address, type PublicClient } from "viem";

import { calldataBytes, calldataGas, vaaBytes } from "../envelope";
import { GuardianQuorum } from "../guardians";
import type { ChainQuoter, GasEstimate } from "../types";

export interface EthConfig {
  rpc: string;
  wormholeCore: Address;
  /** Skip the model and price this many gas instead. Diagnostic; unset in normal operation. */
  gasLimitOverride?: bigint;
}

/** WETH, Ethereum mainnet. Accepted as a name for the native token — the settlement arrives as WETH
 *  and is unwrapped before `IntentReceiver` pays out, so the two are the same wei. */
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/** Base cost of any transaction. */
const INTRINSIC_GAS = 21_000n;

/**
 * Everything `processOrder` does once the calldata is paid for: signature verification, NTT delivery
 * through the transceiver and manager, the rate-limiter checks, the WETH unwrap, and two native
 * transfers.
 *
 * Pinned, because it is not derivable — and stable enough to pin. Measured across deliveries at
 * 555,345 four times over and 559,674 once (a cold-account touch).
 *
 * Re-pin after an `IntentReceiver` or NTT upgrade. Signature verification lives in here rather than
 * scaling with the quorum: every sample was at 13 signatures, so there is no second point to fit a
 * slope against, and claiming one would be false precision. The drift shows up for free — the
 * relayer estimates the real call for every order.
 */
const EXECUTION_GAS = 560_000n;

/** NTT transceiver message: fixed by the payload shape, not by the transfer. */
const NTT_PAYLOAD_BYTES = 217;

/** `abi.encode(uint64 sequence, address depositAddress, uint256 amount, uint256 maxRelayFee)`. */
const INSTRUCTION_PAYLOAD_BYTES = 128;

/** `processOrder(bytes nttVaa, bytes instructionVaa, uint256 feeRequested)`. */
const STATIC_ARGS = 1;

export class EthereumQuoter implements ChainQuoter {
  readonly name = "ethereum";

  private readonly client: PublicClient;
  private readonly quorum: GuardianQuorum;
  private readonly override?: bigint;

  constructor(cfg: EthConfig) {
    this.client = createPublicClient({ transport: http(cfg.rpc) });
    this.quorum = new GuardianQuorum(this.client, cfg.wormholeCore);
    this.override = cfg.gasLimitOverride;
  }

  /**
   * Gas for `IntentReceiver.processOrder`, built from the call the relayer will make.
   *
   * The `isVAAConsumed` branch is deliberately not modelled: when a generic NTT relayer already
   * delivered the settlement, `processOrder` skips `receiveMessage` and costs far less. That is
   * unknowable here — the settlement does not exist yet — so this always assumes delivery. The
   * relayer sees the truth and charges the lower amount.
   */
  async estimateGas(): Promise<GasEstimate> {
    const signatures = await this.quorum.get();
    const bytes = calldataBytes(STATIC_ARGS, [
      vaaBytes(signatures, NTT_PAYLOAD_BYTES),
      vaaBytes(signatures, INSTRUCTION_PAYLOAD_BYTES),
    ]);
    const calldata = calldataGas(bytes);

    return {
      total: this.override ?? INTRINSIC_GAS + calldata + EXECUTION_GAS,
      intrinsic: INTRINSIC_GAS,
      calldata,
      execution: EXECUTION_GAS,
      signatures,
      calldataBytes: bytes,
    };
  }

  /**
   * What the relayer actually pays per unit of gas.
   *
   * The block's base fee, not `eth_gasPrice`: `effectiveGasPrice` equalled the base fee on every
   * observed delivery — no priority tip is paid and the transaction is included anyway. Base fee
   * over the ~14 minute delivery lag is also a martingale (measured median drift 1.01×), so the
   * current value is the best point estimate and no history improves it.
   */
  async gasPrice(): Promise<bigint> {
    const block = await this.client.getBlock();
    return block.baseFeePerGas ?? (await this.client.getGasPrice());
  }

  isNative(feeAsset: string): boolean {
    return feeAsset === "native" || feeAsset.toLowerCase() === WETH;
  }
}
