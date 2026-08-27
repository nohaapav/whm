#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump-ethereum.sh <env> [runner flags...]
#
# Run the basejump-ethereum migration — both ends of the direct Ethereum -> Hydration
# corridor (USDC). Deploys and wires BasejumpEmitter on Ethereum and this corridor's own
# BasejumpReceiver on Hydration. The landing is shared and already exists (see basejump-base).
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK_ETHEREUM   Ethereum deployer (0x...)
#   PK_HYDRATION  Hydration deployer (0x...), needs an EVMAccounts.ContractDeployer slot
#
# Example:
#   PK_ETHEREUM=0x... PK_HYDRATION=0x... ./sh/migrate-basejump-ethereum.sh prod

ENV=${1:?Usage: migrate-basejump-ethereum.sh <env (prod|fork)>}
shift

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
  PK_ETHEREUM=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK_HYDRATION=$PK_ETHEREUM
fi

PK_ETHEREUM=${PK_ETHEREUM:?Missing PK_ETHEREUM}
PK_HYDRATION=${PK_HYDRATION:?Missing PK_HYDRATION}

export PK_ETHEREUM PK_HYDRATION

"$TSX" "$RUNNER" --migration basejump-ethereum --env "$ENV" "$@"
