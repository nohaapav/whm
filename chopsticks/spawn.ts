import { configs, spawnForks, teardownForks } from "./lib";

/**
 * Spawn the Hydration chopsticks fork, then idle until Ctrl-C. Useful for poking the fork via
 * polkadot.js or pointing a feature test at the printed ws endpoint.
 */
async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);

  console.log("\n🥢 Forks ready:");
  for (const n of Object.values(nets)) {
    console.log(`   ${n.spec.name.padEnd(10)} ${n.url}`);
    console.log(`              https://polkadot.js.org/apps/?rpc=${encodeURIComponent(n.url)}`);
  }
  console.log("\nPress Ctrl-C to stop.\n");

  await new Promise<void>((resolve) => process.once("SIGINT", resolve));

  console.log("\n🥢 shutting down...");
  await teardownForks(nets);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
