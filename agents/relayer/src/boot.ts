import { restoreNativeFetch } from "./fetch";
import logger from "./logger";

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
 * Run one app as the process.
 *
 * Each app is its own entry point and its own container, so there is nothing to select and no way
 * to end up running the wrong one: `dist/<app>/app.js` is the app.
 *
 * @param name App name, for the startup line.
 * @param start The app's listener. Resolves once it is live; a rejection is fatal.
 */
export function boot(name: string, start: () => Promise<void>): void {
  console.log(BANNER);
  restoreNativeFetch();
  logger.info(`Relayer starting: ${name}`);

  start().catch((err) => {
    logger.error("fatal:", err);
    process.exit(1);
  });
}
