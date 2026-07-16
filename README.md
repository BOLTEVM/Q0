# ⚡ Q0 Analytics & Quaiswap LP Dashboard

A premium, glassmorphic analytics monorepo designed for the **Q0 (QBOLT)** token contract on the **Quai Network** (`Cyprus-1` shard). This application displays real-time on-chain statistics, holder statistics, dynamic transaction ledgers, and integrates an on-chain Swap simulator/execution module interfacing directly with the Quaiswap Liquidity Pools.

---

## 🏗️ Monorepo Architecture

This project is configured as a `pnpm` monorepo separating data logic from the presentation layer:

*   **`apps/stats-app/`**: A React + TypeScript single-page dashboard built on Vite. Styled with a custom premium dark-themed glassmorphism system using Vanilla CSS.
*   **`packages/quai-service/`**: A shared ESModule-compiled service client that wraps Quai Network JSON-RPC interfaces, constant-product AMM swap formulas, and explorer REST APIs.

---

## ⚡ Key Features

1.  **Real-Time Stat Tracking**: Reads on-chain metadata (`name`, `symbol`, `decimals`, `totalSupply`) and live Cyprus-1 block numbers directly via RPC.
2.  **Liquidity Pool Analytics**: Monitored reserve ratios, token rates, and balances for:
    *   **Q0 / WQUAI LP**: `0x003B4b96bF0793EB1D53B79f8c38746A298eEef8`
    *   **Q0 / BOSS LP**: `0x0036c1A5e62597438cC204F8613c15211D4b7787`
3.  **Swap Simulation & Execution**:
    *   Computes output rates, slippage thresholds, and price impact values using constant-product math (\(x \cdot y = k\)) with a 0.3% pool fee.
    *   Wallet Integration: Integrates standard browser extensions (e.g., Pelagus / MetaMask) to request accounts and prompt transaction signing.
    *   Direct-to-Contract Swaps: Avoids hardcoded router contracts by executing a raw transaction sequence: a token `transfer()` directly to the pair contract followed by a `swap()` call on the LP pair.
4.  **Explorer Ledger**: Pulls the latest token transfer events from Quaiscan to show live token activity and identify the top active holder distribution.

---

## ⚙️ Configuration details

*   **RPC Endpoint**: `https://rpc.quai.network/cyprus1`
*   **Explorer API Base**: `https://quaiscan.io/api/v2`
*   **Target Contract Shard**: Cyprus-1 (Region 0, Zone 0; byte prefix `0x00`)

---

## 🚀 Getting Started

### Prerequisites
*   [Node.js](https://nodejs.org/) v18+
*   [pnpm](https://pnpm.io/) v9+ or v10+

### Installation & Builds

1.  **Clone & Install dependencies**:
    ```bash
    pnpm install
    ```

2.  **Compile the Workspace**:
    ```bash
    pnpm build
    ```

3.  **Start the Local Development Server**:
    ```bash
    pnpm dev
    ```

The application will launch and be available locally at **[http://localhost:4100/](http://localhost:4100/)**.
