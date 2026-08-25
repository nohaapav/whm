import idl from "./emitter/idl.json";

export interface ProgramRoute {
  /** Namespaces this route's feeds in state, and prefixes them in logs. */
  label: string;
  /** oracle-emitter program id. Its feeds are discovered from the program's own accounts. */
  programId: string;
}

/**
 * Mainnet routes, from deployments/prod/oracle-relay-solana.json. The default route's id comes from
 * the synced IDL, so `pnpm sync-idl` keeps it in step with the deployed program.
 */
export const ROUTES: ProgramRoute[] = [{ label: "oracle", programId: idl.address }];
