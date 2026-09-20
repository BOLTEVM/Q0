import { useState, useEffect, useCallback } from 'react';
import { 
  Activity, 
  ArrowUpDown, 
  Coins, 
  Database, 
  ExternalLink, 
  TrendingUp, 
  Wallet, 
  RefreshCw, 
  Users, 
  Award
} from 'lucide-react';
import {
  CONTRACTS,
  QUAINANCE_ROUTER,
  getTokenMetadata,
  getLPReserves,
  getLatestBlockNumber,
  simulateSwap,
  getTokenBalance,
  getQuaiBalance,
  quaiRpcCall,
  getTokenDetailV2,
  getQuainanceTVL,
  findQuainancePools,
  TokenMetadata,
  LPReserves,
  TokenDetailV2,
  TokenTransferV2,
  QuainanceTVL
} from 'quai-service';
import { 
  getQuaiProvider, 
  getCyprus1Address, 
  requestWalletAccounts, 
  getAuthorizedAccounts, 
  sendWalletTransaction 
} from './providerUtils';

export default function App() {
  // Wallet States
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [q0Balance, setQ0Balance] = useState<string>('0');
  const [wquaiBalance, setWquaiBalance] = useState<string>('0');
  const [bossBalance, setBossBalance] = useState<string>('0');
  const [quaiBalance, setQuaiBalance] = useState<string>('0');
  const [laptopBalance, setLaptopBalance] = useState<string>('0');
  const [qgirlBalance, setQgirlBalance] = useState<string>('0');
  const [walletLoading, setWalletLoading] = useState<boolean>(false);

  // General Chain & Contract States
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [q0Meta, setQ0Meta] = useState<TokenMetadata | null>(null);
  const [holderCount, setHolderCount] = useState<number>(0);
  const [latestBlock, setLatestBlock] = useState<number>(0);
  const [transfers, setTransfers] = useState<TokenTransferV2[]>([]);
  const [tokenDetail, setTokenDetail] = useState<TokenDetailV2 | null>(null);

  // LP Pool States
  const [lpWquai, setLpWquai] = useState<LPReserves | null>(null);
  const [lpBoss, setLpBoss] = useState<LPReserves | null>(null);
  const [lpLaptopWquai, setLpLaptopWquai] = useState<LPReserves | null>(null);
  const [lpLaptopQgirl, setLpLaptopQgirl] = useState<LPReserves | null>(null);

  // Quainance DEX States (new explorer.qu.ai API - https://explorer.qu.ai/api-docs)
  const [quainanceTvl, setQuainanceTvl] = useState<QuainanceTVL | null>(null);
  
  // Swap States
  const [selectedPool, setSelectedPool] = useState<'WQUAI' | 'BOSS' | 'BOSS_QUAI' | 'LAPTOP_WQUAI' | 'LAPTOP_QGIRL'>('WQUAI');
  const [swapAmountIn, setSwapAmountIn] = useState<string>('');
  const [swapAmountOut, setSwapAmountOut] = useState<string>('');
  const [slippage, setSlippage] = useState<number>(1.0);
  const [priceImpact, setPriceImpact] = useState<string>('0.00%');
  const [minReceived, setMinReceived] = useState<string>('0');
  const [execPrice, setExecPrice] = useState<string>('0');
  const [swapDirection, setSwapDirection] = useState<'Q0_TO_TOKEN' | 'TOKEN_TO_Q0'>('Q0_TO_TOKEN');
  const [swapLoading, setSwapLoading] = useState<boolean>(false);
  const [swapTxHash, setSwapTxHash] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  // Atomic router swap progress state ('IDLE' | 'APPROVING' | 'SWAPPING')
  const [pendingSwapStep, setPendingSwapStep] = useState<'IDLE' | 'APPROVING' | 'SWAPPING'>('IDLE');

  const waitForTransaction = async (txHash: string): Promise<any> => {
    const maxAttempts = 120; // 90 seconds wait (120 * 750ms)
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await quaiRpcCall('quai_getTransactionReceipt', [txHash]);
        if (receipt) {
          if (receipt.status === '0x1' || receipt.status === 1) {
            return receipt;
          }
          throw new Error("Transaction execution failed on-chain.");
        }
      } catch (e: any) {
        if (e.message && e.message.includes("failed on-chain")) {
          throw e;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error("Transaction was not mined within 90 seconds. It may still confirm on Cyprus-1. Check status or use Manual Recovery.");
  };

  const parseSwapError = (err: any): string => {
    const msg = err.message || String(err);
    if (msg.toLowerCase().includes("insufficient funds")) {
      return "⚠️ Insufficient QUAI for Gas: You need more native QUAI in your wallet to cover the network transaction fee (estimated ~1.9 QUAI at current gas prices).";
    }
    return msg || "Transaction rejected or execution reverted.";
  };

  /**
   * ABI-encode a call to the Quainance Router's swapExactTokensForTokens:
   *   function swapExactTokensForTokens(
   *     uint256 amountIn,
   *     uint256 amountOutMin,
   *     address[] calldata path,
   *     address to,
   *     uint256 deadline
   *   ) returns (uint256[] memory amounts)
   *
   * Selector: 0x38ed1739
   * Dynamic layout (all 32-byte slots):
   *   [0] amountIn
   *   [1] amountOutMin
   *   [2] offset to path array  = 0xa0 (5 static words * 32)
   *   [3] to
   *   [4] deadline
   *   [5] path.length
   *   [6..] path elements
   */
  const encodeRouterSwap = (
    amountIn: bigint,
    amountOutMin: bigint,
    path: string[],
    to: string,
    deadline: bigint
  ): string => {
    const pad = (n: bigint | number, bits = 32) =>
      BigInt(n).toString(16).padStart(bits * 2, '0');
    const padAddr = (addr: string) =>
      addr.replace('0x', '').toLowerCase().padStart(64, '0');

    const pathOffset = BigInt(0xa0); // 5 static slots × 32 bytes
    const pathLen = BigInt(path.length);
    const pathEncoded = path.map(padAddr).join('');

    return (
      '0x38ed1739' +
      pad(amountIn) +
      pad(amountOutMin) +
      pad(pathOffset) +
      padAddr(to) +
      pad(deadline) +
      pad(pathLen) +
      pathEncoded
    );
  };

  /**
   * ABI-encode ERC-20 approve(spender, amount) — selector 0x095ea7b3
   */
  const encodeApprove = (spender: string, amount: bigint): string => {
    const cleanSpender = spender.replace('0x', '').toLowerCase().padStart(64, '0');
    const cleanAmount = amount.toString(16).padStart(64, '0');
    return '0x095ea7b3' + cleanSpender + cleanAmount;
  };

  // Top Holders (parsed from transfers for visual representation)
  const [topHolders, setTopHolders] = useState<{address: string, balance: string, pct: string}[]>([]);

  // Fetch all on-chain data
  const fetchData = useCallback(async (isRefresh: boolean = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      // 1. Get Token Metadata, reserves, block number, and rich token detail from
      // the new explorer.qu.ai Explorer API (holders, transfers, USD market stats).
      // Quainance TVL is fetched with on-chain reserve fallback.
      const [meta, wquaiRes, bossRes, laptopWquaiRes, laptopQgirlRes, blockNum, detail] = await Promise.all([
        getTokenMetadata(CONTRACTS.Q0),
        getLPReserves(CONTRACTS.LP_WQUAI),
        getLPReserves(CONTRACTS.LP_BOSS),
        getLPReserves(CONTRACTS.LP_LAPTOP_WQUAI),
        getLPReserves(CONTRACTS.LP_LAPTOP_QGIRL),
        getLatestBlockNumber(),
        getTokenDetailV2(CONTRACTS.Q0)
      ]);

      setQ0Meta(meta);
      setLpWquai(wquaiRes);
      setLpBoss(bossRes);
      setLpLaptopWquai(laptopWquaiRes);
      setLpLaptopQgirl(laptopQgirlRes);
      setLatestBlock(blockNum);
      setTokenDetail(detail);
      setTransfers(detail.transfers);
      setHolderCount(detail.token.holder_count || 34); // Fallback to 34 holders if API fails

      // Top holders come pre-ranked with percentage directly from the explorer
      const parsedHolders = detail.holders
        .filter(h => h.address.toLowerCase() !== '0x0000000000000000000000000000000000000000')
        .slice(0, 8)
        .map(h => ({
          address: h.address,
          balance: (Number(h.balance) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 }),
          pct: h.percentage.toFixed(2) + '%'
        }));
      setTopHolders(parsedHolders);

      // Quainance DEX pools (LAPTOP pairs + everything else indexed)
      try {
        const tvl = await getQuainanceTVL(1, '/api-quai-v2');
        setQuainanceTvl(tvl);
      } catch (tvlErr) {
        console.error("Error loading Quainance TVL data:", tvlErr);
      }

    } catch (e) {
      console.error("Error loading data from Quai:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Run on mount
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Load wallet balances if address is set
  const loadWalletBalances = useCallback(async (addr: string) => {
    try {
      const [q0Bal, wquaiBal, bossBal, quaiBal, laptopBal, qgirlBal] = await Promise.all([
        getTokenBalance(CONTRACTS.Q0, addr),
        getTokenBalance(CONTRACTS.WQUAI, addr),
        getTokenBalance(CONTRACTS.BOSS, addr),
        getQuaiBalance(addr),
        getTokenBalance(CONTRACTS.LAPTOP, addr),
        getTokenBalance(CONTRACTS.QGIRL, addr)
      ]);
      setQ0Balance((Number(q0Bal) / 1e18).toFixed(4));
      setWquaiBalance((Number(wquaiBal) / 1e18).toFixed(4));
      setBossBalance((Number(bossBal) / 1e18).toFixed(4));
      setQuaiBalance((Number(quaiBal) / 1e18).toFixed(4));
      setLaptopBalance((Number(laptopBal) / 1e18).toFixed(4));
      setQgirlBalance((Number(qgirlBal) / 1e18).toFixed(4));
    } catch (e) {
      console.error("Error fetching wallet balance:", e);
    }
  }, []);

  const getBalanceForToken = (symbol: string) => {
    if (symbol === 'Q0') return q0Balance;
    if (symbol === 'WQUAI') return wquaiBalance;
    if (symbol === 'BOSS') return bossBalance;
    if (symbol === 'LAPTOP') return laptopBalance;
    if (symbol === 'QGIRL') return qgirlBalance;
    return '0.0000';
  };

  useEffect(() => {
    if (walletAddress) {
      loadWalletBalances(walletAddress);
    }
  }, [walletAddress, loadWalletBalances]);

  // Check authorized accounts silently on mount (auto-connect)
  useEffect(() => {
    let isMounted = true;
    const checkSilentConnect = async () => {
      const provider = getQuaiProvider();
      if (!provider) return;
      try {
        const accounts = await getAuthorizedAccounts(provider);
        if (isMounted && accounts && accounts.length > 0) {
          const cyprus1Addr = getCyprus1Address(accounts);
          if (cyprus1Addr) {
            setWalletAddress(cyprus1Addr);
          }
        }
      } catch (err) {
        console.warn("Silent account check failed:", err);
      }
    };
    checkSilentConnect();
    return () => {
      isMounted = false;
    };
  }, []);

  // Setup accountsChanged listener with cleanup
  useEffect(() => {
    const provider = getQuaiProvider();
    if (!provider || typeof provider.on !== 'function') return;

    const handleAccountsChanged = (newAccounts: string[]) => {
      if (newAccounts && newAccounts.length > 0) {
        const cyprus1Addr = getCyprus1Address(newAccounts);
        setWalletAddress(cyprus1Addr);
      } else {
        setWalletAddress(null);
      }
    };

    provider.on('accountsChanged', handleAccountsChanged);
    return () => {
      if (typeof provider.removeListener === 'function') {
        provider.removeListener('accountsChanged', handleAccountsChanged);
      }
    };
  }, []);

  // Wallet connection helper
  const connectWallet = async () => {
    const provider = getQuaiProvider();
    if (!provider) {
      alert("Pelagus Wallet not found. Please install the Pelagus extension from https://pelaguswallet.io to interact with Quai Network.");
      return;
    }

    setWalletLoading(true);
    try {
      const accounts = await requestWalletAccounts(provider);
      if (accounts && accounts.length > 0) {
        const selected = getCyprus1Address(accounts);
        if (selected) {
          if (!selected.toLowerCase().startsWith('0x00')) {
            alert(`Warning: The connected account (${selected}) does not reside on the Cyprus-1 shard (address must begin with 0x00). Please select a Cyprus-1 account in Pelagus.`);
          }
          setWalletAddress(selected);
        }
      }
    } catch (e: any) {
      console.error("Wallet connection failed:", e);
      alert("Failed to connect wallet: " + (e.message || "Unknown error"));
    } finally {
      setWalletLoading(false);
    }
  };

  // Perform Swap simulation
  const handleAmountInChange = (val: string) => {
    setSwapAmountIn(val);
    setSwapTxHash(null);
    setSwapError(null);

    if (!val || isNaN(Number(val)) || Number(val) <= 0) {
      setSwapAmountOut('');
      setPriceImpact('0.00%');
      setMinReceived('0');
      setExecPrice('0');
      return;
    }

    // Convert decimal input to Wei
    const amtWei = BigInt(Math.floor(Number(val) * 1e18));

    if (selectedPool === 'BOSS_QUAI') {
      if (!lpBoss || !lpWquai) return;

      if (swapDirection === 'Q0_TO_TOKEN') {
        // Swapping BOSS -> WQUAI (routed via Q0)
        const sim1 = simulateSwap(amtWei.toString(), lpBoss.reserve1, lpBoss.reserve0, 0);
        if (sim1.amountOut === '0') return;

        const sim2 = simulateSwap(sim1.amountOut, lpWquai.reserve0, lpWquai.reserve1, slippage);
        setSwapAmountOut((Number(sim2.amountOut) / 1e18).toFixed(6));
        const imp1 = parseFloat(sim1.priceImpact);
        const imp2 = parseFloat(sim2.priceImpact);
        setPriceImpact((imp1 + imp2).toFixed(2) + '%');
        setMinReceived((Number(sim2.minimumReceived) / 1e18).toFixed(6));
        setExecPrice(sim2.executionPrice);
      } else {
        // Swapping WQUAI -> BOSS (routed via Q0)
        const sim1 = simulateSwap(amtWei.toString(), lpWquai.reserve1, lpWquai.reserve0, 0);
        if (sim1.amountOut === '0') return;

        const sim2 = simulateSwap(sim1.amountOut, lpBoss.reserve0, lpBoss.reserve1, slippage);
        setSwapAmountOut((Number(sim2.amountOut) / 1e18).toFixed(6));
        const imp1 = parseFloat(sim1.priceImpact);
        const imp2 = parseFloat(sim2.priceImpact);
        setPriceImpact((imp1 + imp2).toFixed(2) + '%');
        setMinReceived((Number(sim2.minimumReceived) / 1e18).toFixed(6));
        setExecPrice(sim2.executionPrice);
      }
      return;
    }

    let currentLP = lpWquai;
    if (selectedPool === 'BOSS') currentLP = lpBoss;
    else if (selectedPool === 'LAPTOP_WQUAI') currentLP = lpLaptopWquai;
    else if (selectedPool === 'LAPTOP_QGIRL') currentLP = lpLaptopQgirl;

    if (!currentLP) return;

    // Determine which reserves are In vs Out
    let reserveIn = currentLP.reserve0; // Token0 (Q0 or LAPTOP)
    let reserveOut = currentLP.reserve1; // Token1 (WQUAI, BOSS, or QGIRL)
    
    if (swapDirection === 'TOKEN_TO_Q0') {
      reserveIn = currentLP.reserve1;
      reserveOut = currentLP.reserve0;
    }

    const sim = simulateSwap(amtWei.toString(), reserveIn, reserveOut, slippage);
    setSwapAmountOut((Number(sim.amountOut) / 1e18).toFixed(6));
    setPriceImpact(sim.priceImpact);
    setMinReceived((Number(sim.minimumReceived) / 1e18).toFixed(6));
    setExecPrice(sim.executionPrice);
  };

  // Swap direction toggle
  const toggleSwapDirection = () => {
    const newDir = swapDirection === 'Q0_TO_TOKEN' ? 'TOKEN_TO_Q0' : 'Q0_TO_TOKEN';
    setSwapDirection(newDir);
    setSwapAmountIn('');
    setSwapAmountOut('');
    setPriceImpact('0.00%');
    setMinReceived('0');
  };

  // Execute Swap — atomic router flow (approve → swapExactTokensForTokens)
  const executeSwap = async () => {
    if (!walletAddress) {
      connectWallet();
      return;
    }

    if (!swapAmountIn || Number(swapAmountIn) <= 0) {
      setSwapError("Enter an amount to swap.");
      return;
    }

    setSwapLoading(true);
    setSwapError(null);
    setSwapTxHash(null);

    const provider = getQuaiProvider();
    if (!provider) {
      setSwapError("Pelagus / Quai provider not found. Please connect your wallet.");
      setSwapLoading(false);
      return;
    }

    // Determine token-in address and swap path through the router
    let tokenInAddress: string;
    let swapPath: string[];

    if (selectedPool === 'WQUAI') {
      if (swapDirection === 'Q0_TO_TOKEN') {
        tokenInAddress = CONTRACTS.Q0;
        swapPath = [CONTRACTS.Q0, CONTRACTS.WQUAI];
      } else {
        tokenInAddress = CONTRACTS.WQUAI;
        swapPath = [CONTRACTS.WQUAI, CONTRACTS.Q0];
      }
    } else if (selectedPool === 'BOSS') {
      if (swapDirection === 'Q0_TO_TOKEN') {
        tokenInAddress = CONTRACTS.Q0;
        swapPath = [CONTRACTS.Q0, CONTRACTS.BOSS];
      } else {
        tokenInAddress = CONTRACTS.BOSS;
        swapPath = [CONTRACTS.BOSS, CONTRACTS.Q0];
      }
    } else if (selectedPool === 'LAPTOP_WQUAI') {
      if (swapDirection === 'Q0_TO_TOKEN') {
        tokenInAddress = CONTRACTS.LAPTOP;
        swapPath = [CONTRACTS.LAPTOP, CONTRACTS.WQUAI];
      } else {
        tokenInAddress = CONTRACTS.WQUAI;
        swapPath = [CONTRACTS.WQUAI, CONTRACTS.LAPTOP];
      }
    } else if (selectedPool === 'LAPTOP_QGIRL') {
      if (swapDirection === 'Q0_TO_TOKEN') {
        tokenInAddress = CONTRACTS.LAPTOP;
        swapPath = [CONTRACTS.LAPTOP, CONTRACTS.QGIRL];
      } else {
        tokenInAddress = CONTRACTS.QGIRL;
        swapPath = [CONTRACTS.QGIRL, CONTRACTS.LAPTOP];
      }
    } else {
      // BOSS_QUAI — multi-hop routed through WQUAI
      if (swapDirection === 'Q0_TO_TOKEN') {
        // BOSS → WQUAI (via Q0 pool then WQUAI pool)
        tokenInAddress = CONTRACTS.BOSS;
        swapPath = [CONTRACTS.BOSS, CONTRACTS.Q0, CONTRACTS.WQUAI];
      } else {
        // WQUAI → BOSS (via Q0 pool then BOSS pool)
        tokenInAddress = CONTRACTS.WQUAI;
        swapPath = [CONTRACTS.WQUAI, CONTRACTS.Q0, CONTRACTS.BOSS];
      }
    }

    const amtInWei = BigInt(Math.floor(Number(swapAmountIn) * 1e18));
    const amtOutMinWei = BigInt(Math.floor(Number(minReceived) * 1e18));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 minutes

    try {
      // ── Step 1: Approve the Quainance Router to spend tokenIn ──────────────
      setPendingSwapStep('APPROVING');
      console.log(`[Swap] Approving router ${QUAINANCE_ROUTER} to spend ${amtInWei} of ${tokenInAddress}`);
      const approveData = encodeApprove(QUAINANCE_ROUTER, amtInWei);
      const approveTx = await sendWalletTransaction(provider, {
        from: walletAddress,
        to: tokenInAddress,
        data: approveData,
        gas: '0x186a0' // 100 000 gas
      });
      console.log("[Swap] Approve TX:", approveTx);
      await waitForTransaction(approveTx);

      // ── Step 2: Call swapExactTokensForTokens on the Router ────────────────
      setPendingSwapStep('SWAPPING');
      console.log(`[Swap] Calling swapExactTokensForTokens path=${JSON.stringify(swapPath)}`);
      const swapData = encodeRouterSwap(amtInWei, amtOutMinWei, swapPath, walletAddress, deadline);
      const swapTx = await sendWalletTransaction(provider, {
        from: walletAddress,
        to: QUAINANCE_ROUTER,
        data: swapData,
        gas: '0x4c4b4' // 313 524 gas (generous limit for multi-hop)
      });
      console.log("[Swap] Swap TX:", swapTx);
      setSwapTxHash(swapTx);
      await waitForTransaction(swapTx);

      // ── Success: Reload balances ────────────────────────────────────────────
      setPendingSwapStep('IDLE');
      loadWalletBalances(walletAddress);
      setTimeout(() => loadWalletBalances(walletAddress), 2000);
      setTimeout(() => {
        loadWalletBalances(walletAddress);
        fetchData(true);
      }, 5000);

    } catch (e: any) {
      console.error("[Swap] Failed:", e);
      setSwapError(parseSwapError(e));
      setPendingSwapStep('IDLE');
    } finally {
      setSwapLoading(false);
    }
  };

  // Switch Pool Tabs
  const selectPoolTab = (pool: 'WQUAI' | 'BOSS' | 'BOSS_QUAI' | 'LAPTOP_WQUAI' | 'LAPTOP_QGIRL') => {
    setSelectedPool(pool);
    setSwapAmountIn('');
    setSwapAmountOut('');
    setPriceImpact('0.00%');
    setMinReceived('0');
  };

  // Helper formatting for addresses
  const formatAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  // Math helper
  const formatUnits = (valStr: string) => {
    return (Number(valStr) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  const getFromSymbol = () => {
    if (selectedPool === 'BOSS_QUAI') {
      return swapDirection === 'Q0_TO_TOKEN' ? 'BOSS' : 'WQUAI';
    }
    if (selectedPool === 'LAPTOP_WQUAI') {
      return swapDirection === 'Q0_TO_TOKEN' ? 'LAPTOP' : 'WQUAI';
    }
    if (selectedPool === 'LAPTOP_QGIRL') {
      return swapDirection === 'Q0_TO_TOKEN' ? 'LAPTOP' : 'QGIRL';
    }
    return swapDirection === 'Q0_TO_TOKEN' ? 'Q0' : selectedPool;
  };

  const getToSymbol = () => {
    if (selectedPool === 'BOSS_QUAI') {
      return swapDirection === 'Q0_TO_TOKEN' ? 'WQUAI' : 'BOSS';
    }
    if (selectedPool === 'LAPTOP_WQUAI') {
      return swapDirection === 'Q0_TO_TOKEN' ? 'WQUAI' : 'LAPTOP';
    }
    if (selectedPool === 'LAPTOP_QGIRL') {
      return swapDirection === 'Q0_TO_TOKEN' ? 'QGIRL' : 'LAPTOP';
    }
    return swapDirection === 'Q0_TO_TOKEN' ? selectedPool : 'Q0';
  };


  // Loading Screen
  if (loading) {
    return (
      <div className="loader-container">
        <div className="loader"></div>
        <p style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--accent-neon)' }}>
          Loading Quai Blockchain Data...
        </p>
      </div>
    );
  }

  // Calculate prices
  const wquaiPrice = lpWquai ? (Number(lpWquai.reserve1) / Number(lpWquai.reserve0)) : 0;
  const bossPrice = lpBoss ? (Number(lpBoss.reserve1) / Number(lpBoss.reserve0)) : 0;

  return (
    <div className="app-container">
      {/* Top Header */}
      <header>
        <div className="brand-section">
          <img src="/0logov3.png" className="brand-logo" alt="Logo" />
          <div className="brand-title">
            <h1>Q0 ANALYTICS</h1>
            <p>Quai Network Contract & Swap Stats</p>
          </div>
        </div>

        <div className="wallet-section">
          <div className="network-status">
            <div className="status-dot"></div>
            Cyprus-1 Shard
          </div>

          {walletAddress ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', padding: '0.4rem 0.75rem', borderRadius: '8px', border: '1px solid var(--panel-border)', color: 'var(--accent-gold)', fontWeight: 600 }}>
                Gas: {quaiBalance} QUAI
              </span>
              <button className="btn-primary btn-wallet-connected">
                <Wallet size={16} />
                <span>{formatAddr(walletAddress)}</span>
              </button>
            </div>
          ) : (
            <button className="btn-primary" onClick={connectWallet} disabled={walletLoading}>
              <Wallet size={16} />
              <span>{walletLoading ? 'Connecting...' : 'Connect Wallet'}</span>
            </button>
          )}

          <button 
            className="btn-primary" 
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--panel-border)', color: 'var(--text-main)', boxShadow: 'none', padding: '0.6rem 0.8rem' }}
            onClick={() => fetchData(true)}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'loader' : ''} style={{ animationDuration: '2s' }} />
          </button>
        </div>
      </header>

      {/* Stats Cards Row */}
      <div className="stats-grid">
        <div className="glass-card stat-card">
          <div className="stat-header">
            <span>TOKEN NAME</span>
            <Coins size={18} className="stat-icon" />
          </div>
          <div>
            <div className="stat-value">{q0Meta?.name}</div>
            <div className="stat-sub">
              Symbol: {q0Meta?.symbol} | Decimals: {q0Meta?.decimals}
            </div>
          </div>
        </div>

        <div className="glass-card stat-card">
          <div className="stat-header">
            <span>TOTAL SUPPLY</span>
            <Activity size={18} className="stat-icon" />
          </div>
          <div>
            <div className="stat-value">
              {q0Meta ? (Number(q0Meta.totalSupply) / 1e18).toLocaleString() : '1,000,000,000'}
            </div>
            <div className="stat-sub">Max cap locked in contract</div>
          </div>
        </div>

        <div className="glass-card stat-card">
          <div className="stat-header">
            <span>ACTIVE HOLDERS</span>
            <Users size={18} className="stat-icon" />
          </div>
          <div>
            <div className="stat-value">{holderCount}</div>
            <div className="stat-sub">Addresses holding Q0 tokens</div>
          </div>
        </div>

        <div className="glass-card stat-card">
          <div className="stat-header">
            <span>LATEST BLOCK</span>
            <Database size={18} className="stat-icon" />
          </div>
          <div>
            <div className="stat-value">#{latestBlock}</div>
            <div className="stat-sub">Cyprus-1 block height</div>
          </div>
        </div>

        <div className="glass-card stat-card">
          <div className="stat-header">
            <span>USD PRICE / MARKET CAP</span>
            <TrendingUp size={18} className="stat-icon" />
          </div>
          <div>
            <div className="stat-value">
              {tokenDetail?.marketStats?.priceUsd ? `$${Number(tokenDetail.marketStats.priceUsd).toFixed(9)}` : '—'}
            </div>
            <div className="stat-sub">
              MCap: {tokenDetail?.marketStats?.marketCapUsd ? `$${Number(tokenDetail.marketStats.marketCapUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'} (explorer.qu.ai)
            </div>
          </div>
        </div>
      </div>

      {/* Main Panels Layout */}
      <div className="dashboard-sections">
        {/* Left Side: Liquidity Pools and Swaps */}
        <div className="side-panel">
          {/* Pools Cards */}
          <div className="glass-card">
            <h2 className="section-title">
              <TrendingUp size={20} style={{ color: 'var(--accent-neon)' }} />
              Quaiswap Liquidity Pools
            </h2>

            {/* Pool 1: Q0 / WQUAI */}
            <div style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="lp-header">
                <div className="lp-title">
                  <span>Q0 / WQUAI LP</span>
                </div>
                <div className="lp-badges" style={{ alignItems: 'center', gap: '0.5rem' }}>
                  <span className="lp-badge lp-badge-address">{formatAddr(CONTRACTS.LP_WQUAI)}</span>
                  <button 
                    className="btn-primary" 
                    style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer' }}
                    onClick={() => {
                      selectPoolTab('WQUAI');
                      document.querySelector('.swap-card')?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    <ArrowUpDown size={12} /> Swap WQUAI
                  </button>
                </div>
              </div>
              <div className="lp-reserves-row">
                <div className="lp-reserve-box">
                  <div className="lp-reserve-label">Q0 Reserve</div>
                  <div className="lp-reserve-value">{lpWquai ? formatUnits(lpWquai.reserve0) : '0'}</div>
                </div>
                <div className="lp-reserve-box">
                  <div className="lp-reserve-label">WQUAI Reserve</div>
                  <div className="lp-reserve-value">{lpWquai ? formatUnits(lpWquai.reserve1) : '0'}</div>
                </div>
              </div>
              <div className="lp-price-metric">
                <span className="lp-price-label">Token Exchange Rate</span>
                <span className="lp-price-value">
                  1 Q0 = {wquaiPrice.toFixed(8)} WQUAI &nbsp;|&nbsp; 1 WQUAI = {wquaiPrice > 0 ? (1/wquaiPrice).toLocaleString(undefined, { maximumFractionDigits: 2 }) : 0} Q0
                </span>
              </div>
            </div>

            {/* Pool 2: Q0 / BOSS */}
            <div style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="lp-header">
                <div className="lp-title">
                  <span>Q0 / BOSS LP</span>
                </div>
                <div className="lp-badges" style={{ alignItems: 'center', gap: '0.5rem' }}>
                  <span className="lp-badge lp-badge-address">{formatAddr(CONTRACTS.LP_BOSS)}</span>
                  <button 
                    className="btn-primary" 
                    style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-violet) 0%, #a855f7 100%)', color: '#fff !important' }}
                    onClick={() => {
                      selectPoolTab('BOSS');
                      document.querySelector('.swap-card')?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    <ArrowUpDown size={12} /> Swap Q0 / BOSS
                  </button>
                </div>
              </div>
              <div className="lp-reserves-row">
                <div className="lp-reserve-box">
                  <div className="lp-reserve-label">Q0 Reserve</div>
                  <div className="lp-reserve-value">{lpBoss ? formatUnits(lpBoss.reserve0) : '0'}</div>
                </div>
                <div className="lp-reserve-box">
                  <div className="lp-reserve-label">BOSS Reserve</div>
                  <div className="lp-reserve-value">{lpBoss ? formatUnits(lpBoss.reserve1) : '0'}</div>
                </div>
              </div>
              <div className="lp-price-metric">
                <span className="lp-price-label">Token Exchange Rate</span>
                <span className="lp-price-value">
                  1 Q0 = {bossPrice.toFixed(5)} BOSS &nbsp;|&nbsp; 1 BOSS = {bossPrice > 0 ? (1/bossPrice).toLocaleString(undefined, { maximumFractionDigits: 2 }) : 0} Q0
                </span>
              </div>
            </div>

            {/* Pool 3: BOSS / QUAI (Multi-Hop) */}
            <div>
              <div className="lp-header">
                <div className="lp-title">
                  <span>BOSS / QUAI (Routed)</span>
                </div>
                <div className="lp-badges" style={{ alignItems: 'center', gap: '0.5rem' }}>
                  <span className="lp-badge lp-badge-address">Multi-Hop LP</span>
                  <button 
                    className="btn-primary" 
                    style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-gold) 0%, #f59e0b 100%)', color: '#000 !important' }}
                    onClick={() => {
                      selectPoolTab('BOSS_QUAI');
                      document.querySelector('.swap-card')?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    <ArrowUpDown size={12} /> Swap BOSS / QUAI
                  </button>
                </div>
              </div>
              <div className="lp-reserves-row">
                <div className="lp-reserve-box">
                  <div className="lp-reserve-label">BOSS Reserve (LP 2)</div>
                  <div className="lp-reserve-value">{lpBoss ? formatUnits(lpBoss.reserve1) : '0'}</div>
                </div>
                <div className="lp-reserve-box">
                  <div className="lp-reserve-label">WQUAI Reserve (LP 1)</div>
                  <div className="lp-reserve-value">{lpWquai ? formatUnits(lpWquai.reserve1) : '0'}</div>
                </div>
              </div>
              <div className="lp-price-metric">
                <span className="lp-price-label">Cross-Pair Rate</span>
                <span className="lp-price-value">
                  1 BOSS = {(wquaiPrice > 0 ? (bossPrice / wquaiPrice) : 0).toFixed(6)} WQUAI &nbsp;|&nbsp; 1 WQUAI = {(bossPrice > 0 ? (wquaiPrice / bossPrice) : 0).toFixed(2)} BOSS
                </span>
              </div>
            </div>
          </div>

          {/* Quainance DEX Card (new explorer.qu.ai API - https://explorer.qu.ai/api-docs) */}
          <div className="glass-card">
            <h2 className="section-title">
              <TrendingUp size={20} style={{ color: 'var(--accent-gold)' }} />
              Quainance DEX &mdash; LAPTOP Pairs
              {quainanceTvl?.stale && (
                <span className="lp-badge" style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', border: '1px solid rgba(245, 158, 11, 0.2)', fontSize: '0.6rem', marginLeft: '0.5rem' }}>STALE</span>
              )}
            </h2>
            <div className="lp-price-metric" style={{ marginBottom: '1rem' }}>
              <span className="lp-price-label">Network-Wide Quainance TVL</span>
              <span className="lp-price-value">${Number(quainanceTvl?.current?.tvlUsd || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>

            {(quainanceTvl ? findQuainancePools(quainanceTvl, CONTRACTS.LAPTOP) : []).map((pool, idx, arr) => {
              const laptopIsToken0 = pool.token0.address.toLowerCase() === CONTRACTS.LAPTOP.toLowerCase();
              const otherSymbol = laptopIsToken0 ? pool.token1.symbol : pool.token0.symbol;
              const laptopReserve = laptopIsToken0 ? pool.reserve0 : pool.reserve1;
              const otherReserve = laptopIsToken0 ? pool.reserve1 : pool.reserve0;
              const rate = Number(otherReserve) / Number(laptopReserve);
              return (
                <div key={pool.address} style={{ marginBottom: idx === arr.length - 1 ? 0 : '1.5rem', paddingBottom: idx === arr.length - 1 ? 0 : '1.5rem', borderBottom: idx === arr.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="lp-header">
                    <div className="lp-title">
                      <span>{pool.name}</span>
                    </div>
                    <div className="lp-badges" style={{ alignItems: 'center', gap: '0.5rem' }}>
                      <span className="lp-badge lp-badge-address">{formatAddr(pool.address)}</span>
                      <button
                        className="btn-primary"
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer' }}
                        onClick={() => {
                          const tab = pool.name === 'LAPTOP/QGIRL' ? 'LAPTOP_QGIRL' : 'LAPTOP_WQUAI';
                          selectPoolTab(tab);
                          const el = document.querySelector('.swap-card');
                          if (el) el.scrollIntoView({ behavior: 'smooth' });
                        }}
                      >
                        Trade
                      </button>
                      <a
                        href={`https://explorer.qu.ai/address/${pool.address}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-primary"
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', textDecoration: 'none' }}
                      >
                        <ExternalLink size={12} /> View Pool
                      </a>
                    </div>
                  </div>
                  <div className="lp-reserves-row">
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">LAPTOP Reserve</div>
                      <div className="lp-reserve-value">{Number(laptopReserve).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                    </div>
                    <div className="lp-reserve-box">
                      <div className="lp-reserve-label">{otherSymbol} Reserve</div>
                      <div className="lp-reserve-value">{Number(otherReserve).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                    </div>
                  </div>
                  <div className="lp-price-metric">
                    <span className="lp-price-label">Pool Stats</span>
                    <span className="lp-price-value">
                      1 LAPTOP = {rate.toFixed(6)} {otherSymbol} &nbsp;|&nbsp; TVL ${Number(pool.tvlUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })} &nbsp;|&nbsp; 24h Vol ${Number(pool.volume24hUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              );
            })}
            {(!quainanceTvl || findQuainancePools(quainanceTvl, CONTRACTS.LAPTOP).length === 0) && (
              <div className="dimmed-text">No indexed LAPTOP pools found on Quainance right now.</div>
            )}
          </div>

          {/* Swap Module Card */}
          <div className="glass-card swap-card">
            <div className="swap-title">
              <ArrowUpDown size={22} style={{ color: 'var(--accent-violet)' }} />
              Swap Module
            </div>

            {/* Selector Tabs */}
            <div className="pool-selector-tabs" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.5rem' }}>
              <button 
                className={`pool-tab-btn ${selectedPool === 'WQUAI' ? 'active' : ''}`}
                onClick={() => selectPoolTab('WQUAI')}
              >
                Q0 / WQUAI
              </button>
              <button 
                className={`pool-tab-btn ${selectedPool === 'BOSS' ? 'active' : ''}`}
                onClick={() => selectPoolTab('BOSS')}
              >
                Q0 / BOSS
              </button>
              <button 
                className={`pool-tab-btn ${selectedPool === 'BOSS_QUAI' ? 'active' : ''}`}
                onClick={() => selectPoolTab('BOSS_QUAI')}
              >
                BOSS / QUAI
              </button>
              <button 
                className={`pool-tab-btn ${selectedPool === 'LAPTOP_WQUAI' ? 'active' : ''}`}
                onClick={() => selectPoolTab('LAPTOP_WQUAI')}
              >
                LAPTOP / WQUAI
              </button>
              <button 
                className={`pool-tab-btn ${selectedPool === 'LAPTOP_QGIRL' ? 'active' : ''}`}
                onClick={() => selectPoolTab('LAPTOP_QGIRL')}
              >
                LAPTOP / QGIRL
              </button>
            </div>

            {/* Input In */}
            <div className="swap-input-group">
              <div className="swap-input-header">
                <span>From</span>
                {walletAddress && (
                  <span>
                    Balance: {getBalanceForToken(getFromSymbol())}
                  </span>
                )}
              </div>
              <div className="swap-input-row">
                <input 
                  type="number" 
                  className="swap-field" 
                  placeholder="0.0" 
                  value={swapAmountIn}
                  onChange={(e) => handleAmountInChange(e.target.value)}
                />
                <div className="token-select-trigger">
                  {getFromSymbol()}
                </div>
              </div>
            </div>

            {/* Middle Switch Arrow */}
            <div className="swap-arrow-container">
              <button className="swap-arrow-btn" onClick={toggleSwapDirection}>
                <ArrowUpDown size={16} />
              </button>
            </div>

            {/* Input Out */}
            <div className="swap-input-group">
              <div className="swap-input-header">
                <span>To (Estimated)</span>
                {walletAddress && (
                  <span>
                    Balance: {getBalanceForToken(getToSymbol())}
                  </span>
                )}
              </div>
              <div className="swap-input-row">
                <input 
                  type="number" 
                  className="swap-field" 
                  placeholder="0.0" 
                  value={swapAmountOut}
                  readOnly 
                />
                <div className="token-select-trigger">
                  {getToSymbol()}
                </div>
              </div>
            </div>

            {/* Detail Sheet */}
            <div className="swap-details">
              <div className="swap-detail-row">
                <span className="swap-detail-label">Execution Price</span>
                <span className="swap-detail-value">{execPrice} {getToSymbol()} per {getFromSymbol()}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Price Impact</span>
                <span className={`swap-detail-value ${
                  parseFloat(priceImpact) < 1 ? 'impact-green' : (parseFloat(priceImpact) < 5 ? 'impact-orange' : 'impact-red')
                }`}>{priceImpact}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Minimum Received</span>
                <span className="swap-detail-value">{minReceived} {getToSymbol()}</span>
              </div>
              <div className="swap-detail-row" style={{ alignItems: 'center' }}>
                <span className="swap-detail-label">Slippage Tolerance</span>
                <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                  {[0.1, 0.5, 1.0, 2.0].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      style={{
                        background: slippage === preset ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                        border: slippage === preset ? '1px solid var(--accent-neon)' : '1px solid var(--panel-border)',
                        color: slippage === preset ? 'var(--accent-neon)' : 'var(--text-muted)',
                        borderRadius: '4px',
                        padding: '0.15rem 0.4rem',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease'
                      }}
                      onClick={() => {
                        setSlippage(preset);
                        setTimeout(() => handleAmountInChange(swapAmountIn), 10);
                      }}
                    >
                      {preset}%
                    </button>
                  ))}
                  <input 
                    type="number" 
                    value={slippage} 
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setSlippage(isNaN(val) ? 1.0 : val);
                      setTimeout(() => handleAmountInChange(swapAmountIn), 10);
                    }}
                    style={{ background: 'transparent', border: '1px solid var(--panel-border)', borderRadius: '4px', width: '45px', color: 'inherit', fontSize: '0.75rem', textAlign: 'center', outline: 'none', marginLeft: '0.25rem' }}
                  />
                  <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>%</span>
                </div>
              </div>
            </div>

            {/* Step 1: Approving router allowance */}
            {pendingSwapStep === 'APPROVING' && (
              <div style={{ background: 'rgba(0, 242, 254, 0.05)', border: '1px solid rgba(0, 242, 254, 0.15)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="loader" style={{ width: '24px', height: '24px', borderWidth: '2px', margin: 0 }}></div>
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>Step 1 of 2: Approving Router…</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Authorising the Quainance Router to spend your tokens (one-time per swap)</div>
                </div>
              </div>
            )}

            {/* Step 2: Router executing the swap */}
            {pendingSwapStep === 'SWAPPING' && (
              <div style={{ background: 'rgba(138, 43, 226, 0.06)', border: '1px solid rgba(138, 43, 226, 0.2)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="loader" style={{ width: '24px', height: '24px', borderWidth: '2px', margin: 0 }}></div>
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>Step 2 of 2: Swap executing on-chain…</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Quainance Router is routing the swap atomically — no MEV window</div>
                </div>
              </div>
            )}

            {/* Messages */}
            {swapTxHash && (
              <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.2)', padding: '0.75rem 1rem', borderRadius: '10px', fontSize: '0.8rem', color: 'var(--success)', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>Swap Successful!</strong>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>Tx: {formatAddr(swapTxHash)}</div>
                </div>
                <a href={`https://quaiscan.io/tx/${swapTxHash}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-neon)' }}>
                  <ExternalLink size={14} />
                </a>
              </div>
            )}

            {swapError && (
              <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '0.75rem 1rem', borderRadius: '10px', fontSize: '0.8rem', color: 'var(--error)', marginBottom: '1rem' }}>
                {swapError}
              </div>
            )}

            {/* Swap Button */}
            <button 
              className="btn-primary btn-swap-submit" 
              onClick={executeSwap}
              disabled={swapLoading || pendingSwapStep !== 'IDLE'}
              style={{ justifyContent: 'center' }}
            >
              {pendingSwapStep === 'APPROVING'
                ? 'Approving…'
                : pendingSwapStep === 'SWAPPING'
                ? 'Swapping…'
                : (walletAddress ? 'Confirm Swap' : 'Connect Wallet to Swap')}
            </button>
            <div className="dimmed-text">
              Atomic Router Swaps via Quainance Router on Cyprus-1.
            </div>
          </div>
        </div>

        {/* Right Side: Ledger and Holders */}
        <div className="side-panel">
          {/* Top Holders */}
          <div className="glass-card">
            <h2 className="section-title">
              <Award size={20} style={{ color: 'var(--accent-gold)' }} />
              Top Token Holders
            </h2>

            <div className="holders-list">
              {topHolders.map((holder, index) => (
                <div className="holder-row" key={holder.address}>
                  <div className="holder-info">
                    <span className="holder-rank">#{index + 1}</span>
                    <span className="holder-address">{formatAddr(holder.address)}</span>
                    {holder.address.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() && (
                      <span className="lp-badge" style={{ background: 'rgba(0, 242, 254, 0.08)', color: 'var(--accent-neon)', border: '1px solid rgba(0, 242, 254, 0.15)', fontSize: '0.6rem' }}>LP 1</span>
                    )}
                    {holder.address.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase() && (
                      <span className="lp-badge" style={{ background: 'rgba(138, 43, 226, 0.08)', color: '#a855f7', border: '1px solid rgba(138, 43, 226, 0.15)', fontSize: '0.6rem' }}>LP 2</span>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="holder-balance">{holder.balance} Q0</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{holder.pct} of supply</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Ledger of Recent Transfers */}
          <div className="glass-card">
            <h2 className="section-title">
              <Activity size={20} style={{ color: 'var(--accent-neon)' }} />
              On-Chain Transaction Ledger
            </h2>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Tx Hash</th>
                    <th>From</th>
                    <th>To</th>
                    <th style={{ textAlign: 'right' }}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.slice(0, 10).map((tx, idx) => {
                    const isLpFrom = tx.from_addr.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() || tx.from_addr.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase();
                    const isLpTo = tx.to_addr.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() || tx.to_addr.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase();

                    return (
                      <tr key={`${tx.tx_hash}-${idx}`}>
                        <td>
                          <a
                            href={`https://explorer.qu.ai/tx/${tx.tx_hash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="link-hash"
                          >
                            {formatAddr(tx.tx_hash)}
                          </a>
                        </td>
                        <td>
                          <span className={`address-badge ${isLpFrom ? 'lp' : ''}`}>
                            {isLpFrom ? 'LP Pair' : formatAddr(tx.from_addr)}
                          </span>
                        </td>
                        <td>
                          <span className={`address-badge ${isLpTo ? 'lp' : ''}`}>
                            {isLpTo ? 'LP Pair' : formatAddr(tx.to_addr)}
                          </span>
                        </td>
                        <td className="tx-value" style={{ textAlign: 'right', color: isLpFrom ? 'var(--success)' : (isLpTo ? 'var(--accent-neon)' : 'inherit') }}>
                          {(Number(tx.value) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })} Q0
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="dimmed-text">
              Showing the latest 10 transfer events from block explorer.
            </div>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <footer style={{ marginTop: '3rem', paddingTop: '1.5rem', borderTop: '1px solid var(--panel-border)', display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
        <div>
          Q0 Contract: <a href={`https://quaiscan.io/token/${CONTRACTS.Q0}`} target="_blank" rel="noreferrer" className="link-hash">{CONTRACTS.Q0}</a>
        </div>
        <div>
          Powered by Quai RPC & Quaiscan APIs. Pair Swaps deployable on Cyprus-1.
        </div>
      </footer>
    </div>
  );
}
