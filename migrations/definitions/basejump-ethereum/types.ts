import type { wallet } from "@whm/common/evm";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

/** Both ends. This corridor deploys its own receiver; only the landing is shared, and it is
 *  already TC-owned — nothing here deploys or configures it. */
export interface WalletContext {
  ethereum: EvmWallet;
  hydration: EvmWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
