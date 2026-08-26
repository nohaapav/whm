# PSM queue: fix exploration for the cancelled-slot walk

Scratch variants and tests exploring fixes for the queue graveyard reported in
`test/psm/unit/QueueGraveyardTest.sol` (Yash Sharma). Nothing here is proposed
for `src/`. It exists so the options can be run rather than argued about.

The reported defect: `cancelQueuedRedemption` zeroes a queue slot but leaves it
in place, and `_advanceHead` walks every dead slot in one unbounded loop. A
large contiguous run of cancelled slots makes the single call that must cross
them exceed the block gas limit, and `claim`, `drain` and
`cancelQueuedRedemption` all call `_advanceHead` first.

Run everything:

    forge test --match-path "test/psm/rv/*"

## The option worth considering

`RvVaultRuns.sol` indexes contiguous runs of cancelled slots in two mappings
(`skipTo[runStart] = end + 1`, `runStart[runEnd] = start`), merging each new
hole with its neighbours in O(1). A walk becomes one hop per run instead of one
per slot.

- `RvRuns.t.sol::RvRunsBrick` crosses the same 185,000 slot graveyard that
  bricks the current contract.
- `RvRuns.t.sol::RvRunsFuzz` compares `queueHeadEntry()` against a brute force
  scan over fuzzed cancel and settle sequences. `_liveHead` caps itself at two
  hops and reverts `RUN INDEX BROKEN` past that, so a stale index fails loudly
  instead of silently returning the wrong head.
- Only `cancelQueuedRedemption` writes the index. Deposit, enqueue and settle
  are untouched, and the `Credit` struct and ABI do not change.

The property that matters: `amount == 0` stays the ground truth and the index is
a cache over it, so an index bug degrades to a slow walk rather than corrupting
`totalOwed`.

Mutation check: delete the left merge in `_retire` and `RvRunsFuzz` goes red on
run 0. `RvRunsBrick` still passes while broken, so the fuzz is the detector, not
the brick test.

## The option that does not work

`RvVaultLL.sol` makes the queue a linked list over live slots, splicing a
cancelled slot out in O(1) using a caller supplied `prev` hint validated as
`queue[prev].next == index`.

That check accepts a dead `prev`, because a spliced out node keeps its stale
`next`. The splice then writes into a node nobody traverses and the cancelled
credit stays reachable from its live predecessor. `_settle` later runs on a
zeroed slot whose `gross` is still stored and re-applies `totalOwed -= gross`.

`RvLinkedListHint.t.sol`:

- `test_honestRaceLeavesADeadNodeInTheLiveList` reaches the broken state with
  two honest users cancelling in the same block, no attacker.
- `test_deadNodeInListDoubleSubtractsTotalOwedAndBricksPayment` underflows, so
  `drain` and `claim` revert permanently with no admin lever.
- `test_deadNodeInListSilentlyUnderstatesLiabilities` takes the smaller `gross`
  branch instead: no revert, and `sweepable()` grows by money that is still
  backing a live credit.
- `test_attackerCanManufactureItWithTwoOwnCredits` does it deliberately, for the
  cost of two credits.

Requiring `prev` to be live fixes correctness but leaves the hint front
runnable: an attacker cancels the node you named as `prev` and your cancel
reverts, on precisely the function that has to work during a stall.
