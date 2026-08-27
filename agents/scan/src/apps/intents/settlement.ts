import { oneClickPollMs } from "../../config";
import { pool } from "../../db";
import { broadcast, reconcile } from "../../flow";
import log from "../../logger";

import { pendingSettlement } from "./db";
import { orders } from "./flows";
import { getExecution, jwtConfigured, TERMINAL_STATE } from "./oneclick";

const CONCURRENCY = 5;

/**
 * The off-chain leg.
 *
 * `processed` is not the end: the contracts hand the funds to a deposit address and stop there,
 * while NEAR still has to swap and deliver. Nothing on any chain this indexes says whether that
 * happened, so the only way to know is to ask 1Click — which this does for every order still in
 * `processed`, until the answer is terminal and the order drops out of the work set.
 */
export class SettlementPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  start(): void {
    if (!jwtConfigured) {
      log.warn("[intents] ONECLICK_JWT not set — settlement polling will 401 until configured");
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), oneClickPollMs);
    log.info(`[intents] settlement poller: every ${oneClickPollMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return; // a slow round must not overlap the next
    this.busy = true;
    try {
      const rows = await pendingSettlement();
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        await Promise.all(rows.slice(i, i + CONCURRENCY).map((r) => this.poll(r)));
      }
    } catch (e) {
      log.error(`[intents] settlement tick: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async poll(r: {
    transfer_sequence: string;
    deposit_address: string;
    settlement_status: string | null;
  }): Promise<void> {
    const exec = await getExecution(r.deposit_address);
    if (!exec) return;

    const terminal = TERMINAL_STATE[exec.status];
    // An unchanged non-terminal status is not news — writing it would churn the row and the stream.
    if (!terminal && exec.status === r.settlement_status) return;

    const applied = await reconcile(
      pool,
      orders,
      orders.key.column,
      r.transfer_sequence,
      terminal ?? "processed",
      {
        settlement_status: exec.status,
        dest_address: exec.destAddress,
        dest_asset: exec.destAsset,
        dest_amount: exec.destAmount,
        dest_tx: exec.destTx,
        dest_tx_url: exec.destTxUrl,
      },
    );
    if (!applied) return;

    broadcast({
      flow: orders.name,
      kind: "updated",
      record: applied.row,
      previousState: applied.previousState,
    });
  }
}
