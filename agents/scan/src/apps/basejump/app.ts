import { banner } from "../../banner";
import { drainIntervalMs } from "../../config";
import { Drain, serve, subscribe } from "../../flow";
import log from "../../logger";
import { enabled } from "../../watch";

import { routes } from "./api";
import { transfers } from "./flows";

const NAME = "basejump";
const FLOWS = [transfers];

/**
 * Basejump: the fast payout out of the Hydration landing pool, correlated back to the source that
 * paid for it. The NTT settlement replenishing the pool is `ntt_transfers`, which ingest owns.
 */
async function main(): Promise<void> {
  banner(NAME);

  const drain = new Drain(NAME, FLOWS, enabled);
  await drain.initSchema();

  subscribe((u) => {
    const id = u.record.id as string;
    if (u.kind === "created") log.info(`+ [${u.flow}] ${id} [${u.record.state}]`);
    else if (u.previousState !== u.record.state) {
      log.info(`~ [${u.flow}] ${id} [${u.previousState} -> ${u.record.state}]`);
    }
  });

  await serve({ name: NAME, flows: FLOWS, routes });
  await drain.start(drainIntervalMs);

  log.info("basejump ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
