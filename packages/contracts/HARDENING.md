# Hardening: Slither + Foundry

Static analysis and property-based testing for the Circleswap contracts (`Qrb`, `QrbArtifactNFT`,
`CircleswapMasterChef`, and the AMM: factory, pair, router). They sit beside the Hardhat suite and do not replace it:
Hardhat pins behaviour with scenarios, Foundry attacks it with random inputs and random call sequences.

## Running it

```bash
pnpm --filter contracts test            # Hardhat scenarios (405)
pnpm --filter contracts test:forge      # Foundry fuzz + invariants, ~40 s
pnpm --filter contracts test:forge:deep # 20,000 fuzz runs, 1,024 x 200 invariant runs, ~14 min
pnpm --filter contracts slither         # needs slither on PATH (pip install slither-analyzer) and solc-select
```

Expected: all green, Slither `0 result(s) found`. Slither is configured in `slither.config.json` (runs through Hardhat,
ignores `node_modules`, `lib`, `mocks`, `test`). Foundry is configured in `foundry.toml` with the same compiler
settings as `hardhat.config.ts` (0.8.24, cancun, via-IR, 200 runs) so the tests exercise the code that ships.
`lib/forge-std` is vendored (v1.9.7, no git submodule because this package is not its own repo).

## What the Foundry suites defend

| Suite | Properties |
|---|---|
| `AmmFuzz` | k never falls on any swap (exact-in and exact-out); the trader gets exactly the quote; round-trip swaps and liquidity add/remove never profit; first-depositor inflation attacks (single and many victims) are unprofitable; multi-hop and native paths leave nothing in the router and refund exactly; flash swaps must repay principal + 0.3%; clone pools initialise once, the implementation is locked, permits bind to the clone and cannot cross pools; factory ownership is two-step |
| `AmmInvariant` | over random add/remove/swap/multi-hop/donate/skim/sync/fee-toggle sequences on three pools: pools are solvent, the router holds nothing, the locked minimum liquidity never moves and reserves never reach zero, LP shares and every token are fully accounted for |
| `MasterChefInvariant` | over random deposit/withdraw/harvest/emergency/rate/allocation/pause/boost sequences, with reward tokens also staked as principal: principal is always backed, per-pool and per-token stake totals tie out, nothing is paid beyond emission + capped boost, and every staker can always take exactly their principal back |
| `MasterChefBehavior` | boost capped at +100% whatever the source reports; a reverting boost source cannot block a harvest; shortfalls are recorded and paid after a refill; the carried-forward amount is not boosted twice; a single-asset pool never pays from principal; proportional split and full distribution; allocation changes never rewrite earned history |
| `MasterChefPrecision` | how much of the configured emission actually reaches stakers (see finding 1) |
| `Qrb` | a flash-borrowed balance never boosts; boost starts exactly at maturity; a dip resets the clock, a top-up does not, a stranger cannot touch it; an independent ghost model of holding history agrees with `boostBpsOf` over random transfers, burns and time jumps; `ArweaveURI` and `QrbFormat` are total and round-trip |

These tests were themselves attacked: 14 injected bugs (wrong fee, weak k check, locked liquidity of 1, principal paid as
rewards, unbacked emergency exit, old precision, uncapped boost, forfeited shortfall, boost on carried-forward amounts,
history rewrite, unlocked pair implementation, missing refund, boost clock not resetting, boost one second early) were
applied to a scratch copy, and every one is caught. Three initially survived and led to the tests above being sharpened.

## Findings

### 1. Reward precision loss in `CircleswapMasterChef` (fixed)

The per-share accumulator was scaled by `1e12` and floored on every pool update. Whenever the staked supply was large
relative to the emission earned between updates, most of the emission was floored away and stayed in the contract,
never reaching anyone. Measured before the fix (`MasterChefPrecision`): 3 billion LP tokens staked at 0.001 token/s,
pool touched every 5 s: **40 % of the emission lost**; the fuzzer also found a case where a lone staker earned **nothing**.
Low-decimal reward tokens would have been worse.

Fix: `ACC_PRECISION = 1e24`, and the accrual is one full-precision `Math.mulDiv` in a single `_accrued` helper (it was
duplicated in `pendingRewards` and `updatePool`, with a division before the multiplication). Loss is now 0 bps in those
cases, and the 405 Hardhat tests still pass. Overflow headroom: reward x `ACC_PRECISION` stays below 1e70 even at
`MAX_EMISSION_PER_SECOND`.

### 2. Checks-effects-interactions in `CircleswapFactory.createPair` (hardening)

The pool was recorded after `initialize` was called. Safe today (the callee is a fresh clone of the factory's own locked
implementation) but now reordered, so nothing reached from `initialize` can see a factory that does not know the pool.

### 3. Slither

66 findings at the start, 0 now. The two real ones are fixed (1 above precision, 2 above ordering). The rest were
intended behaviour and are suppressed in place with `// slither-disable-next-line <detector> -- <reason>` so that a
future finding stands out: flash-swap callback (`nonReentrant`, k re-checked), UQ112x112 TWAP maths, sentinel `== 0`
checks, interface probes in constructors, one external call per hop in the router. `timestamp` and `naming-convention`
are switched off in the config: time is the mechanism of the TWAP, emission and boost maturity (comparisons span
seconds to days), and the naming hits are V2 ABI compatibility (`WETH`) and EIP-style constants.

## Residual risks (not bugs, but read them)

- **First-depositor share inflation is bounded, not eliminated.** The locked `MINIMUM_LIQUIDITY` makes the attack lose money
  for a small seed, which is what the tests pin (with a minimum of 1 the same sequence nets the attacker about +52 % of the
  donation). My back-of-envelope analysis says a larger seed with proportionally more victims, each depositing about two
  shares' worth, can still pay; I did not confirm that by test (the experiment was too slow to finish), so treat it as
  unverified. The router has no minimum-shares argument (it keeps the V2 ABI), so a frontend should warn before anyone adds
  liquidity to a pool that is new, tiny, or whose share price is far above 1e-18 of a token.
- **`massUpdatePools` is unbounded.** `addPool`, `setPool` and `setEmissionRates` (owner only) loop over every pool. Users
  are unaffected (they touch one pool), but enough pools would stop the owner changing rates or allocations. Keep the pool
  count small, or add a cap before deploying if many farms are planned.
- **Boost is still rentable for a day** and applies retroactively at harvest (documented in `DEPLOY.md`); the tests prove it
  cannot be borrowed for a single transaction, not that it cannot be rented.
- **Unsupported tokens stay unsupported**: fee-on-transfer and rebasing tokens break pool and farm accounting by design.
- Fuzz and invariant testing shows the absence of counterexamples over the explored space. It is not a proof and not an audit.

## Gotchas when extending these tests

- **`via_ir` re-reads `block.timestamp` after `vm.warp`.** Take the start time with `vm.getBlockTimestamp()`, not a cached
  `block.timestamp`, or a loop that warps will drift.
- **`vm.prank` applies to the very next external call**, including a view like `farm.poolLength()` evaluated as an argument.
  Compute arguments first, then prank.
- `fail_on_revert = true` is on for invariants: a handler that reverts is a handler bug. Expected refusals (dust,
  `BalanceOverflow`) are whitelisted by selector in `AmmHandler._expected`; anything else fails the campaign.
- Stack-too-deep under via-IR in handlers: split into helpers instead of adding locals.
- `hardhat coverage` rewrites `artifacts/`; run Slither before coverage, or run `hardhat compile --force` after.
