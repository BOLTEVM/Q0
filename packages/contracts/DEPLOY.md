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

## Circleswap AMM (factory + router)

Circleswap has its own automated market maker, so pools no longer have to live on Quaiswap or Quainance. It is a
separate deployment from Qrb, the NFT and the farm: run it once, in any order relative to them.

What you get (`contracts/amm`): a factory that creates pools, a router that adds and removes liquidity and swaps
(any path, native QUAI through WQUAI), and one pool contract per pair that **is** its own LP token (`CSLP`, a
standard ERC-20 with permit). It is a constant-product pool with a 0.3% fee that stays in the pool, and it has the
Uniswap-V2 function set and argument order, so wallets and the app's encoders work unchanged.

```bash
pnpm --filter contracts compile
pnpm --filter contracts probe:amm                                   # read-only check against the live node, no key, no funds
pnpm --filter contracts deploy:quai -- --amm --from <any Cyprus-1 address>          # dry run
QUAI_PRIVATE_KEY=0x... pnpm --filter contracts deploy:quai -- --amm --broadcast      # deploy
```

Options: `--owner <addr>` (owner of the factory; default: the deployer), `--fee-to <addr>` (turn the protocol fee on at
deploy time; needs owner = deployer), `--resume` after an interruption (progress is in
`deployments/<network>.amm.progress.json`, same behaviour as above), `--force-redeploy` if `deployed.ts` already lists
an AMM factory (a second one splits liquidity, so it is refused by default).

Guarantees, on top of the ones above (addresses from receipts, Cyprus-1 check, code check, dry run by default):

- The factory deploys its own pool implementation; the script checks that implementation is real, the right size,
  and **locked** (nobody can initialise it and use it as a pool). The router is read back for its factory and WQUAI.
- After both exist, the script calls `createPair` **statically** for a real token pair (Q0 / WQUAI) and requires the
  address it would return to be a valid Cyprus-1 address. Nothing is created by this; it is the proof that pools
  land in the zone. (`probe:amm` does the same against the live node before you deploy anything.)
- A pool's address is only ever read from `factory.getPair`. Nothing computes it, because Quai grinds contract
  addresses.

Cost, measured 2026-09-21 on a dry run: the factory (which also deploys the pool implementation) simulates at about
3.3M gas and the router at about 2.5M. At the gas price that day the **maximum** was about **1,030 QUAI** for both
(factory 588, router 442; the router's figure is projected from its size, because it cannot be simulated before a
factory exists, and is simulated exactly right before it is sent). Quai charges creation gas well above the
simulator's estimate (past creations used about 2.5x it, so most of the 3x limit is spent rather than refunded), so
plan for most of that figure, not a fraction. **Creating each pool is also a contract creation** and is expensive
for the same reason (the estimate is about 2.5M gas); the modal shows the gas limit and maximum cost while you
confirm in your wallet, and the estimator is known to be inconsistent for nested creations, so treat those figures as rough.

Things to know before you rely on it:

- **New and not independently audited.** It has a 43-test pool suite, 38 router tests, factory and deployment
  suites, a randomised property test (invariants after hundreds of random operations) and a test that holds the
  app's client-side maths to the contracts exactly. That is not an audit. Start with small pools.
- **Not supported:** tokens that charge a fee on transfer or rebase (the pool's accounting assumes what was sent is
  what arrives). There are no "supporting fee-on-transfer" router variants.
- **The first deposit sets the price**, and locks 1,000 units of LP tokens forever (so a tiny first deposit cannot
  be used to manipulate the share price). Enter the first deposit at the market ratio; the modal warns about this.
- **Protocol fee** is off. The factory owner (`Ownable2Step`) may set `feeTo`; the pools then mint LP tokens worth
  one sixth of the 0.3% fee (0.05% of volume) to that address. It cannot touch anyone's liquidity and cannot raise
  the swap fee.
- The router has no owner and never keeps tokens. Tokens or native QUAI sent to it by mistake stay there.
- **Permits** are front-run tolerant: if someone submits your signature first, `removeLiquidityWithPermit` still
  works because the allowance it created is already there.

After a broadcast, `deployed.ts` is regenerated (`AMM_FACTORY`, `AMM_ROUTER`); rebuild `quai-service` and the app.
The app then finds every Circleswap pool by asking the factory, adds them to Swap (direct routes plus two-hop
routes through WQUAI or Q0), and the **Liquidity** modal offers Circleswap as a DEX: create a pool (BDELTA / Q0 and
BDELTA / WQUAI have presets), add liquidity with the LP tokens you will receive shown first, and remove liquidity
(by percentage, with your positions listed). Removing works on the other two DEXes too, since they share the ABI.
Until the addresses exist, Circleswap shows as "not deployed yet" and nothing can be sent to it.

Not done yet: the farm's pool list (`FARM_REGISTRY`) is a fixed list of the external LP tokens, so staking a
Circleswap LP token needs the farm owner to `addPool` it and the registry to list it. Native QUAI (rather than
WQUAI) in the modal is not wired up either, although the router supports it.

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
pnpm --filter contracts test        # 405: Qrb/NFT/farm, audit regressions, boost consistency, deploy tooling, and the AMM
                                    #      (pools, router, factory, properties, LP-in-farm, deploy, client parity)
bun test tests/routing.test.ts tests/circleswap.test.ts   # from q0/ (51): routing, units, slippage, liquidity,
                                    #      boost status, Circleswap discovery / routes / LP maths
```
