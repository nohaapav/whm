import logger from "./logger";
import { hydrationNttFeature } from "./features/hydration-ntt";
import { intentFeature } from "./features/intent";
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
 * them: the intent service is given INTENT_PRIVKEY, the NTT service PRIVKEY. Supplying both runs
 * both in one process, each on its own engine app and its own Redis namespace.
 */
function enabled(): Feature[] {
  const features: Feature[] = [];
  if (process.env.INTENT_PRIVKEY) features.push(intentFeature());
  if (process.env.PRIVKEY) features.push(hydrationNttFeature());
  return features;
}

async function main(): Promise<void> {
  console.log(BANNER);

  const features = enabled();
  if (features.length === 0) {
    throw new Error("Nothing to run: set INTENT_PRIVKEY and/or PRIVKEY.");
  }

  logger.info(`Relayer starting: ${features.map((f) => f.name).join(", ")}`);

  await Promise.all(features.map((f) => f.start()));
}

main().catch((err) => {
  logger.error("fatal:", err);
  process.exit(1);
});
