#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-intent.sh <env>
#
# Deploy the intents v2 corridor, both ends, and wire them to each other.
#   Hydration : IntentEmitter  (UUPS proxy) + NttManager / receiver wiring
#   Ethereum  : IntentReceiver (UUPS proxy) + emitter pin
#
# The NEAR router is deployed separately — it derives its account from the published order terms
# and shares no address with either end.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK           Hydration deployer (0x...) — needs an EVMAccounts.ContractDeployer slot
#   PK_ETHEREUM  Ethereum deployer (0x...)
#
# Example:
#   PK=0x... PK_ETHEREUM=0x... ./sh/migrate-intent.sh fork

ENV=${1:?Usage: migrate-intent.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

# Load root .env if present (for PK overrides etc.)
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  # Default anvil dev account #0 on every fork
  ANVIL_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK=${PK:-$ANVIL_PK}
  PK_ETHEREUM=${PK_ETHEREUM:-$ANVIL_PK}
fi

PK=${PK:?Missing PK}
PK_ETHEREUM=${PK_ETHEREUM:?Missing PK_ETHEREUM}

export PK PK_ETHEREUM

"$TSX" "$RUNNER" --migration intent --env "$ENV"
