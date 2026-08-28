#!/usr/bin/env bash
# Deliver the stuck intent order by hand: NTT settlement seq 23 + its instruction seq 1,
# both on Hydration (chain 73), paired on NTT manager sequence 21.
set -euo pipefail

: "${PK:?set PK to the Ethereum signing key, 0x-prefixed}"

RECEIVER=0x2173F6ecE25768e7EFc5199f70f8783d88Ba63c8
TRANSCEIVER=0000000000000000000000008acce9ca511d5d7213f8c3f813b8916087cd00ae
EMITTER=00000000000000000000000098f1ebc9dcc8ab7ba54d83c98500e9e313f793f2
CEILING=130000000000000          # order's maxRelayFee — claim at most this
QUOTER_URL=${QUOTER_URL:-https://quoter-intent.play.hydration.cloud}
MARGIN_BPS=${MARGIN_BPS:-0}      # 0 = the modelled cost, no headroom

api() { curl -sS -m 30 "https://api.wormholescan.io/api/v1/vaas/73/$1/$2" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["vaa"])'; }

quote() { curl -sS -m 30 "$QUOTER_URL/relay-fee?chain=ethereum&marginBps=$MARGIN_BPS" \
          | python3 -c 'import json,sys; print(json.load(sys.stdin)["feeRequested"])'; }

echo "fetching VAAs..."
NTT_VAA=$(api "$TRANSCEIVER" 24)
INSTRUCTION_VAA=$(api "$EMITTER" 2)
echo "  settlement  ${#NTT_VAA} chars"
echo "  instruction ${#INSTRUCTION_VAA} chars"

# What the delivery actually costs, rather than the ceiling. FEE_REQUESTED overrides; without it a
# dead quoter stops the script rather than silently falling back to claiming the maximum.
if [[ -n "${FEE_REQUESTED:-}" ]]; then
  FEE=$FEE_REQUESTED
  echo "fee: $FEE (FEE_REQUESTED override)"
else
  echo "quoting relay fee..."
  FEE=$(quote) || { echo "quoter unreachable — set FEE_REQUESTED to deliver anyway" >&2; exit 1; }
  echo "  quoted $FEE wei (marginBps=$MARGIN_BPS)"
fi

# The contract reverts FeeExceedsCeiling above maxRelayFee, so clamp instead of failing on-chain.
if (( FEE > CEILING )); then
  echo "  clamped to ceiling $CEILING" >&2
  FEE=$CEILING
fi

cd "$(git rev-parse --show-toplevel)/contracts"
cp -f .env.ethereum .env

npx tsx scripts/intent-receiver/processOrder.ts \
  --pk "$PK" \
  --address "$RECEIVER" \
  --nttVaa "$NTT_VAA" \
  --instructionVaa "$INSTRUCTION_VAA" \
  --feeRequested "$FEE"

