import type { wallet } from "@whm/common/evm";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

/** Both ends of the intent corridor: the emitter on Hydration, the receiver on Ethereum. */
export interface WalletContext {
  hydration: EvmWallet;
  ethereum: EvmWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
