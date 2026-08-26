#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-intent-quote-emitter.sh <env>
#
# Deploy IntentQuoteEmitter on Hydration — the standing authorizations a NEAR account derives
# from, published once per route rather than once per order.
#
# Moves no value and wires to nothing. Owns its Wormhole emitter address so IntentReceiver does not
# accept its messages as forwarding instructions. Record the deployed address for the NEAR router,
# which trusts it off-chain.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK      Hydration deployer (0x...) — needs an EVMAccounts.ContractDeployer slot
#
# Example:
#   PK=0x... ./sh/migrate-intent-quote-emitter.sh fork

ENV=${1:?Usage: migrate-intent-quote-emitter.sh <env (prod|fork)>}

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
  PK=${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
fi

PK=${PK:?Missing PK}

export PK

"$TSX" "$RUNNER" --migration intent-quote-emitter --env "$ENV"
