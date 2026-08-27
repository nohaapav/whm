import { OneClickService, OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";

import { oneClickJwt } from "../../config";
import log from "../../logger";

/** 1Click requires a JWT on the SDK's shared config; without it every call 401s. */
export const jwtConfigured = Boolean(oneClickJwt);
if (oneClickJwt) OpenAPI.TOKEN = oneClickJwt;

/**
 * 1Click execution status to terminal order state. The non-terminal ones — PENDING_DEPOSIT,
 * INCOMPLETE_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING — are deliberately absent, so the poller keeps
 * polling until one of these lands.
 */
export const TERMINAL_STATE: Record<string, string> = {
  SUCCESS: "settled",
  REFUNDED: "refunded",
  FAILED: "failed",
};

/**
 * Execution status plus the destination leg, recovered from the original quote. Address, asset and
 * amount are known at quote time; the destination-chain transaction only appears once 1Click
 * settles.
 */
export interface ExecutionInfo {
  status: string;
  /** Recipient on the destination chain — not the Ethereum deposit address. */
  destAddress?: string;
  /** 1Click asset id, which encodes the destination chain. */
  destAsset?: string;
  /** Settled output if available, else what was quoted. */
  destAmount?: string;
  destTx?: string;
  destTxUrl?: string;
}

/**
 * Ask 1Click where a deposit address' funds went.
 *
 * @param depositAddress The address the order forwarded to.
 * @returns Status and destination, or null on a transient error — the next round retries.
 */
export async function getExecution(depositAddress: string): Promise<ExecutionInfo | null> {
  try {
    const r = await OneClickService.getExecutionStatus(depositAddress);
    const req = r.quoteResponse?.quoteRequest;
    const destTx = r.swapDetails?.destinationChainTxHashes?.[0];
    return {
      status: String(r.status),
      destAddress: req?.recipient,
      destAsset: req?.destinationAsset,
      destAmount: r.swapDetails?.amountOut ?? r.quoteResponse?.quote?.amountOut,
      destTx: destTx?.hash,
      destTxUrl: destTx?.explorerUrl,
    };
  } catch (e) {
    log.warn(`[intents] getExecution ${depositAddress}: ${(e as Error).message}`);
    return null;
  }
}
