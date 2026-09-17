# Q0-ZK: A ZK Rollup on Quai Cyprus-1 with Q0 as Gas Token

## 0. Starting point (what's actually in this repo today)

`q0/` is currently a read-only analytics/swap dashboard:
- `packages/quai-service` — RPC client (`quai_call`, `quai_getBalance`), ERC20/AMM decoding helpers, hardcoded contract addresses (Q0, WQUAI, BOSS, two LP pairs).
- `apps/stats-app` — React dashboard + a `SwapModule`/`WalletPipeline` that does direct-to-pair swaps via Pelagus.

There is no rollup code, no L2 node, no prover, no bridge contract, no sequencer here. This is a from-scratch build. Given that, the plan below is scoped to be **buildable and demoable**, not a from-scratch zkEVM (that's a multi-year effort even for well-funded teams — Scroll/zkSync/Polygon each took 1.5-2+ years with dozens of engineers).

## 1. Honest framing of the goal

"100,000 L2 transactions settled using the economic equivalent of a handful of L1 transactions" is a **compression/amortization** claim, not a full-EVM-in-a-SNARK claim. It's fully achievable without writing zk circuits for the EVM, by narrowing what the L2 actually executes:

- L2 scope = **a token ledger** (transfers, mints/burns tied to the bridge, maybe simple swaps), not arbitrary Solidity contracts.
- Prove *that ledger's* state transition function (STF) in a general-purpose zkVM instead of hand-rolling zkEVM circuits.
- This keeps proving cost, code size, and audit surface small enough for one person/small team to actually ship, while still hitting the real target metric: N transactions → 1 proof → 1-3 L1 txs.

Recommend explicitly deciding this scope with the user before writing code (Q0-ledger-only L2, upgradeable later toward general EVM) — it changes the entire prover story.

## 2. Architecture (mapped onto Quai's actual constraints)

```
                 ┌───────────────────────────────────────────┐
                 │             QUAI L1 (Cyprus-1)             │
                 │                                             │
                 │  Q0RollupBridge.sol  (deposit/withdraw)     │
                 │  Q0RollupVerifier.sol (Groth16/PLONK verify)│
                 │  stateRoot storage + batch commitments      │
                 └───────────────────▲─────────────────────────┘
                                      │ submitBatch(oldRoot,newRoot,txsHash,proof)
                                      │  ← handful of L1 txs per epoch
                 ┌────────────────────┴────────────────────────┐
                 │                Q0-ZK L2                       │
                 │                                               │
                 │  Sequencer (TS/Node, extends quai-service)    │
                 │   - accepts signed L2 txs (mempool)           │
                 │   - orders them, applies STF, updates state   │
                 │                                               │
                 │  L2 State: sparse Merkle tree of accounts     │
                 │   { address, nonce, q0Balance }               │
                 │                                               │
                 │  Batcher: groups ~10k-100k txs into an epoch  │
                 │                                               │
                 │  Prover (zkVM: SP1 or RISC Zero)              │
                 │   - guest program = STF replayer              │
                 │   - input: oldRoot, tx list, sigs             │
                 │   - output: newRoot + public commitment       │
                 │   - produces a Groth16-wrapped proof          │
                 └───────────────────────────────────────────────┘
```

**Why a zkVM (SP1/RISC0) instead of custom circuits:** you write the state-transition function once in ordinary Rust (verify ed25519/secp256k1 sig, check nonce, debit/credit balances, update Merkle path), and the zkVM compiles+proves execution of that Rust program. This is the only realistic path to a working prover without a dedicated ZK circuits team. Both SP1 and RISC0 output a final Groth16 proof that's cheap to verify on-chain (~200-300k gas), which is what makes the "handful of L1 txs for 100k L2 txs" claim literal.

**Quai-specific constraints to design around** (from prior verified facts on this chain):
- Cyprus-1 is a *zone* — contract calls must target zone RPC endpoints, not a global L1 endpoint the way you'd assume on Ethereum L1.
- Tx signing on Quai omits standard r/s/v encoding in the way ethers.js/web3.js expect — must use `quais.js`, not raw ethers, for any L1 contract deploys or the bridge/verifier calls.
- The 0x00 address-shard prefix scheme applies to every new contract you deploy (bridge, verifier) — addresses must be generated/mined to land in Cyprus-1, same as the Q0 token itself.
- No native account abstraction assumptions — L2 account signatures should default to secp256k1 to match Quai's own scheme, so the bridge's identity model doesn't need translation.

## 3. Components to build, in order

1. **L2 ledger + STF spec** (`packages/l2-core`): plain TS types for L2 account state, a pure function `applyTx(state, tx) -> state'`, and a Merkle tree impl (reuse an existing audited lib, e.g. `@openzeppelin/merkle-tree`-style sparse tree — don't hand-roll the tree hashing).
2. **Sequencer service** (`packages/sequencer`): HTTP/WS endpoint accepting signed L2 txs, mempool, batch cutting on a timer or tx-count threshold, exposes L2 state via RPC for the stats-app to query. Single sequencer initially — see §5 for decentralization path.
3. **Bridge contract** (`contracts/Q0RollupBridge.sol`): deposit (lock Q0 on L1 → mint credit on L2 via sequencer watching deposit events), withdraw (burn on L2 → merkle-proof-gated claim on L1 after a challenge/finality window).
4. **Prover guest program** (Rust, SP1 or RISC0 SDK): re-implements the exact same STF as `packages/l2-core`, proves a whole batch replay from oldRoot to newRoot.
5. **Verifier contract** (`contracts/Q0RollupVerifier.sol`): SP1/RISC0 ship a generated Solidity verifier for their proof system — vendor it, wire `submitBatch` to call it, revert if invalid.
6. **Batch submitter**: takes prover output, calls `submitBatch` on L1 via `quais.js`, using Q0 (or QUAI) as gas for that single settlement tx.
7. **Demo harness**: a load generator that fires 100k signed L2 transfers at the sequencer, times batch cutting → proving → L1 settlement, and reports: total L1 gas spent vs. what 100k *direct* L1 transfers would have cost. This ratio *is* the deliverable — build it as a script + a small stats-app panel from day one, not as an afterthought.

## 4. Gas-token mechanics for Q0

Two independent design knobs, pick explicitly:
- **L1 settlement gas**: paid in QUAI natively (unavoidable — Quai's own gas token pays for `submitBatch`/verify calls). This is the "handful of L1 transactions" cost.
- **L2 tx fees**: charged in Q0 to L2 users, collected by the sequencer/protocol, used to pay the QUAI gas cost of batch settlement (and eventually prover compute cost). This is what makes "Q0 as the gas token" true at the L2 layer even though L1 gas is still QUAI — be upfront with the user that a rollup **cannot** make its own token pay Quai's L1 gas directly; it can only make Q0 the fee currency L2 users experience, subsidized/converted by the protocol.

## 5. Sequencer decentralization (matches your diagram's concern)

Ship centralized first (one sequencer key) to get the demo working — don't gate the initial proof-of-concept on solving decentralized sequencing, that's a separate hard problem (leader election, shared mempool, MEV). Path to rotate away from single-point-of-failure later:
- Add a forced-inclusion escape hatch on the bridge contract early (user can submit an L2 tx directly to L1 if the sequencer censors them) — cheap to add now, expensive to retrofit, and it's what actually removes the trust assumption even before you have multiple sequencers.
- Defer actual multi-sequencer rotation/staking until the single-sequencer + validity-proof pipeline is proven end-to-end.

## 6. Suggested build order / milestones

1. L2 ledger + STF + Merkle tree, unit tested against the existing `tests/swapModule.test.ts` conventions.
2. Sequencer with in-memory state, no proving yet — just prove out batching + the demo harness at 100k synthetic txs, measuring wall-clock and batch count.
3. Wire SP1 (recommend over RISC0 for faster Groth16 wrapping + more mature Solidity verifier tooling as of 2025) proving the STF replay for a small batch (100 txs) end-to-end, confirm on-chain verification works on Cyprus-1 testnet.
4. Scale batch size to 10k-100k txs, tune proving time/cost, confirm the L1-tx-count claim holds.
5. Bridge deposit/withdraw wired to real Q0 token contract.
6. Stats-app panel visualizing: L2 tx throughput, batches settled, L1 gas amortization ratio — this becomes the actual demo artifact.

## 7. Open decisions to confirm before coding

- Confirm zkVM choice (SP1 vs RISC0) based on whichever has smoother Quai/quais.js-compatible Solidity verifier deployment.
- Confirm L2 scope: pure token ledger only, or do you want minimal contract support (e.g. a fixed swap primitive) baked into the STF from the start?
- Confirm testnet vs mainnet Cyprus-1 for the initial deploy — recommend testnet given this is unaudited settlement logic handling real value semantics.
