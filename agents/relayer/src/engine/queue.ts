import { formatEther, formatGwei, type Account, type Hash, type PublicClient } from "viem";

import logger from "../logger";
import type { Next } from "../types";

/** Enough gas for one submission; below this the process is out of runway and exits. */
const MIN_GAS = 1_000_000n;

const CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  222222: "hydration",
  11155111: "sepolia",
  84532: "base-sepolia",
};

export interface Task {
  /** Short identifier for logs, e.g. the manager sequence or the token. */
  label: string;
  logger: typeof logger;
  /** Hand the workflow back to the engine once the task is finished with. */
  next: Next;
  /**
   * Send the transaction. The queue owns the nonce so submissions stay strictly ordered.
   *
   * @param nonce Nonce to submit under.
   * @returns The mined transaction hash.
   */
  submit(nonce: number): Promise<Hash>;
}

export interface QueueDeps {
  publicClient: PublicClient;
  account: Account;
  /** Alert sink for low/exhausted gas. Optional — omit to log only. */
  discordWebhook?: string;
  /** Warn when the balance drops below this multiple of one submission's cost. */
  warnMultiplier?: bigint;
}

/**
 * Serialised, nonce-managed submission queue.
 *
 * The engine can hand us several VAAs at once, and a relayer wallet has one nonce — so submissions
 * run one at a time rather than racing. A task that fails for a reason that means "already done"
 * acks the workflow; "nonce too low" reloads the nonce and retries; anything else is logged and
 * acked so one bad VAA cannot wedge the queue.
 */
export function createQueue(deps: QueueDeps) {
  const { publicClient, account } = deps;
  const warnMultiplier = deps.warnMultiplier ?? 50n;

  const pending: Task[] = [];
  let nonce: number;
  let processing = false;
  let started = false;
  let lowBalanceWarned = false;
  let chainLabel: string | undefined;

  async function label(): Promise<string> {
    if (chainLabel) return chainLabel;
    const id = await publicClient.getChainId();
    chainLabel = `${CHAIN_NAMES[id] ?? "chain"} (${id})`;
    return chainLabel;
  }

  async function notifyDiscord(message: string): Promise<void> {
    if (!deps.discordWebhook) return;
    try {
      await fetch(deps.discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
    } catch (e) {
      logger.error(`Failed to send Discord notification: ${(e as Error).message}`);
    }
  }

  /** Exit rather than submit into a wallet that cannot pay — a half-sent queue is worse. */
  async function checkBalance(): Promise<void> {
    const [balance, gasPrice, chain] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getGasPrice(),
      label(),
    ]);

    const minBalance = gasPrice * MIN_GAS;
    const warnBalance = minBalance * warnMultiplier;
    const multiplier = minBalance > 0n ? Number((balance * 100n) / minBalance) / 100 : 0;
    const pct = Math.min(100, Math.round((multiplier / Number(warnMultiplier)) * 100));
    const bar = "█".repeat(Math.round((pct / 100) * 20)) + "░".repeat(20 - Math.round((pct / 100) * 20));

    const summary =
      `${chain} | \`${account.address}\` | ${multiplier.toFixed(1)}x/${warnMultiplier}x ` +
      `[${bar}] ${pct}% | ${(+formatEther(balance)).toFixed(4)} ETH @ ` +
      `${(+formatGwei(gasPrice)).toFixed(2)} gwei`;

    if (balance < minBalance) {
      const msg = `KILL out of gas | ${summary}`;
      logger.error(msg);
      if (started) await notifyDiscord(msg);
      process.exit(1);
    }

    if (balance < warnBalance) {
      if (!lowBalanceWarned) {
        const msg = `WARN low gas | ${summary}`;
        logger.warn(msg);
        await notifyDiscord(msg);
        lowBalanceWarned = true;
      }
    } else {
      lowBalanceWarned = false;
    }

    logger.info(`Gas: ${summary}`);
  }

  function isDone(text: string): boolean {
    return (
      text.includes("transfer already completed") ||
      text.includes("already been redeemed") ||
      text.includes("VAA already processed") ||
      text.includes("AlreadyRedeemed") ||
      text.includes("TransferAlreadyCompleted")
    );
  }

  async function drain(): Promise<void> {
    if (processing || pending.length === 0) return;

    processing = true;
    const task = pending.shift()!;

    try {
      const hash = await task.submit(nonce);
      task.logger.info(`${task.label} submitted in ${hash}`);
      task.logger.info(`Next nonce: ${++nonce}`);
      void task.next();
    } catch (e) {
      const text = JSON.stringify(e) + ((e as Error).message ?? "");
      if (isDone(text)) {
        task.logger.info(`${task.label} already completed`);
        void task.next();
      } else if (text.includes("nonce too low")) {
        task.logger.info("nonce too low, reloading");
        nonce = await publicClient.getTransactionCount({ address: account.address });
        pending.unshift(task);
      } else {
        task.logger.error(`${task.label}: ${(e as Error).message ?? e}`);
        void task.next();
      }
    } finally {
      processing = false;
      await checkBalance();
      void drain();
    }
  }

  return {
    /** Load the starting nonce and assert the wallet can pay. Call once before listening. */
    async init(): Promise<number> {
      await checkBalance();
      started = true;
      nonce = await publicClient.getTransactionCount({ address: account.address });
      return nonce;
    },

    add(task: Task): void {
      pending.push(task);
      void drain();
    },

    get nonce(): number {
      return nonce;
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
