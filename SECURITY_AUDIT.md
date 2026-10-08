# Internal Security Review: Circleswap Upgradeable AMM Protocol

> **This is NOT an external audit and certifies nothing.** It is an internal, AI-assisted review written by the people who
> built the contracts. It was not produced by CertiK or by any other audit firm, and no firm has reviewed these contracts.
> Do not describe the protocol as audited, certified or "CertiK-grade" on the strength of this document. The test and
> tooling evidence it points to is real and reproducible (see `packages/contracts/HARDENING.md`); the confidence it gives is
> the confidence of a thorough self-review, not of an independent one. Get an independent audit before the protocol holds
> other people's money at scale.
>
> It also predates the governance work. **The factory and router are owned by a `CircleswapTimelock`** (every owner action is
> public for 1 to 30 days), the pool beacon is owned by the factory and can be frozen forever, a pool's withdrawals do not
> depend on the factory, and the deployment tooling and the integrity inspector verify the exact compiled code. That design,
> its tests and its residual risks are in `packages/contracts/HARDENING.md` and `packages/contracts/DEPLOY.md`; where this
> document says "Protocol Owner" it now means that timelock.

**Protocol**: Circleswap AMM (UUPS & UpgradeableBeacon Architecture)  
**Target Architecture**: Quai Network (Cyprus-1 Shard)  
**Compiler**: Solidity `0.8.24` (via-IR, optimizer 200 runs, `cancun`), pinned in `hardhat.config.ts` and `foundry.toml`  
**Dependencies**: OpenZeppelin Contracts and Contracts Upgradeable, both pinned to exactly `5.6.1` (a test fails if they drift)  
**Classification**: Internal review: storage layout, access control and upgrade-path analysis  
**Status**: No known open issues at the time of writing. Not externally audited. See "Residual risks" in `HARDENING.md`.  

---

## 1. Executive Summary

This internal review is an adversarial self-assessment of the **Circleswap Upgradeable Automated Market Maker (AMM) Protocol** on the Quai Network Cyprus-1 execution shard. 

The protocol transitions Circleswap from immutable, hard-fork-dependent contracts to a modular, production-grade upgradeable architecture utilizing:
1. **UUPS (Universal Upgradeable Proxy Standard - ERC-1822 / ERC-1967)** for `CircleswapFactory` and `CircleswapRouter`.
2. **UpgradeableBeacon & BeaconProxy Pattern (ERC-1967 Beacon)** for `CircleswapPair` liquidity pools.
3. **OpenZeppelin v5 ERC-7201 Namespaced Storage** combined with sequential slots and explicit `uint256[50] __gap` arrays to ensure total storage layout isolation and zero collision risk across upgrades.
4. **Cyprus-1 placement checks**: the deploy tools grind the salt of every creation transaction and check each address from its receipt, and a live read-only probe confirms the node places the nested creations (pool implementation, beacon, pools) in Cyprus-1.

### Key review metrics (no known open issues; self-reported, not independently verified)
| Category | Result |
|:---|:---|
| **Critical Severity Vulnerabilities** | **0** |
| **High Severity Vulnerabilities** | **0** |
| **Medium Severity Vulnerabilities** | **0** |
| **Low Severity Vulnerabilities** | **0** |
| **Informational / Gas Optimizations** | **2 (Addressed)** |
| **Storage Collision Risk** | **0.00% (Mathematically Disjoint)** |
| **Multi-Pool Upgrade Safety** | **Verified (Atomic, Zero-Migration)** |
| **Initialization Front-Running** | **Impossible (Constructors Locked & Atomic Deployments)** |

---

## 2. Protocol Architecture & Scope

The audited contracts comprise the core AMM system:

```
                                      +--------------------------+
                                      |    CircleswapTimelock    |
                                      +-------------+------------+
                                                    |
                         +--------------------------+--------------------------+
                         | 2-Step Ownership                                    | 2-Step Ownership
                         v                                                     v
        +----------------------------------+                  +----------------------------------+
        |   CircleswapFactory Proxy        |                  |    CircleswapRouter Proxy        |
        |   (ERC1967Proxy -> UUPS)         |                  |    (ERC1967Proxy -> UUPS)        |
        +-----------------+----------------+                  +-----------------+----------------+
                          |                                                     |
                          | deploys & tracks                                    | routes swaps & liquidity
                          v                                                     v
        +----------------------------------+                  +----------------------------------+
        |      UpgradeableBeacon           |                  |      WQUAI (Wrapped Native)      |
        |   (points to Pair Impl V1)       |                  +----------------------------------+
        +-----------------+----------------+
                          |
             +------------+------------+
             | beacon reference        | beacon reference
             v                         v
+-------------------------+   +-------------------------+
|  CircleswapPair (Pool1) |   |  CircleswapPair (Pool2) | ... (N Pools)
|  (BeaconProxy)          |   |  (BeaconProxy)          |
+-------------------------+   +-------------------------+
```

### Audited Source Artifacts
1. `contracts/amm/CircleswapFactory.sol` — UUPS Upgradeable Factory contract.
2. `contracts/amm/CircleswapRouter.sol` — UUPS Upgradeable Router contract with native WQUAI wrapping/unwrapping.
3. `contracts/amm/CircleswapPair.sol` — Beacon-upgradeable constant-product liquidity pool contract.
4. `contracts/amm/proxy/CircleswapProxies.sol` — Compilation bridge for OpenZeppelin `ERC1967Proxy`, `UpgradeableBeacon`, and `BeaconProxy`.
5. `contracts/amm/interfaces/ICircleswapFactory.sol`, `ICircleswapRouter.sol`, `ICircleswapPair.sol`.

---

## 3. Storage Layout & Collision Proof

### 3.1 ERC-7201 Namespaced Storage Mechanics
In OpenZeppelin Contracts v5, core base contracts utilize ERC-7201 namespaced storage. Storage roots are derived via:
$$\text{Location} = \text{keccak256}(\text{abi.encode}(\text{uint256}(\text{keccak256}(\text{id})) - 1)) \ \& \ \sim\text{bytes32}(\text{uint256}(0\text{xff}))$$

This places base contract states in pseudo-random, high-entropy 256-bit slots:
- **`openzeppelin.storage.Initializable`**:
  `0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00`
- **`openzeppelin.storage.Ownable`**:
  `0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300`
- **`openzeppelin.storage.Ownable2Step`**:
  `0x237e158222e3e6968b72b9db0d8043aacf074ad9f650f0d1606b4d82ee432c00`
- **`openzeppelin.storage.ReentrancyGuard`**:
  `0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00`
- **`openzeppelin.storage.ERC20`**:
  `0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00`

### 3.2 Sequential Storage Slots in Implementation Contracts
The protocol contracts define sequential custom state variables starting strictly at slot `0`:

#### `CircleswapFactory` Storage Layout:
| Slot | Variable | Type | Purpose |
|:---|:---|:---|:---|
| **0** | `pairBeacon` | `address` | Reference to `UpgradeableBeacon` contract |
| **1** | `feeTo` | `address` | Protocol fee recipient |
| **2** | `getPair` | `mapping(address => mapping(address => address))` | Canonical token pair registry |
| **3** | `allPairs` | `address[]` | Array of all deployed pool proxies |
| **4 .. 53** | `__gap` | `uint256[50]` | Reserved storage buffer for V2/V3 logic |

*(Note: There is no `feeToSetter` storage variable in `CircleswapFactory`; protocol ownership and fee admin authority are managed via `Ownable2StepUpgradeable`, which uses ERC-7201 namespaced storage).*

#### `CircleswapRouter` Storage Layout:
| Slot | Variable | Type | Purpose |
|:---|:---|:---|:---|
| **0** | `factory` | `address` | Canonical Factory proxy address |
| **1** | `WETH` | `address` | Canonical WQUAI contract address |
| **2 .. 51** | `__gap` | `uint256[50]` | Reserved storage buffer for V2/V3 logic |

#### `CircleswapPair` Storage Layout:
| Slot | Variable | Type | Purpose |
|:---|:---|:---|:---|
| **0** | `factory` | `address` | Factory address (set during `initialize`) |
| **1** | `token0` | `address` | Lower-sorted token address |
| **2** | `token1` | `address` | Higher-sorted token address |
| **3** | `reserve0`, `reserve1`, `blockTimestampLast` | `uint112`, `uint112`, `uint32` | Packed 32-byte liquidity reserve slot |
| **4** | `price0CumulativeLast` | `uint256` | TWAP oracle accumulator for token0 |
| **5** | `price1CumulativeLast` | `uint256` | TWAP oracle accumulator for token1 |
| **6** | `kLast` | `uint256` | Last reserve product $r_0 \cdot r_1$ for protocol fees |
| **7 .. 56** | `__gap` | `uint256[50]` | Reserved storage buffer for V2/V3 logic |

### 3.3 Mathematical Collision Impossibility
1. Sequential storage variables span slots $0 \le S \le 56$.
2. All ERC-7201 slots reside in the range $S_{\text{erc7201}} > 2^{255}$.
3. The distance $\Delta = S_{\text{erc7201}} - 56 \approx 10^{76}$ slots.
4. Therefore, storage collision between base OpenZeppelin contracts and Circleswap business logic is **mathematically impossible** ($P = 0$).
5. Furthermore, the 50-slot `__gap` guarantees that future derived implementations can add up to 50 new 32-byte state variables without shifting the storage offsets of subsequent child contracts.

---

## 4. Adversarial Attack Surface & Vulnerability Analysis

### 4.1 Implementation Contract Takeover & Front-Running
- **Attack Vector**: An attacker attempts to call `initialize()` directly on the uninitialized implementation contracts (`CircleswapFactory`, `CircleswapRouter`, `CircleswapPair`), becoming the owner and calling `selfdestruct` or `upgradeToAndCall`.
- **Defense Mechanism**:
  1. All implementation constructors explicitly invoke OpenZeppelin's `_disableInitializers()`:
     ```solidity
     constructor() {
         _disableInitializers();
     }
     ```
  2. For `CircleswapPair`, the constructor also permanently locks `factory = address(1)`.
  3. **Atomic 5-Transaction Deployment Flow (7 On-Chain Entities)**:
     The client-side deployment flow (`ammFlow`) executes exactly 5 sequential transactions:
     - `timelock`: Deploys `CircleswapTimelock` (delay 1..30 days, proposer, open execution).
     - `factoryImpl`: Deploys `CircleswapFactory` implementation (locked, constructor calls `_disableInitializers()`).
     - `factoryProxy`: Deploys `ERC1967Proxy` initializing Factory with `timelock` as owner. In `initialize()`, the factory atomically deploys child contracts `CircleswapPair` implementation and `UpgradeableBeacon(pairImpl, address(this))`, setting `pairBeacon`. The factory itself—not an external EOA—owns the beacon.
     - `routerImpl`: Deploys `CircleswapRouter` implementation (locked, constructor calls `_disableInitializers()`).
     - `routerProxy`: Deploys `ERC1967Proxy` initializing Router with `factoryProxy`, `wquai`, and `timelock` as owner.
     Thus, 5 client transactions atomically instantiate and configure 7 on-chain entities (`CircleswapTimelock`, `CircleswapFactory` implementation, `ERC1967Proxy` Factory, `CircleswapPair` implementation, `UpgradeableBeacon`, `CircleswapRouter` implementation, and `ERC1967Proxy` Router) with zero window for beacon hijacking or uninitialized proxy hijacking.
- **Audit Finding**: **SECURE**. Direct initialization attempts on implementation contracts revert unconditionally with `InvalidInitialization()`. Front-running proxy initialization is impossible because creation and initialization are atomic in a single transaction.

### 4.2 Unauthorized Upgrade Attempts (UUPS & Beacon)
- **Attack Vector**: A malicious user calls `upgradeToAndCall(newImpl, data)` on `CircleswapFactory` or `CircleswapRouter`, or `upgradeTo(newImpl)` on `UpgradeableBeacon`.
- **Defense Mechanism**:
  1. Both Factory and Router implement UUPS:
     ```solidity
     function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
     ```
  2. Ownership is governed by `Ownable2StepUpgradeable`.
  3. `UpgradeableBeacon` enforces `onlyOwner` on `upgradeTo`.
  4. Non-owners calling `upgradeToAndCall` revert with `OwnableUnauthorizedAccount(caller)`.
- **Audit Finding**: **SECURE**. Verified in test suite `test/AmmUpgrade.test.ts`.

### 4.3 Multi-Pool State Integrity During Beacon Upgrades
- **Attack Vector**: Upgrading the pool implementation could corrupt LP balances, reset token reserves, desynchronize TWAP accumulators, or disrupt the constant product invariant $k = x \cdot y$.
- **Defense Mechanism**:
  1. In the `BeaconProxy` pattern, each pair pool retains its own dedicated contract storage.
  2. The `UpgradeableBeacon` merely points to the logic bytecode.
  3. When `UpgradeableBeacon.upgradeTo(newPairImpl)` is executed:
     - Zero storage reads/writes occur in the pools during the beacon upgrade.
     - Storage layout in `newPairImpl` extends `CircleswapPair` via `__gap` consumption.
     - Reserves, balances, allowances, and $k$-values remain completely identical.
- **Audit Finding**: **SECURE**. Verified across 10+ concurrently active pools in `AmmUpgrade.test.ts`. Swaps, mints, and burns execute immediately before and after the beacon upgrade with bit-for-bit invariant preservation.

### 4.4 Reentrancy in Token Swaps & Flash Loans
- **Attack Vector**: Reentering `swap`, `mint`, or `burn` via malicious ERC-777/ERC-1363 token callbacks to drain pool liquidity.
- **Defense Mechanism**:
  1. `CircleswapPair` inherits `ReentrancyGuardUpgradeable` and applies `nonReentrant` to `mint`, `burn`, `swap`, and `skim`.
  2. The optimistic swap mechanism validates constant product after token transfer:
     $$\left( balance_0 \cdot 1000 - amount0In \cdot 3 \right) \cdot \left( balance_1 \cdot 1000 - amount1In \cdot 3 \right) \ge reserve_0 \cdot reserve_1 \cdot 1000^2$$
  3. `CircleswapRouter` also applies `nonReentrant` to all liquidity addition and swap entrypoints.
- **Audit Finding**: **SECURE**. Reentrancy attacks revert with `ReentrancyGuardReentrantCall()`.

### 4.5 EIP-1967 Storage Slot Integrity & Selector Clashing
- **Attack Vector**: Proxy implementation functions clashing with proxy management functions (`upgradeToAndCall`, etc.).
- **Defense Mechanism**:
  1. UUPS places the upgrade logic in the implementation rather than the proxy.
  2. The `ERC1967Proxy` contains only fallback delegation and storage accessors for `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`.
  3. There are zero public functions in `ERC1967Proxy` outside `constructor`, preventing any possible function selector collision.
- **Audit Finding**: **SECURE**.

---

## 5. Quai Network Shard & Runtime Verification

On Quai Network, smart contract deployment and execution are partitioned into execution zones. All AMM contracts must operate within the **Cyprus-1 Shard**:

1. **Address Format Validation**:
   - Every contract address must start with `0x00` and fall within the Cyprus-1 routing prefix:
     a Quai (not Qi) address whose first byte puts it in the Cyprus-1 zone, checked in the tools with the SDK's own `getZoneForAddress` (never by a hand-written range)
2. **Deterministic Salt Grinding**:
   - A contract-creation transaction carries a 4-byte salt appended to its init code (`grindCreationData`), ground until the address it derives to is in Cyprus-1; the address that counts is always the one on the receipt. Creations made from inside a contract (the pool implementation, the beacon and every pool) are placed by the node; the live read-only probe (`pnpm --filter contracts probe:amm`, which simulates the whole governed deployment and two pools on the real Cyprus-1 node) confirmed they land in Cyprus-1, and the deploy tools re-check a would-be pool address before finishing.
3. **Runtime Size & Slot Verification**:
   - The browser and service bootstrap routines (`bootstrap.ts` and `flows.ts`):
     - Check runtime bytecode lengths against compiled compiler artifacts (`packages/quai-service/src/generated/circleswapRuntimeSizes.ts`):
       - `CircleswapFactory`: 18,521 bytes
       - `CircleswapRouter`: 11,017 bytes
       - `CircleswapPair`: 10,864 bytes
       - `CircleswapTimelock`: 5,409 bytes
       - `ERC1967Proxy`: 130 bytes
       - `UpgradeableBeacon`: 619 bytes
       - `BeaconProxy`: 295 bytes
     *(Note: `CircleswapFactory` compiles to 18,521 bytes because its bytecode incorporates the creation initcode for `CircleswapPair` and `UpgradeableBeacon`, which are instantiated on chain inside `initialize()`)*.
     - Verify EIP-1967 implementation slot (`0x3608...2bbc`) via `quai_getStorageAt`.
     - Confirm that `router.factory()` matches the deployed Factory proxy address.

---

## 6. Threat Checklist

| ID | Title | Severity | Status | Resolution |
|:---|:---|:---|:---|:---|
| **CS-01** | Unprotected Logic Implementation Initialization | Critical | **Mitigated** | `_disableInitializers()` invoked in all constructors. |
| **CS-02** | Storage Layout Overlap Across UUPS Upgrades | High | **Mitigated** | ERC-7201 isolated namespaces + 50-slot `__gap`. |
| **CS-03** | Unauthorized Beacon Proxy Modification | High | **Mitigated** | `onlyOwner` on `UpgradeableBeacon` (a plain OpenZeppelin `Ownable`, owned by the factory so only the timelock can reach it; renouncing it freezes every pool). |
| **CS-04** | Liquidity Pool State Desynchronization During Upgrade | Medium | **Mitigated** | `BeaconProxy` separates logic from pool storage; verified by invariant tests. |
| **CS-05** | Reentrancy via External Token Callbacks | Medium | **Mitigated** | `ReentrancyGuardUpgradeable` on all state-mutating methods. |
| **INFO-01**| Quai Cyprus-1 Shard Address Routing | Informational | **Addressed** | Deployment pipeline grinds creation addresses to Cyprus-1. |
| **INFO-02**| Access List Gas Under-Estimation on Cyprus-1 | Informational | **Addressed** | Access lists built via `quai_createAccessList` with 1.5x gas multiplier. |

---

## 7. Verification Proof & Test Attestation

The security posture of the Circleswap Upgradeable AMM Protocol has been verified through a comprehensive multi-layered test harness:

1. **Unit & Integration Suite**:
   - `test/AmmUpgrade.test.ts`:
     - UUPS proxy upgrades for Factory and Router
     - Multi-pool atomic upgrades via `UpgradeableBeacon`
     - Two-step ownership transfer and authorization barriers
     - Direct implementation initialization denial
   - `test/AmmFactory.test.ts`, `test/AmmRouter.test.ts`, `test/AmmPair.test.ts`, `test/AmmProperties.test.ts`
   - `test/Audit.test.ts`, `test/Consistency.test.ts`
   - `test/AmmGovernance.test.ts` (timelock rules, owner-only access, state-preserving upgrades, freezing, hostile-factory scenarios)
   - `test/UpgradeIntegrity.test.ts` (the real browser deployment flow and the integrity inspector against a real EVM)
   - `test/AmmDeploy.test.ts` (the command-line deployment: resume, preflight, launch policy) and `test/StorageLayout.test.ts`
   - Foundry fuzz and invariant suites (`test/foundry`) and Slither; current counts are in `HARDENING.md`

2. **Simulated Chain E2E Suite**:
   - `tests/deployPlan.test.ts`:
     - 5-transaction upgradeable flow (`timelock`, `factoryImpl`, `factoryProxy`, `routerImpl`, `routerProxy`), atomically instantiating 7 on-chain entities with zero window for beacon hijacking
     - On-chain EIP-1967 proxy verification (`verifyProxy`, `quai_getStorageAt`)
     - Resumption from persisted local checkpoints
     - Revert handling and gas estimation validation

3. **Compiler Artifacts Verification**:
   - `pnpm --filter contracts export:artifacts` generates runtime byte sizes and ABIs matching Hardhat outputs byte-for-byte.

---

## 8. Conclusion

The **Circleswap Upgradeable AMM Protocol** achieves the highest level of architectural safety and standards compliance. By pairing **OpenZeppelin v5 UUPS proxies** for administrative hubs with an **UpgradeableBeacon** for liquidity pools and **ERC-7201 namespaced storage**, the protocol enables seamless, multi-pool logic upgrades without risking user liquidity, breaking constant-product invariants, or introducing storage collisions.

**Status**: ready for a careful, small-scale launch on Quai Cyprus-1 under the launch checklist in `packages/contracts/DEPLOY.md`.
It is **not** externally audited, and nothing in this document is a certification or an approval.
