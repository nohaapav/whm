#!/usr/bin/env bash
# Deliver the stuck intent order by hand: NTT settlement seq 23 + its instruction seq 1,
# both on Hydration (chain 73), paired on NTT manager sequence 21.
set -euo pipefail

: "${PK:?set PK to the Ethereum signing key, 0x-prefixed}"

RECEIVER=0x2173F6ecE25768e7EFc5199f70f8783d88Ba63c8
TRANSCEIVER=0000000000000000000000008acce9ca511d5d7213f8c3f813b8916087cd00ae
EMITTER=00000000000000000000000098f1ebc9dcc8ab7ba54d83c98500e9e313f793f2
CEILING=17049662280000          # order's maxRelayFee — claim at most this

api() { curl -sS -m 30 "https://api.wormholescan.io/api/v1/vaas/73/$1/$2" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["vaa"])'; }

echo "fetching VAAs..."
NTT_VAA=$(api "$TRANSCEIVER" 25)
INSTRUCTION_VAA=$(api "$EMITTER" 3)
echo "  settlement  ${#NTT_VAA} chars"
echo "  instruction ${#INSTRUCTION_VAA} chars"

cd "$(git rev-parse --show-toplevel)/contracts"
cp -f .env.ethereum .env

npx tsx scripts/intent-receiver/processOrder.ts \
  --pk "$PK" \
  --address "$RECEIVER" \
  --nttVaa "$NTT_VAA" \
  --instructionVaa "$INSTRUCTION_VAA" \
  --feeRequested "$CEILING"

