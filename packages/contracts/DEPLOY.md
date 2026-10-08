# Deploying Circleswap (Qrb, NFT, farm, AMM) to Quai Cyprus-1

Everything here is run by you, with your keys. Nothing is sent unless you pass `--broadcast`, and the
signing key is read only from an environment variable and never printed or stored.

## 1. Put the artwork on Arweave (permanent, public, irreversible)

The contracts validate on-chain that the artwork URI is an Arweave URI and cannot change it afterwards, so
upload first. Two ways; the second keeps your wallet key out of this repo entirely.

**A. Script** (needs an Arweave keyfile and Turbo credits):

```bash
pnpm --filter contracts upload:artwork -- --dry-run     # hash + Turbo price, spends nothing
ARWEAVE_KEY_FILE=path/to/arweave-wallet.json pnpm --filter contracts upload:artwork
```

The keyfile must belong to a wallet holding Turbo credits (https://turbo.ardrive.io). The upload id is written
to `deployments/artwork.json` *before* the gateway check, so a slow gateway never loses it; the file is then
checked back byte for byte. **Do not keep the keyfile inside this repo** (the package `.gitignore` blocks common
names, but it cannot know every name). The script's dependency tree (`@ardrive/turbo-sdk`) carries advisories in
signer code paths an Arweave-keyfile upload does not use; see "Dependency audit" below.

**B. Web upload** (no key file, no extra dependency): upload `apps/stats-app/public/QgoGIF.gif` with the Turbo
web app or ArDrive using your browser wallet, then pass the resulting `https://arweave.net/<txid>` to the deploy
script with `--artwork-uri`. The deploy script fetches it and refuses to continue unless it serves the exact
bytes of the local file.

## 2. Dry-run the deployment

```bash
pnpm --filter contracts compile
pnpm --filter contracts deploy:quai -- --from <any Cyprus-1 address> --farm
```

This simulates the constructors against the live node and prints the maximum cost (gas limit x gas price; unused
gas is refunded). Notes on the figures:

- The NFT constructor needs a real Qrb to talk to, and none exists before you deploy one, so a dry run
  **projects** the NFT's cost from its size and labels it. When you broadcast, every constructor is simulated
  against the actually deployed Qrb immediately before it is sent, and nothing is sent if that simulation fails.
- Quai charges creation gas well above the simulator's estimate, so the limit is 3x the estimate and the script
  refuses to start unless the deployer can cover it.
- The cost moves with the gas price. On 2026-09-21 the maximum for all three was about **1,136 QUAI**. Real
  spend is what is actually used, which is lower.

## 3. Deploy

```bash
QUAI_PRIVATE_KEY=0x... pnpm --filter contracts deploy:quai -- --broadcast --farm --mint-to <address>
```

`--farm` also needs `REWARD_A_PER_SECOND` and `REWARD_B_PER_SECOND` (wei of BDELTA / Q0 per second). Pools are
added in registry order so pool ids match the app (`--no-pools` skips that). Farm only, against an existing Qrb:
`--farm --qrb <address>`.

Guarantees, per contract:

- The address is read off that contract's own transaction receipt: the full 20 bytes, checked to be a Cyprus-1
  Quai address. It is never derived from sender and nonce (Quai grinds contract addresses).
- The script grinds the salt itself and refuses to send a creation whose address would fall outside Cyprus-1.
- Code at that address must exist and match the compiled runtime's size.
- State is read back: owner, artwork URI, royalty, wiring between contracts, farm rates and pools.
- The Qrb's `BOOST_BPS`, `BOOST_THRESHOLD` and `BOOST_MATURITY` must equal the app's constants
  (`packages/quai-service/src/registries/qrb.ts`), or the deploy stops.
- Every constructor is simulated right before it is sent, so a doomed deployment costs nothing.

### If it stops half-way

Progress is saved to `deployments/<network>.progress.json` after every step, and the error message says so. Fix
the cause and re-run the **same command with `--resume`**: contracts already deployed are re-verified and reused,
pools already added and tokens already minted are skipped, so nothing is repeated. Starting a fresh `--broadcast`
while that file exists is refused. A second Qrb is also refused while `deployed.ts` lists one
(`--force-redeploy` overrides).

On success the script writes `deployments/cyprus1.json`, regenerates
`packages/quai-service/src/registries/deployed.ts` (only plain addresses and an Arweave URI can be written), and
removes the progress file. Rebuild `quai-service` and the app to pick the addresses up.

## 4. After deploying

- **Fund the farm.** It pays rewards only from its own BDELTA / Q0 balance, and never from depositors'
  principal. Boosted holders are paid on top of emissions, so fund for about 1.5x the base emission. If the farm
  runs short, what it could not pay stays owed to each user and is paid first after you refill it.
- Consider `renounceOwnership` on Qrb and the NFT once minted; after the mint they have no owner power except
  handing over ownership. The farm's owner can add pools, change allocations (within limits), change emission
  rates (capped) and pause deposits and harvests; it can never touch depositors' stake, and withdrawals and
  `emergencyWithdraw` work while paused. Consider a multisig as the farm owner.

## Circleswap AMM (timelock + factory + router)

Circleswap has its own automated market maker, so pools no longer have to live on Quaiswap or Quainance. It is a
separate deployment from Qrb, the NFT and the farm: run it once, in any order relative to them.

What you get (`contracts/amm`): a **timelock** that owns everything, an upgradable **factory** that creates pools, an
upgradable **router** that adds and removes liquidity and swaps (any path, native QUAI through WQUAI), and one **pool**
contract per pair that **is** its own LP token (`CSLP`, a standard ERC-20 with permit). It is a constant-product pool with
a 0.3% fee that stays in the pool, and it has the Uniswap-V2 function set and argument order, so wallets and the app's
encoders work unchanged.

### Who can change what

| | |
|---|---|
| **Owner of the factory and router** | the timelock, never a person. The deployer keeps no role, no key, no ownership. |
| **Every owner action** (an upgrade, the protocol fee, freezing pools, rotating keys) | is queued on the timelock, public for the whole delay (1 to 30 days, you choose), then runs. The proposer (and any guardian) can cancel it in that time. Anyone can run it once it is ready (unless you closed execution). |
| **Pool code** | every pool is a small proxy that follows one beacon, and the beacon is owned by the *factory*. Only the timelock can change the pool code, and only after the delay. `freezePairUpgrades` renounces the beacon: from then on the code of every existing pool is fixed forever, **including against a future factory upgrade**. |
| **Withdrawals** | a pool's `mint` and `burn` never depend on the factory: its one factory read (`feeTo`) is gas-capped and fails safe, so even a hostile factory upgrade cannot lock liquidity providers in. |
| **The router** | holds users' token approvals, so its upgrades are the sensitive ones. They are public for the whole delay, and the router can be made permanent (`make-router-permanent`). |
| **Proposer** | may queue and cancel. Use a multisig. |
| **Guardian** (optional) | may cancel only: a second key against a compromised proposer. It can also cancel legitimate changes, so name one only if you trust it. |

What the owner can still do, stated plainly: switch on the protocol fee (one sixth of the 0.3% fee, 0.05% of volume, as LP
shares to an address of its choosing), and, until you freeze them, upgrade the pool code (public, delayed, cancellable) or
upgrade the router (same). It can never move anyone's tokens directly, and there is no pause button, by design.

### Deploying it

Both the browser (Deploy page, step 3) and the command line run the **same plan** and the **same launch checks**:

```bash
pnpm --filter contracts compile
pnpm --filter contracts export:artifacts          # the browser deploys these bytes; the CLI refuses to start if they are stale
pnpm --filter contracts probe:amm                 # read-only: simulates the WHOLE deployment on the live node, no key, no funds
pnpm --filter contracts deploy:quai -- --amm --from <any Cyprus-1 address> --proposer <multisig> --delay-days 3   # dry run
QUAI_PRIVATE_KEY=0x... pnpm --filter contracts deploy:quai -- --amm --proposer <multisig> --delay-days 3 --broadcast
```

Options: `--proposer <addr>` (required to broadcast; the account, ideally a multisig, that may queue and cancel),
`--delay-days <1..30>` (required on mainnet: it is how long every change is public, so it should be chosen, not
defaulted), `--guardians <a,b>` (may cancel, nothing else), `--closed-execution` (only the proposer may run a ready
operation; default: anyone), `--wquai <addr>` and `--probe-tokens <a,b>` (default: the registry's WQUAI and Q0/WQUAI),
`--resume` after an interruption, `--force-redeploy` if `deployed.ts` already lists an AMM factory (a second one splits
liquidity, so it is refused by default; the modal asks for a tick box).

**The launch rules.** On a mainnet broadcast the deploy is refused unless: the proposer is a contract (a multisig) and
not the deploying key; the delay is at least 2 days; WQUAI is the one in the app's token registry, has code and 18
decimals. Each can be overridden on purpose (`--allow-account-proposer`, `--allow-short-delay`,
`--allow-custom-wquai`; a tick box in the modal), so a deliberate choice is possible and a slip is not. The same rules
(one shared implementation) gate the modal.

What the deploy does, in order, each step read back from the chain before the next is built on it:

1. **Timelock** (delay, proposer, optional guardians, open execution). Checked: delay, who holds which role, that the proposer
   is not the admin and the timelock administers itself, that a guardian can cancel and cannot propose.
2. **Factory implementation** (locked: `initialize` on it reverts).
3. **Factory proxy**, initialised with the timelock as owner **in the creation transaction**, so there is no window in which
   anyone else could initialise it. Its `initialize` creates the pool implementation and the pool beacon. Checked: owner is
   the timelock, the beacon is owned by the factory and not yet frozen, the pool implementation is locked.
4. **Router implementation** (locked).
5. **Router proxy**, initialised the same way. Checked: owner, factory, WQUAI. Then a static `createPair` for Q0/WQUAI
   (nothing is created) must return a Cyprus-1 address: the proof that pools land where the app can reach them.

Then the finished system is handed to the integrity inspector (below), and the deploy fails if it reads `UNSAFE`.

Guarantees, on top of the ones above (addresses from receipts, Cyprus-1 check, dry run by default):

- **Exact code, not just length.** After every step, and in the inspector, the code on chain must hash to the compiled
  contract's code hash (immutables zeroed, metadata trailer dropped, so it is the same wherever it was built). A contract
  padded to the right length does not pass. The hashes are generated beside the bytecode (`export:artifacts`).
- **A transaction is written down the moment it is sent** (`deployments/<network>.amm.progress.json`), before waiting for
  it. If the run dies while waiting, `--resume` settles *that* transaction instead of paying for a second copy. Resuming
  re-verifies every finished step against the chain and refuses if the settings (proposer, delay, guardians, WQUAI) differ.
- **Funds before the first transaction**: the deploy works out the peak balance it needs (a step's whole gas limit plus
  what the earlier steps plausibly used), and refuses to start without it (`--allow-underfunded` starts anyway; every
  step still checks its own funds and a stopped run resumes). Gas limits are also checked against the block gas limit.
- A pool's address is only ever read from `factory.getPair`. Nothing computes it, because Quai grinds contract addresses.

On success it writes `deployments/<network>.amm.json` (the governance settings, every address, each transaction hash,
the constructor arguments for source verification, and the integrity report) and, on Cyprus-1, regenerates
`deployed.ts` with the factory and router. **Commit `deployed.ts`**: until you do, the AMM lives only in the browser that
deployed it, and visitors will not see it.

### What it costs

Measured on a dry run against Cyprus-1 on 2026-10-05, at 29,200 gwei-equivalent (the price moves; re-run the dry run):

| step | simulated gas | gas limit | at most |
|---|---|---|---|
| timelock | 1.8M | 5.4M | 164 QUAI |
| factory implementation | 5.5M | 16.4M | 494 QUAI |
| factory proxy (creates the pool implementation and beacon) | ~3.9M (projected) | 11.8M | 352 QUAI |
| router implementation | 3.3M | 10.0M | 300 QUAI |
| router proxy | ~0.6M (projected) | 1.8M | 54 QUAI |
| **total, every limit used in full** | | | **about 1,365 QUAI** |

The limit of a creation is the larger of 3x the simulator's figure and a floor from the code it deposits (see
`quai-service/src/deploy/gas.ts`), because **the simulator is not a reliable guide to what a creation costs on Quai, and it errs
in both directions**: a 16.9 KB contract once used 2.5x its simulated gas; a 19.3 KB one a month later used 4.6M gas where the same
bytecode simulates to 10.8M today. Unused gas is refunded, but a transaction that runs out of gas or reverts uses its whole
limit, so the cheap mistake is a generous limit. Expect to pay a fraction of the maximum, and hold the peak (the tools print
it). The two proxies cannot be simulated before the contract they point at exists, so they are projected, labelled so, and
simulated exactly right before each is sent. Creating each **pool** later is a contract creation too, and costs more than a swap.

### After the AMM is live

```bash
pnpm --filter contracts governance -- status                 # re-reads everything from the chain; exits 2 if the verdict is UNSAFE
pnpm --filter contracts governance -- pending --exit-code    # what is queued on the timelock; exits 3 while an upgrade that can reach funds waits
pnpm --filter contracts governance -- propose freeze-pools   # prints the transaction for the proposer (a multisig) to submit
```

The same tools are in the app: **Deploy page, step 6, "Governance & integrity"** (integrity verdict, every pending change in
plain language with execute and cancel, a form to queue changes, and a "where this stands" checklist). Nothing is ever
sent without the proposer's own wallet or key. Other kinds for `propose`: `set-fee-to <addr|none>`, `upgrade-pools <impl>`,
`new-pool-version <beacon>`, `upgrade-router <impl>`, `upgrade-factory <impl>`, `make-router-permanent`,
`make-factory-permanent`, `update-delay <days>`, `grant-role <proposer|canceller|executor> <addr>`, `revoke-role <role> <addr>`
(rotating a key is two delayed steps: grant the new one, then revoke the old one). To execute, run `execute <operation id>`
once it is ready; the salt printed when you queued it is needed (kept in the app's storage when queued from the app).

The inspector's verdicts: **`GOVERNED`** (every upgrade is public and delayed; pool code can still change after the delay),
**`IMMUTABLE_POOLS`** (the pool beacon is frozen, so existing pools can never change; factory and router upgrades, if any are still
possible, are public and delayed), **`UNSAFE`** (something lets a person change code that holds or routes funds at once, or
the deployment is not what it claims: an owner that is an ordinary account, a router or beacon owned by a person, code that is
not the compiled contract, an unlocked implementation). The factory and the router are judged separately: a router owned by a
person is unsafe however well the factory is governed.

The lifecycle, in the order to do it:

1. Deploy, run `status`, commit `deployed.ts`, rebuild, publish `deployments/cyprus1.amm.json`.
2. Create the first pools, **seeded at the market ratio** with real liquidity: the first deposit sets the price and locks 1,000
   units of LP tokens forever. Make a small swap and a small withdrawal yourself first.
3. When the pool code is final, queue **freeze-pools**. Irreversible; it also means a bug in the pool code could never be
   fixed in those pools (a fixed pool version can still ship for new pools: `new-pool-version`).
4. Optionally queue **make-router-permanent**, and **make-factory-permanent**. After those the system has no owner at all.

### Before you broadcast on mainnet

- [ ] `pnpm --filter contracts compile && export:artifacts` and every suite green (see "Tests" below); Slither clean.
- [ ] `probe:amm` prints PASS against the live node.
- [ ] Dry run with the real proposer, guardians and delay; read the plan it prints.
- [ ] The proposer is a multisig **you can sign from**. A mistyped address is safe (nobody can attack through it) but
      permanent: nobody could ever queue a change. Prove you can submit a transaction from it first.
- [ ] A delay you can live with: it is also how long a bug fix waits. Two days is the least that is sensible, several is safer.
- [ ] The deployer holds the peak balance the tool prints; the key is only in the environment for the run.
- [ ] After: `status` reads GOVERNED, `deployed.ts` committed, the app rebuilt and `Re-verify on chain` green on the Deploy page.
- [ ] Source verified on an explorer: `pnpm --filter contracts verify:bundle` writes `deployments/verification/<network>/` (the
      compiler's standard-JSON input, and for each of the seven contracts its address, contract name, constructor arguments and
      settings, plus a README); you upload those to the explorer. quaiscan.io has verified Circleswap-style contracts;
      explorer.qu.ai can report a bytecode mismatch because immutables differ from a naive recompile, and the last 4 bytes of a
      creation transaction's input are a salt, not an argument.
- [ ] Monitoring: `governance -- status` and `governance -- pending --exit-code` on a schedule, wired to an alert.

Things to know before you rely on it:

- **New and not independently audited.** `SECURITY_AUDIT.md` is an internal, AI-assisted review, **not** an external audit. It has a 43-test pool
  suite, 38 router tests, factory, governance, upgrade and deployment suites, a randomised property test (invariants after
  hundreds of random operations), Foundry fuzz and invariant campaigns, a hostile-owner campaign, Slither, an append-only
  storage-layout guard, and a test that holds the app's client-side maths to the contracts exactly (`HARDENING.md`). That is not
  an audit. Start with small pools, and get an independent review before you hold other people's money at scale.
- **Not supported:** tokens that charge a fee on transfer or rebase (the pool's accounting assumes what was sent is what
  arrives). There are no "supporting fee-on-transfer" router variants.
- **The first deposit sets the price**, and locks 1,000 units of LP tokens forever (so a tiny first deposit cannot be used to
  manipulate the share price). Enter the first deposit at the market ratio; the modal warns about this.
- **Protocol fee** is off. The timelock may set `feeTo`; the pools then mint LP tokens worth one sixth of the 0.3% fee (0.05%
  of volume) to that address. It cannot touch anyone's liquidity and cannot raise the swap fee.
- The router never keeps tokens. Tokens or native QUAI sent to it by mistake stay there.
- **Permits** are front-run tolerant: if someone submits your signature first, `removeLiquidityWithPermit` still works because
  the allowance it created is already there.
- **Lost proposer = no more upgrades, ever.** That is the safe failure (nothing can be attacked), but plan for it: a multisig,
  and a guardian-and-proposer rotation (`grant-role`, then `revoke-role`) before a signer leaves.

The app finds every Circleswap pool by asking the factory, adds them to Swap (direct routes plus two-hop routes through WQUAI
or Q0), and the **Liquidity** modal offers Circleswap as a DEX: create a pool (BDELTA / Q0 and BDELTA / WQUAI have presets),
add liquidity with the LP tokens you will receive shown first, and remove liquidity (by percentage, with your positions
listed). Removing works on the other two DEXes too, since they share the ABI. Until the addresses exist, Circleswap shows as
"not deployed yet" and nothing can be sent to it.

Not done yet: the farm's pool list (`FARM_REGISTRY`) is a fixed list of the external LP tokens, so staking a Circleswap LP token
needs the farm owner to `addPool` it and the registry to list it. Native QUAI (rather than WQUAI) in the modal is not wired up
either, although the router supports it.

## How the boost works, and what it does not stop

A wallet is boosted (+50% on both rewards) when it has held **at least 0.0001 QRB continuously for 1 day**. The
clock starts when a balance reaches the threshold and resets if it falls below; topping up does not restart it.
The holding time exists because a bare balance check can be borrowed for one transaction (a flash swap out of any
QRB pool, or a lender contract) to claim the boost for nothing.

What this still allows, so you can decide whether it is acceptable:

- **Retroactive boost.** The boost is applied at harvest to everything earned since the last harvest. A wallet
  can stake, acquire 0.0001 QRB, hold it for a day, then harvest a boosted total for the whole period.
- **Rented boost.** Someone can lend 0.0001 QRB for a day. It cannot be lent to two wallets at once, so at most
  10,000 wallets (1.0 QRB / 0.0001) can be boosted at any moment, but who they are can change daily.
- The three numbers are constants in `Qrb.sol`; changing any of them means a new Qrb.

## Dependency audit (2026-09-21)

`pnpm audit` on the q0 workspace, after pinning transitive versions in the root `package.json` (`pnpm.overrides`
for `elliptic`, `secp256k1`, `ws`): **0 critical**, 13 high. What is left:

- Hardhat toolchain (`adm-zip`, `undici`, `lodash`, `serialize-javascript`, `tmp`): dev-time build tooling that
  was already there; not shipped, not used against untrusted input. Fixing needs a Hardhat major upgrade.
- `bigint-buffer` (no patched release exists) inside `@ardrive/turbo-sdk`'s Solana signer path, which an Arweave
  keyfile upload does not use. Use upload option B if you would rather not have it installed at all.
- `vite` 5.x (dev server, Windows path handling; patched only in 6.4.3+, a major upgrade): keep the dev server on
  localhost.

## Tests

```bash
pnpm --filter contracts test        # 501: Qrb/NFT/farm, audit regressions, boost consistency, the AMM (pools, router, factory,
                                    #      properties, LP-in-farm, client parity), governance and upgrades, the real browser
                                    #      deployment flow and the integrity inspector on a real EVM, the CLI deployment
pnpm --filter contracts test:forge  # 43: Foundry fuzz and invariant suites (HARDENING.md)
pnpm --filter contracts slither     # 0 results
pnpm --filter contracts check:layout
bun test tests/                     # from q0/ (122 in 5 files): routing, Circleswap discovery and maths, pairs, the browser deploy
                                    #      runner on a simulated chain, swap. One known failure predates this work:
                                    #      swapModule "Executes Quaiswap LP swap via provider" (a mock wallet that does not answer quai_sendTransaction)
```
