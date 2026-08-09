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
  getTokenMetadata, 
  getLPReserves, 
  getLatestBlockNumber, 
  getTokenTransfers, 
  getHolderCount, 
  simulateSwap,
  getTokenBalance,
  getQuaiBalance,
  quaiRpcCall,
  TokenMetadata,
  LPReserves,
  TransferEvent
} from 'quai-service';

export default function App() {
  // Wallet States
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [q0Balance, setQ0Balance] = useState<string>('0');
  const [wquaiBalance, setWquaiBalance] = useState<string>('0');
  const [bossBalance, setBossBalance] = useState<string>('0');
  const [quaiBalance, setQuaiBalance] = useState<string>('0');
  const [walletLoading, setWalletLoading] = useState<boolean>(false);

  // General Chain & Contract States
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [q0Meta, setQ0Meta] = useState<TokenMetadata | null>(null);
  const [holderCount, setHolderCount] = useState<number>(0);
  const [latestBlock, setLatestBlock] = useState<number>(0);
  const [transfers, setTransfers] = useState<TransferEvent[]>([]);

  // LP Pool States
  const [lpWquai, setLpWquai] = useState<LPReserves | null>(null);
  const [lpBoss, setLpBoss] = useState<LPReserves | null>(null);
  
  // Swap States
  const [selectedPool, setSelectedPool] = useState<'WQUAI' | 'BOSS'>('WQUAI');
  const [swapAmountIn, setSwapAmountIn] = useState<string>('');
  const [swapAmountOut, setSwapAmountOut] = useState<string>('');
  const [slippage, setSlippage] = useState<number>(0.5);
  const [priceImpact, setPriceImpact] = useState<string>('0.00%');
  const [minReceived, setMinReceived] = useState<string>('0');
  const [execPrice, setExecPrice] = useState<string>('0');
  const [swapDirection, setSwapDirection] = useState<'Q0_TO_TOKEN' | 'TOKEN_TO_Q0'>('Q0_TO_TOKEN');
  const [swapLoading, setSwapLoading] = useState<boolean>(false);
  const [swapTxHash, setSwapTxHash] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  // Recovery States
  const [pendingTransferTx, setPendingTransferTx] = useState<string | null>(null);
  const [pendingSwapStep, setPendingSwapStep] = useState<'IDLE' | 'WAITING_FOR_CONFIRMATION' | 'READY_TO_CLAIM' | 'CLAIMING'>('IDLE');
  const [claimMinReceived, setClaimMinReceived] = useState<string>('0');
  const [claimPool, setClaimPool] = useState<'WQUAI' | 'BOSS'>('WQUAI');
  const [claimDirection, setClaimDirection] = useState<'Q0_TO_TOKEN' | 'TOKEN_TO_Q0'>('TOKEN_TO_Q0');
  const [manualTxHash, setManualTxHash] = useState<string>('');
  const [showRecoveryBox, setShowRecoveryBox] = useState<boolean>(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  // Load pending transfer from localStorage on mount
  useEffect(() => {
    const savedTx = localStorage.getItem('pendingTransferTx');
    const savedStep = localStorage.getItem('pendingSwapStep');
    const savedMinReceived = localStorage.getItem('claimMinReceived');
    const savedPool = localStorage.getItem('claimPool');
    const savedDirection = localStorage.getItem('claimDirection');
    if (savedTx && savedStep) {
      setPendingTransferTx(savedTx);
      setPendingSwapStep(savedStep as any);
      if (savedMinReceived) setClaimMinReceived(savedMinReceived);
      if (savedPool) setClaimPool(savedPool as any);
      if (savedDirection) setClaimDirection(savedDirection as any);
    }
  }, []);

  const savePendingSwap = (tx: string, step: string, minRec: string, pool: string, dir: string) => {
    localStorage.setItem('pendingTransferTx', tx);
    localStorage.setItem('pendingSwapStep', step);
    localStorage.setItem('claimMinReceived', minRec);
    localStorage.setItem('claimPool', pool);
    localStorage.setItem('claimDirection', dir);
    setPendingTransferTx(tx);
    setPendingSwapStep(step as any);
    setClaimMinReceived(minRec);
    setClaimPool(pool as any);
    setClaimDirection(dir as any);
  };

  const clearPendingSwap = () => {
    localStorage.removeItem('pendingTransferTx');
    localStorage.removeItem('pendingSwapStep');
    localStorage.removeItem('claimMinReceived');
    localStorage.removeItem('claimPool');
    localStorage.removeItem('claimDirection');
    setPendingTransferTx(null);
    setPendingSwapStep('IDLE');
  };

  const waitForTransaction = async (txHash: string): Promise<any> => {
    const maxAttempts = 45; // 45 seconds max wait
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
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("Transaction was not mined within 45 seconds.");
  };

  const parseSwapError = (err: any): string => {
    const msg = err.message || String(err);
    if (msg.toLowerCase().includes("insufficient funds")) {
      return "⚠️ Insufficient QUAI for Gas: You need more native QUAI in your wallet to cover the network transaction fee (estimated ~1.9 QUAI at current gas prices).";
    }
    return msg || "Transaction rejected or execution reverted.";
  };

  const claimPendingSwap = async () => {
    if (!walletAddress || !pendingTransferTx) return;
    setSwapLoading(true);
    setSwapError(null);
    setPendingSwapStep('CLAIMING');
    try {
      const provider = window.ethereum || window.pelagus;
      const lpAddr = claimPool === 'WQUAI' ? CONTRACTS.LP_WQUAI : CONTRACTS.LP_BOSS;

      let amt0Out = '0';
      let amt1Out = claimMinReceived;
      if (claimDirection === 'TOKEN_TO_Q0') {
        amt0Out = claimMinReceived;
        amt1Out = '0';
      }

      const cleanAmt0 = BigInt(amt0Out).toString(16).padStart(64, '0');
      const cleanAmt1 = BigInt(amt1Out).toString(16).padStart(64, '0');
      const cleanUser = walletAddress.replace('0x', '').padStart(64, '0');
      const dataOffset = '0000000000000000000000000000000000000000000000000000000000000080';
      const dataLen = '0000000000000000000000000000000000000000000000000000000000000000';
      
      const swapData = '0x022c0d9f' + cleanAmt0 + cleanAmt1 + cleanUser + dataOffset + dataLen;

      console.log("Sending Swap transaction (Claim mode)...");
      const swapTx = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddress,
          to: lpAddr,
          data: swapData,
          gas: '0x1d4c0'
        }]
      });

      setSwapTxHash(swapTx);
      clearPendingSwap();
      loadWalletBalances(walletAddress);
      setTimeout(() => loadWalletBalances(walletAddress), 2000);
      setTimeout(() => {
        loadWalletBalances(walletAddress);
        fetchData(true);
      }, 5000);

    } catch (e: any) {
      console.error("Claim Transaction failed:", e);
      setSwapError(parseSwapError(e));
      setPendingSwapStep('READY_TO_CLAIM');
    } finally {
      setSwapLoading(false);
    }
  };

  const handleManualRecovery = async () => {
    if (!manualTxHash) {
      setRecoveryError("Enter a transaction hash.");
      return;
    }
    setRecoveryError(null);
    try {
      const receipt = await quaiRpcCall('quai_getTransactionReceipt', [manualTxHash]);
      if (!receipt) {
        setRecoveryError("Transaction receipt not found. Check the hash and network.");
        return;
      }
      
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      let foundLog = null;
      let poolType: 'WQUAI' | 'BOSS' = 'WQUAI';
      let direction: 'Q0_TO_TOKEN' | 'TOKEN_TO_Q0' = 'TOKEN_TO_Q0';

      if (receipt.logs) {
        for (const log of receipt.logs) {
          if (log.topics && log.topics[0] === transferTopic) {
            const toAddress = '0x' + log.topics[2].slice(-40).toLowerCase();
            if (toAddress === CONTRACTS.LP_WQUAI.toLowerCase()) {
              foundLog = log;
              poolType = 'WQUAI';
              break;
            } else if (toAddress === CONTRACTS.LP_BOSS.toLowerCase()) {
              foundLog = log;
              poolType = 'BOSS';
              break;
            }
          }
        }
      }

      if (!foundLog) {
        setRecoveryError("No token transfer to Q0/WQUAI or Q0/BOSS LP contract found in this transaction.");
        return;
      }

      const tokenAddress = foundLog.address.toLowerCase();
      const amtInWei = BigInt(foundLog.data.startsWith('0x') ? foundLog.data : '0x' + foundLog.data).toString();

      if (tokenAddress === CONTRACTS.Q0.toLowerCase()) {
        direction = 'Q0_TO_TOKEN';
      } else {
        direction = 'TOKEN_TO_Q0';
      }

      const currentLP = poolType === 'WQUAI' ? lpWquai : lpBoss;
      if (!currentLP) {
        setRecoveryError("Failed to fetch current LP reserves.");
        return;
      }

      let reserveIn = currentLP.reserve0;
      let reserveOut = currentLP.reserve1;
      if (direction === 'TOKEN_TO_Q0') {
        reserveIn = currentLP.reserve1;
        reserveOut = currentLP.reserve0;
      }

      const sim = simulateSwap(amtInWei, reserveIn, reserveOut, 1.0);
      
      savePendingSwap(
        manualTxHash,
        'READY_TO_CLAIM',
        sim.minimumReceived,
        poolType,
        direction
      );
      
      setShowRecoveryBox(false);
      setManualTxHash('');
      setSwapError(null);
    } catch (e: any) {
      console.error("Recovery failed:", e);
      setRecoveryError("Failed to parse transaction: " + e.message);
    }
  };

  // Top Holders (parsed from transfers for visual representation)
  const [topHolders, setTopHolders] = useState<{address: string, balance: string, pct: string}[]>([]);

  // Fetch all on-chain data
  const fetchData = useCallback(async (isRefresh: boolean = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      // 1. Get Token Metadata, reserves, block number
      const [meta, wquaiRes, bossRes, blockNum, listTransfers, holders] = await Promise.all([
        getTokenMetadata(CONTRACTS.Q0),
        getLPReserves(CONTRACTS.LP_WQUAI),
        getLPReserves(CONTRACTS.LP_BOSS),
        getLatestBlockNumber(),
        getTokenTransfers(CONTRACTS.Q0, '/api-explorer'),
        getHolderCount(CONTRACTS.Q0, '/api-explorer')
      ]);

      setQ0Meta(meta);
      setLpWquai(wquaiRes);
      setLpBoss(bossRes);
      setLatestBlock(blockNum);
      setTransfers(listTransfers);
      setHolderCount(holders || 34); // Fallback to 34 holders if API fails

      // Parse top holders from transfer list dynamically
      const balances: { [key: string]: bigint } = {};
      listTransfers.forEach(tx => {
        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const val = BigInt(tx.value);
        if (from && from !== '0x0000000000000000000000000000000000000000') {
          balances[from] = (balances[from] || 0n) - val;
        }
        if (to) {
          balances[to] = (balances[to] || 0n) + val;
        }
      });

      // Filter out address 0x01 (burn/system) and sort
      const sorted = Object.entries(balances)
        .filter(([addr, bal]) => bal > 0n && addr !== '0x0000000000000000000000000000000000000000')
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
        .slice(0, 8);

      const parsedHolders = sorted.map(([addr, bal]) => {
        const pct = ((Number(bal) / 1e27) * 100).toFixed(2); // 1e27 is total supply (1B * 1e18)
        return {
          address: addr,
          balance: (Number(bal) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 }),
          pct: pct + '%'
        };
      });
      setTopHolders(parsedHolders);

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
      const [q0Bal, wquaiBal, bossBal, quaiBal] = await Promise.all([
        getTokenBalance(CONTRACTS.Q0, addr),
        getTokenBalance(CONTRACTS.WQUAI, addr),
        getTokenBalance(CONTRACTS.BOSS, addr),
        getQuaiBalance(addr)
      ]);
      setQ0Balance((Number(q0Bal) / 1e18).toFixed(4));
      setWquaiBalance((Number(wquaiBal) / 1e18).toFixed(4));
      setBossBalance((Number(bossBal) / 1e18).toFixed(4));
      setQuaiBalance((Number(quaiBal) / 1e18).toFixed(4));
    } catch (e) {
      console.error("Error fetching wallet balance:", e);
    }
  }, []);

  const getBalanceForToken = (symbol: string) => {
    if (symbol === 'Q0') return q0Balance;
    if (symbol === 'WQUAI') return wquaiBalance;
    if (symbol === 'BOSS') return bossBalance;
    return '0.0000';
  };

  useEffect(() => {
    if (walletAddress) {
      loadWalletBalances(walletAddress);
    }
  }, [walletAddress, loadWalletBalances]);

  // Wallet connection helper
  const connectWallet = async () => {
    const provider = window.ethereum || window.pelagus;
    if (!provider) {
      alert("Pelagus Wallet or MetaMask not found. Please install the Pelagus wallet extension to interact with Quai Network.");
      return;
    }

    setWalletLoading(true);
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (accounts && accounts.length > 0) {
        setWalletAddress(accounts[0]);
        // Setup listener
        provider.on('accountsChanged', (newAccounts: string[]) => {
          if (newAccounts.length > 0) setWalletAddress(newAccounts[0]);
          else setWalletAddress(null);
        });
      }
    } catch (e: any) {
      console.error("Wallet connection failed:", e);
      alert("Failed to connect wallet: " + e.message);
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

    const currentLP = selectedPool === 'WQUAI' ? lpWquai : lpBoss;
    if (!currentLP) return;

    // Convert decimal input to Wei
    const amtWei = BigInt(Math.floor(Number(val) * 1e18));
    
    // Determine which reserves are In vs Out
    let reserveIn = currentLP.reserve0; // Q0
    let reserveOut = currentLP.reserve1; // WQUAI or BOSS
    
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

  // Execute Swap transaction
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

    const provider = window.ethereum || window.pelagus;
    const lpAddr = selectedPool === 'WQUAI' ? CONTRACTS.LP_WQUAI : CONTRACTS.LP_BOSS;
    const targetToken = selectedPool === 'WQUAI' ? CONTRACTS.WQUAI : CONTRACTS.BOSS;

    // Swap Details
    const amtInWei = BigInt(Math.floor(Number(swapAmountIn) * 1e18)).toString();
    const amtOutMinWei = BigInt(Math.floor(Number(minReceived) * 1e18)).toString();

    let tokenInAddress = CONTRACTS.Q0;
    if (swapDirection === 'TOKEN_TO_Q0') {
      tokenInAddress = targetToken;
    }

    try {
      // Step 1: Send Transfer transaction to LP
      setPendingSwapStep('WAITING_FOR_CONFIRMATION');
      console.log(`Swapping ${swapAmountIn} via LP contract: ${lpAddr}`);

      // ERC20 Transfer selector: transfer(address,uint256) -> 0xa9059cbb
      const cleanLPAddr = lpAddr.replace('0x', '').padStart(64, '0');
      const cleanAmt = BigInt(amtInWei).toString(16).padStart(64, '0');
      const transferData = '0xa9059cbb' + cleanLPAddr + cleanAmt;

      console.log("Sending Transfer transaction to LP...");
      const transferTx = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddress,
          to: tokenInAddress,
          data: transferData,
          gas: '0xc350' // 50,000 gas limit
        }]
      });

      console.log("Transfer TX Hash:", transferTx);
      
      // Save state in case step 2 fails
      savePendingSwap(
        transferTx,
        'READY_TO_CLAIM',
        amtOutMinWei,
        selectedPool,
        swapDirection
      );

      // Wait for receipt confirmation
      console.log("Waiting for transfer transaction to be mined...");
      await waitForTransaction(transferTx);
      console.log("Transfer confirmed! Initiating swap call...");

      // Step 2: Trigger swap call on the LP
      let amt0Out = '0';
      let amt1Out = amtOutMinWei;
      if (swapDirection === 'TOKEN_TO_Q0') {
        amt0Out = amtOutMinWei;
        amt1Out = '0';
      }

      const cleanAmt0 = BigInt(amt0Out).toString(16).padStart(64, '0');
      const cleanAmt1 = BigInt(amt1Out).toString(16).padStart(64, '0');
      const cleanUser = walletAddress.replace('0x', '').padStart(64, '0');
      const dataOffset = '0000000000000000000000000000000000000000000000000000000000000080';
      const dataLen = '0000000000000000000000000000000000000000000000000000000000000000';
      
      const swapData = '0x022c0d9f' + cleanAmt0 + cleanAmt1 + cleanUser + dataOffset + dataLen;

      console.log("Sending Swap transaction...");
      const swapTx = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddress,
          to: lpAddr,
          data: swapData,
          gas: '0x1d4c0' // 120,000 gas limit
        }]
      });

      setSwapTxHash(swapTx);
      clearPendingSwap();
      loadWalletBalances(walletAddress);
      setTimeout(() => loadWalletBalances(walletAddress), 2000);
      setTimeout(() => {
        loadWalletBalances(walletAddress);
        fetchData(true);
      }, 5000);

    } catch (e: any) {
      console.error("Swap Transaction failed:", e);
      setSwapError(parseSwapError(e));
      // If we already successfully transferred tokens, stay in READY_TO_CLAIM step
      if (localStorage.getItem('pendingTransferTx')) {
        setPendingSwapStep('READY_TO_CLAIM');
      } else {
        setPendingSwapStep('IDLE');
      }
    } finally {
      setSwapLoading(false);
    }
  };

  // Switch Pool Tabs
  const selectPoolTab = (pool: 'WQUAI' | 'BOSS') => {
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
            <div>
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
          </div>

          {/* Swap Module Card */}
          <div className="glass-card swap-card">
            <div className="swap-title">
              <ArrowUpDown size={22} style={{ color: 'var(--accent-violet)' }} />
              Swap Module
            </div>

            {/* Selector Tabs */}
            <div className="pool-selector-tabs">
              <button 
                className={`pool-tab-btn ${selectedPool === 'WQUAI' ? 'active' : ''}`}
                onClick={() => selectPoolTab('WQUAI')}
              >
                Q0 / WQUAI Pool
              </button>
              <button 
                className={`pool-tab-btn ${selectedPool === 'BOSS' ? 'active' : ''}`}
                onClick={() => selectPoolTab('BOSS')}
              >
                Q0 / BOSS Pool
              </button>
            </div>

            {/* Input In */}
            <div className="swap-input-group">
              <div className="swap-input-header">
                <span>From</span>
                {walletAddress && (
                  <span>
                    Balance: {getBalanceForToken(swapDirection === 'Q0_TO_TOKEN' ? 'Q0' : selectedPool)}
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
                  {swapDirection === 'Q0_TO_TOKEN' ? 'Q0' : selectedPool}
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
                    Balance: {getBalanceForToken(swapDirection === 'Q0_TO_TOKEN' ? selectedPool : 'Q0')}
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
                  {swapDirection === 'Q0_TO_TOKEN' ? selectedPool : 'Q0'}
                </div>
              </div>
            </div>

            {/* Detail Sheet */}
            <div className="swap-details">
              <div className="swap-detail-row">
                <span className="swap-detail-label">Execution Price</span>
                <span className="swap-detail-value">{execPrice} {swapDirection === 'Q0_TO_TOKEN' ? selectedPool : 'Q0'} per {swapDirection === 'Q0_TO_TOKEN' ? 'Q0' : selectedPool}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Price Impact</span>
                <span className={`swap-detail-value ${
                  parseFloat(priceImpact) < 1 ? 'impact-green' : (parseFloat(priceImpact) < 5 ? 'impact-orange' : 'impact-red')
                }`}>{priceImpact}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Minimum Received</span>
                <span className="swap-detail-value">{minReceived} {swapDirection === 'Q0_TO_TOKEN' ? selectedPool : 'Q0'}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Slippage Tolerance</span>
                <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                  <input 
                    type="number" 
                    value={slippage} 
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setSlippage(isNaN(val) ? 0.5 : val);
                      setTimeout(() => handleAmountInChange(swapAmountIn), 10);
                    }}
                    style={{ background: 'transparent', border: '1px solid var(--panel-border)', borderRadius: '4px', width: '45px', color: 'inherit', fontSize: '0.75rem', textAlign: 'center', outline: 'none' }}
                  />
                  <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>%</span>
                </div>
              </div>
            </div>

            {/* Pending Swap Warning / Step 2 claim */}
            {pendingSwapStep === 'READY_TO_CLAIM' && (
              <div style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem' }}>
                <h4 style={{ color: 'var(--warning)', fontSize: '0.9rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <TrendingUp size={16} /> Unclaimed Swap Pending
                </h4>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                  WQUAI/BOSS has been deposited (Tx: {formatAddr(pendingTransferTx || '')}). Click below to claim your estimated <strong>{formatUnits(claimMinReceived)} Q0</strong> tokens.
                </p>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button 
                    className="btn-primary" 
                    style={{ background: 'var(--accent-gold)', flex: 1, padding: '0.5rem', fontSize: '0.8rem', color: '#000', justifyContent: 'center' }}
                    onClick={claimPendingSwap}
                    disabled={swapLoading}
                  >
                    {swapLoading ? 'Claiming...' : 'Complete Swap (Step 2)'}
                  </button>
                  <button 
                    className="btn-primary" 
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--panel-border)', color: 'var(--text-muted)', padding: '0.5rem', fontSize: '0.8rem', boxShadow: 'none', justifyContent: 'center' }}
                    onClick={clearPendingSwap}
                    disabled={swapLoading}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            {/* Waiting for Confirmation Progress Card */}
            {pendingSwapStep === 'WAITING_FOR_CONFIRMATION' && (
              <div style={{ background: 'rgba(0, 242, 254, 0.05)', border: '1px solid rgba(0, 242, 254, 0.15)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="loader" style={{ width: '24px', height: '24px', borderWidth: '2px', margin: 0 }}></div>
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>Step 1: Staging Transfer sent...</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Waiting for on-chain block confirmation (Cyprus-1)</div>
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
              disabled={swapLoading || pendingSwapStep === 'WAITING_FOR_CONFIRMATION'}
              style={{ justifyContent: 'center' }}
            >
              {swapLoading ? 'Broadcasting...' : (walletAddress ? 'Confirm Swap' : 'Connect Wallet to Swap')}
            </button>
            <div className="dimmed-text">
              Direct LP Interface on Cyprus-1.
            </div>

            {/* Manual Recovery Box */}
            <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              {!showRecoveryBox ? (
                <button 
                  style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '0.75rem', cursor: 'pointer', textDecoration: 'underline', width: '100%', textAlign: 'center' }}
                  onClick={() => setShowRecoveryBox(true)}
                >
                  Need to recover a stuck swap transaction manually?
                </button>
              ) : (
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--panel-border)', borderRadius: '10px', padding: '0.75rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-muted)' }}>Recover Stuck Swap</div>
                  <input 
                    type="text" 
                    placeholder="Enter Transfer Tx Hash (0x...)"
                    value={manualTxHash}
                    onChange={(e) => setManualTxHash(e.target.value)}
                    style={{ width: '100%', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--panel-border)', borderRadius: '6px', padding: '0.4rem', color: 'var(--text-main)', fontSize: '0.75rem', fontFamily: 'monospace', marginBottom: '0.5rem', outline: 'none' }}
                  />
                  {recoveryError && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--error)', marginBottom: '0.5rem' }}>{recoveryError}</div>
                  )}
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button 
                      className="btn-primary" 
                      style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', flex: 1, justifyContent: 'center' }}
                      onClick={handleManualRecovery}
                    >
                      Scan & Recover
                    </button>
                    <button 
                      className="btn-primary" 
                      style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--panel-border)', color: 'var(--text-muted)', boxShadow: 'none', justifyContent: 'center' }}
                      onClick={() => { setShowRecoveryBox(false); setRecoveryError(null); }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
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
                    const isLpFrom = tx.from.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() || tx.from.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase();
                    const isLpTo = tx.to.toLowerCase() === CONTRACTS.LP_WQUAI.toLowerCase() || tx.to.toLowerCase() === CONTRACTS.LP_BOSS.toLowerCase();
                    
                    return (
                      <tr key={`${tx.tx_hash}-${idx}`}>
                        <td>
                          <a 
                            href={`https://quaiscan.io/tx/${tx.tx_hash}`} 
                            target="_blank" 
                            rel="noreferrer"
                            className="link-hash"
                          >
                            {formatAddr(tx.tx_hash)}
                          </a>
                        </td>
                        <td>
                          <span className={`address-badge ${isLpFrom ? 'lp' : ''}`}>
                            {isLpFrom ? 'LP Pair' : formatAddr(tx.from)}
                          </span>
                        </td>
                        <td>
                          <span className={`address-badge ${isLpTo ? 'lp' : ''}`}>
                            {isLpTo ? 'LP Pair' : formatAddr(tx.to)}
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
