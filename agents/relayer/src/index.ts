import { restoreNativeFetch } from "./fetch";
import logger from "./logger";
import { hydrationNttFeature } from "./features/hydration-ntt";
import { intentFeature } from "./features/intent";
import { oracleFeature } from "./features/oracle";
import type { Feature } from "./types";

const BANNER = String.raw`
 ██████╗ ███████╗██╗      █████╗ ██╗   ██╗███████╗██████╗
 ██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗
 ██████╔╝█████╗  ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝
 ██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗
 ██║  ██║███████╗███████╗██║  ██║   ██║   ███████╗██║  ██║
 ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
        Wormhole vaa relayer
`;

/**
 * A feature runs when its signing key is present — which is how the deployment already separates
 * them: the intent service is given INTENT_PRIVKEY, the NTT service PRIVKEY, the oracle service
 * ORACLE_PRIVKEY. Supplying several runs them in one process, each on its own engine app and its
 * own Redis namespace.
 */
function enabled(): Feature[] {
  const features: Feature[] = [];
  if (process.env.INTENT_PRIVKEY) features.push(intentFeature());
  if (process.env.PRIVKEY) features.push(hydrationNttFeature());
  if (process.env.ORACLE_PRIVKEY) features.push(oracleFeature());
  return features;
}

async function main(): Promise<void> {
  console.log(BANNER);
  restoreNativeFetch();

  const features = enabled();
  if (features.length === 0) {
    throw new Error("Nothing to run: set INTENT_PRIVKEY, PRIVKEY and/or ORACLE_PRIVKEY.");
  }

  logger.info(`Relayer starting: ${features.map((f) => f.name).join(", ")}`);

  await Promise.all(features.map((f) => f.start()));
}

main().catch((err) => {
  logger.error("fatal:", err);
  process.exit(1);
});
