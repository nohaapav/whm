import type { wallet } from "@whm/common/evm";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

/** Source end only — the Hydration receiver and landing already exist and are TC-owned. */
export interface WalletContext {
  ethereum: EvmWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
