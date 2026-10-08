import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
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
  Award,
  Sparkles,
  Shield,
  Zap,
  Gift,
  Droplets,
  Layers,
  Rocket
} from 'lucide-react';
import {
  CONTRACTS,
  DEXES,
  REGISTERED_TOKENS,
  TOKEN_REGISTRY,
  FARM_REGISTRY,
  MASTERCHEF_ADDRESS,
  DEPLOYED,
  QRB_BOOST_THRESHOLD_WEI,
  formatBoostPct,
  formatBoostDuration,
  getQrbBoostStatus,
  describeQrbBoost,
  clampSlippagePct,
  prepareContractCall,
  type QrbBoostStatus,
  POOL_REGISTRY,
  CANDIDATE_POOLS,
  SWAP_ROUTES,
  buildCrossDexRoutes,
  findPool,
  getPairAddress,
  isDexLive,
  type PoolInfo,
  type DexId,
  requireDex,
  discoverCircleswapPools,
  buildCircleswapRoutes,
  orientedPath,
  orientedSegments,
  tokenAddress,
  quoteRoute,
  quoteCrossDexRoute,
  parseUnits,
  formatUnits as formatBaseUnits,
  getTokenMetadata,
  getLPReserves,
  getLatestBlockNumber,
  getTokenBalance,
  getAllowance,
  getQuaiBalance,
  quaiRpcCall,
  getTokenDetailV2,
  getQuainanceTVL,
  findQuainancePools,
  TokenMetadata,
  type TokenInfo,
  LPReserves,
  TokenDetailV2,
  TokenTransferV2,
  QuainanceTVL
} from 'quai-service';
import PoolModal from './PoolModal';
import PairsPage from './PairsPage';
import TokenPicker from './TokenPicker';
import TokenBubble, { type TokenBubbleMetadata } from './TokenBubble';
import ImportTokenModal from './ImportTokenModal';
import TokenAnalyticsPage from './TokenAnalyticsPage';
import { readImportedTokens, writeImportedTokens } from './customTokens';

// The deploy tooling carries the contracts' creation bytecode and the quais SDK; it loads only when opened.
const DeployPage = lazy(() => import('./DeployPage'));
import { 
  getQuaiProvider, 
  getCyprus1Address, 
  requestWalletAccounts, 
  getAuthorizedAccounts, 
  sendWalletTransaction 
} from './providerUtils';

const tokenMetadataCache = new Map<string, Promise<TokenBubbleMetadata | null>>();
const showLegacyAnalytics = (): boolean => false;

function loadTokenBubbleMetadata(token: TokenInfo): Promise<TokenBubbleMetadata | null> {
  const key = token.address.toLowerCase();
  const cached = tokenMetadataCache.get(key);
  if (cached) return cached;

  const request = Promise.allSettled([
    getTokenMetadata(token.address),
    getTokenDetailV2(token.address)
  ]).then(([chainResult, explorerResult]) => {
    const chainMetadata = chainResult.status === 'fulfilled' ? chainResult.value : null;
    const explorerToken = explorerResult.status === 'fulfilled' ? explorerResult.value.token : null;
    if (!chainMetadata && !explorerToken) return null;
    return {
      address: explorerToken?.contract_address ?? chainMetadata?.address ?? token.address,
      name: explorerToken?.name?.trim() || chainMetadata?.name?.trim() || token.name,
      symbol: explorerToken?.symbol?.trim() || chainMetadata?.symbol?.trim() || token.symbol,
      decimals: explorerToken?.decimals ?? chainMetadata?.decimals ?? token.decimals,
      totalSupply: chainMetadata?.totalSupply ?? explorerToken?.total_supply ?? '0',
      iconUrl: explorerToken?.icon_url ?? token.iconUrl,
      website: explorerToken?.website ?? undefined,
      description: explorerToken?.description ?? token.description
    } satisfies TokenBubbleMetadata;
  });
  tokenMetadataCache.set(key, request);
  return request;
}

const isLocalhost = typeof window !== 'undefined' && (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === '0.0.0.0' ||
  import.meta.env.DEV
);

const getTabFromHash = (): 'SWAP' | 'FARMS' | 'QRB' | 'ANALYTICS' | 'PAIRS' | 'DEPLOY' => {
  const hash = typeof window !== 'undefined' ? window.location.hash.toLowerCase() : '';
  if (hash === '#deploy') return isLocalhost ? 'DEPLOY' : 'SWAP';
  if (hash === '#farms') return 'FARMS';
  if (hash === '#qrb') return 'QRB';
  if (hash === '#analytics') return 'ANALYTICS';
  if (hash === '#pairs') return 'PAIRS';
  if (hash === '#swap') return 'SWAP';
  return 'SWAP';
};

export default function App() {
  // Navigation State
  const [activeTab, setActiveTab] = useState<'SWAP' | 'FARMS' | 'QRB' | 'ANALYTICS' | 'PAIRS' | 'DEPLOY'>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => {
      setActiveTab(getTabFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigateToTab = (tab: 'SWAP' | 'FARMS' | 'QRB' | 'ANALYTICS' | 'PAIRS' | 'DEPLOY') => {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      window.location.hash = '#' + tab.toLowerCase();
    }
  };

  // Wallet States
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  // Raw base-unit balances (decimal strings); formatted on render so no precision is lost.
  const [rawBalances, setRawBalances] = useState<Record<string, string>>({});
  // LP token balances held by the wallet, keyed by lower-cased pair address.
  const [lpBalances, setLpBalances] = useState<Record<string, string>>({});
  // Live reserves for every registered pool, keyed by lower-cased pair address.
  const [poolReserves, setPoolReserves] = useState<Record<string, LPReserves>>({});
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

  // Quainance DEX States
  const [quainanceTvl, setQuainanceTvl] = useState<QuainanceTVL | null>(null);
  
  // Swap States
  // Pools created after the registry was written (e.g. via the Create Pool modal), found by factory.getPair().
  const [discoveredPools, setDiscoveredPools] = useState<PoolInfo[]>([]);
  const [poolModalOpen, setPoolModalOpen] = useState<boolean>(false);
  const [customTokens, setCustomTokens] = useState(() => readImportedTokens());
  const [importTokenOpen, setImportTokenOpen] = useState(false);
  const [contractMetadata, setContractMetadata] = useState<Record<string, TokenBubbleMetadata>>({});
  const [contractMetadataStatus, setContractMetadataStatus] = useState<'loading' | 'ready' | 'partial' | 'failed'>('loading');
  const tokenCatalog = [...REGISTERED_TOKENS, ...customTokens];
  const tokenCatalogRef = useRef(tokenCatalog);
  tokenCatalogRef.current = tokenCatalog;

  // Keep imported metadata available to the shared route/quote helpers. The generated registry remains the
  // source of built-ins; imported entries are browser-local additions only.
  useEffect(() => {
    for (const token of customTokens) TOKEN_REGISTRY[token.symbol] = token;
    writeImportedTokens(customTokens);
  }, [customTokens]);

  // Read the live ERC-20 metadata so token bubbles stay tied to the deployed contract,
  // including imported tokens that were not part of the generated registry. The explorer
  // response fills in the richer display fields (logo/description) when available, while
  // the chain response remains the source of truth for standard ERC-20 fields.
  useEffect(() => {
    let live = true;
    const readableTokens = tokenCatalog.filter(token => token.deployed !== false && !token.isNative);
    setContractMetadataStatus(readableTokens.length ? 'loading' : 'ready');
    Promise.all(readableTokens.map(async token => [token.address.toLowerCase(), await loadTokenBubbleMetadata(token)] as const)).then(entries => {
      if (!live) return;
      const resolved = entries.filter((entry): entry is readonly [string, TokenBubbleMetadata] => entry[1] !== null);
      setContractMetadata(Object.fromEntries(resolved));
      setContractMetadataStatus(resolved.length === 0 ? 'failed' : resolved.length === readableTokens.length ? 'ready' : 'partial');
    });
    return () => {
      live = false;
    };
  }, [customTokens]);

  const allPools: PoolInfo[] = [...POOL_REGISTRY, ...discoveredPools];
  const allPoolsRef = useRef<PoolInfo[]>(allPools);
  allPoolsRef.current = allPools;
  const tokenLabel = (symbol: string) => TOKEN_REGISTRY[symbol]?.symbol ?? symbol;
  const discoveredDirectRoutes = discoveredPools
    .filter(pool => pool.dex !== 'CIRCLESWAP')
    .filter(pool => !SWAP_ROUTES.some(route => route.dex === pool.dex && ((route.path[0] === pool.tokens[0] && route.path[route.path.length - 1] === pool.tokens[1]) || (route.path[0] === pool.tokens[1] && route.path[route.path.length - 1] === pool.tokens[0]))))
    .map(pool => ({
      id: `POOL_${pool.dex}_${pool.pair.toLowerCase()}`,
      label: `${tokenLabel(pool.tokens[0])} / ${tokenLabel(pool.tokens[1])} (${DEXES[pool.dex].label})`,
      dex: pool.dex,
      path: [...pool.tokens]
    }));
  // Circleswap's pools are created by users, so its routes are built from what the factory reports.
  const availableRoutes = [
    ...SWAP_ROUTES.filter(r =>
      !r.optional || r.path.slice(0, -1).every((sym, i) => findPool(r.dex, sym, r.path[i + 1], allPools))
    ),
    ...discoveredDirectRoutes,
    ...buildCircleswapRoutes(discoveredPools),
    ...buildCrossDexRoutes(allPools)
  ];
  // Circleswap pools that exist but use a token this app does not list (so cannot be priced or shown).
  const [circleswapUnlisted, setCircleswapUnlisted] = useState<number>(0);

  // The wallet's boost as the Qrb contract reports it (balance AND holding time), not inferred from a balance.
  const [qrbStatus, setQrbStatus] = useState<QrbBoostStatus | null>(null);
  // High price impact must be acknowledged before the swap can be sent.
  const [impactAck, setImpactAck] = useState<boolean>(false);
  const [routeId, setRouteId] = useState<string>(SWAP_ROUTES[0].id);
  const [reversed, setReversed] = useState<boolean>(false);
  const [nativeQuaiSide, setNativeQuaiSide] = useState<'FROM' | 'TO' | null>(null);
  const [swapAmountIn, setSwapAmountIn] = useState<string>('');
  const [slippage, setSlippage] = useState<number>(1.0);
  const [swapLoading, setSwapLoading] = useState<boolean>(false);
  const [swapTxHash, setSwapTxHash] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  // Atomic router swap progress state ('IDLE' | 'APPROVING' | 'SWAPPING')
  const [pendingSwapStep, setPendingSwapStep] = useState<'IDLE' | 'APPROVING' | 'SWAPPING'>('IDLE');

  // Farms are read-only until CircleswapMasterChef is deployed (MASTERCHEF_ADDRESS is null):
  // there is no on-chain stake or reward to read, so none is shown and no stake/harvest tx is offered.
  const farmsLive = MASTERCHEF_ADDRESS !== null;

  // Top Holders
  const [topHolders, setTopHolders] = useState<{address: string, balance: string, pct: string}[]>([]);

  // ABI Helpers for Router
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

    const pathOffset = BigInt(0xa0);
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

  // Native QUAI uses the router's WQUAI boundary. Never encode the zero address as an ERC-20 path token.
  const encodeRouterSwapExactETH = (amountOutMin: bigint, path: string[], to: string, deadline: bigint): string => {
    const pad = (n: bigint | number, bits = 32) => BigInt(n).toString(16).padStart(bits * 2, '0');
    const padAddr = (addr: string) => addr.replace('0x', '').toLowerCase().padStart(64, '0');
    return '0x7ff36ab5' + pad(amountOutMin) + pad(0x80) + padAddr(to) + pad(deadline) + pad(path.length) + path.map(padAddr).join('');
  };

  const encodeRouterSwapExactTokensForETH = (amountIn: bigint, amountOutMin: bigint, path: string[], to: string, deadline: bigint): string => {
    const pad = (n: bigint | number, bits = 32) => BigInt(n).toString(16).padStart(bits * 2, '0');
    const padAddr = (addr: string) => addr.replace('0x', '').toLowerCase().padStart(64, '0');
    return '0x18cbafe5' + pad(amountIn) + pad(amountOutMin) + pad(0xa0) + padAddr(to) + pad(deadline) + pad(path.length) + path.map(padAddr).join('');
  };

  const encodeApprove = (spender: string, amount: bigint): string => {
    const cleanSpender = spender.replace('0x', '').toLowerCase().padStart(64, '0');
    const cleanAmount = amount.toString(16).padStart(64, '0');
    return '0x095ea7b3' + cleanSpender + cleanAmount;
  };

  const waitForTransaction = async (txHash: string): Promise<any> => {
    const maxAttempts = 120;
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
    throw new Error("Transaction was not mined within 90 seconds. It may still confirm on Cyprus-1.");
  };

  const parseSwapError = (err: any): string => {
    const msg = err.message || String(err);
    if (msg.toLowerCase().includes("insufficient funds")) {
      return "⚠️ Insufficient QUAI for Gas: You need more native QUAI in your wallet to cover the network transaction fee.";
    }
    return msg || "Transaction rejected or execution reverted.";
  };

  // Fetch all on-chain data
  const fetchData = useCallback(async (isRefresh: boolean = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [meta, poolRes, blockNum, detail] = await Promise.all([
        getTokenMetadata(CONTRACTS.Q0),
        Promise.all(POOL_REGISTRY.map(async (pool) => [pool.pair.toLowerCase(), await getLPReserves(pool.pair)] as const)),
        getLatestBlockNumber(),
        getTokenDetailV2(CONTRACTS.Q0)
      ]);
      const reservesMap: Record<string, LPReserves> = Object.fromEntries(poolRes);

      const found: PoolInfo[] = [];
      await Promise.all(CANDIDATE_POOLS.map(async (cand) => {
        try {
          const pair = await getPairAddress(cand.dex, cand.tokens[0], cand.tokens[1]);
          if (!pair || POOL_REGISTRY.some(p => p.pair.toLowerCase() === pair.toLowerCase())) return;
          reservesMap[pair.toLowerCase()] = await getLPReserves(pair);
          found.push({ ...cand, pair });
        } catch (e) {
          console.warn(`Pool discovery failed for ${cand.dex} ${cand.tokens.join('/')}:`, e);
        }
      }));

      // Imported tokens are not part of the generated candidate list. Look for a direct pair against every
      // known deployed token on the live external DEXes so an imported contract becomes tradable when its pool
      // already exists, without guessing at a router or silently creating a pool.
      const knownSymbols = [...new Set([
        ...REGISTERED_TOKENS.filter(token => token.deployed !== false && !token.isNative).map(token => token.symbol),
        ...customTokens.map(token => token.symbol)
      ])];
      const customCandidates: { dex: DexId; tokens: [string, string] }[] = [];
      const customPairKeys = new Set<string>();
      for (const custom of customTokens) {
        for (const other of knownSymbols) {
          if (custom.symbol === other) continue;
          for (const dexId of (['QUAISWAP', 'QUAINANCE'] as DexId[])) {
            const pairKey = `${dexId}:${[custom.symbol, other].sort().join('/')}`;
            if (customPairKeys.has(pairKey)) continue;
            customPairKeys.add(pairKey);
            customCandidates.push({ dex: dexId, tokens: [custom.symbol, other] });
          }
        }
      }
      await Promise.all(customCandidates.map(async (cand) => {
        if (!isDexLive(cand.dex)) return;
        try {
          const pair = await getPairAddress(cand.dex, cand.tokens[0], cand.tokens[1]);
          if (!pair || POOL_REGISTRY.some(pool => pool.pair.toLowerCase() === pair.toLowerCase())) return;
          if (found.some(pool => pool.pair.toLowerCase() === pair.toLowerCase())) return;
          reservesMap[pair.toLowerCase()] = await getLPReserves(pair);
          found.push({ ...cand, pair });
        } catch (e) {
          console.warn(`Imported token pool discovery failed for ${cand.dex} ${cand.tokens.join('/')}:`, e);
        }
      }));
      // Circleswap has no fixed pool list: ask its factory. A failure here must not hide the other DEXes.
      try {
        const cs = await discoverCircleswapPools();
        await Promise.all(cs.pools.map(async (p) => {
          reservesMap[p.pair.toLowerCase()] = await getLPReserves(p.pair);
        }));
        found.push(...cs.pools);
        setCircleswapUnlisted(cs.unlisted);
      } catch (e) {
        console.warn('Circleswap pool discovery failed:', e);
      }
      setDiscoveredPools(found);
      setPoolReserves(reservesMap);
      const wquaiRes = reservesMap[CONTRACTS.LP_WQUAI.toLowerCase()];
      const bossRes = reservesMap[CONTRACTS.LP_BOSS.toLowerCase()];

      setQ0Meta(meta);
      setLpWquai(wquaiRes);
      setLpBoss(bossRes);
      setLatestBlock(blockNum);
      setTokenDetail(detail);
      setTransfers(detail.transfers);
      setHolderCount(detail.token.holder_count || 34);

      const parsedHolders = detail.holders
        .filter(h => h.address.toLowerCase() !== '0x0000000000000000000000000000000000000000')
        .slice(0, 8)
        .map(h => ({
          address: h.address,
          balance: (Number(h.balance) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 }),
          pct: h.percentage.toFixed(2) + '%'
        }));
      setTopHolders(parsedHolders);

      try {
        const tvl = await getQuainanceTVL(1, import.meta.env.DEV ? '/api-quai-v2' : 'https://explorer.qu.ai');
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
  }, [customTokens]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Load wallet balances for every registered token, plus LP tokens for every registered pool.
  // A failed read is left unset (rendered as an em dash) rather than shown as 0.
  const loadWalletBalances = useCallback(async (addr: string) => {
    const raw: Record<string, string> = {};
    const lp: Record<string, string> = {};
    await Promise.all([
      ...tokenCatalogRef.current.filter(tok => tok.deployed !== false).map(async (tok) => {
        try {
          raw[tok.symbol] = tok.isNative ? await getQuaiBalance(addr) : await getTokenBalance(tok.address, addr);
        } catch (e) {
          console.warn(`Balance read failed for ${tok.symbol}:`, e);
        }
      }),
      ...allPoolsRef.current.map(async (pool) => {
        try {
          lp[pool.pair.toLowerCase()] = await getTokenBalance(pool.pair, addr);
        } catch (e) {
          console.warn(`LP balance read failed for ${pool.pair}:`, e);
        }
      })
    ]);
    setRawBalances(raw);
    setLpBalances(lp);
  }, []);

  const getBalanceForToken = (symbol: string) => {
    const raw = rawBalances[symbol];
    const decimals = TOKEN_REGISTRY[symbol]?.decimals ?? 18;
    return raw === undefined ? '—' : formatBaseUnits(BigInt(raw), decimals, 6);
  };

  const quaiBalance = rawBalances['QUAI'] === undefined ? '—' : formatBaseUnits(BigInt(rawBalances['QUAI']), 18, 4);
  // The boost: the figure and threshold come from the shared constants (mirrors Qrb.BOOST_BPS / BOOST_THRESHOLD).
  const boostThresholdText = formatBaseUnits(QRB_BOOST_THRESHOLD_WEI, 18, 18);
  const boostDurationText = formatBoostDuration();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const qrbBoostState = qrbStatus ? describeQrbBoost(qrbStatus, QRB_BOOST_THRESHOLD_WEI, nowSeconds) : 'BELOW_THRESHOLD';
  const boostEligibleInText = qrbStatus && qrbStatus.eligibleAt > nowSeconds
    ? (() => { const h = Math.ceil((qrbStatus.eligibleAt - nowSeconds) / 3600); return h >= 48 ? Math.ceil(h / 24) + ' days' : h + ' h'; })()
    : '';
  const artworkHref = DEPLOYED.ARTWORK_URI ? DEPLOYED.ARTWORK_URI.replace(/^ar:\/\//, 'https://arweave.net/') : null;


  useEffect(() => {
    if (walletAddress) {
      loadWalletBalances(walletAddress);
    }
  }, [walletAddress, loadWalletBalances, discoveredPools, customTokens]);

  useEffect(() => {
    let live = true;
    if (!walletAddress || !DEPLOYED.QRB) { setQrbStatus(null); return; }
    getQrbBoostStatus(DEPLOYED.QRB, walletAddress)
      .then(st => { if (live) setQrbStatus(st); })
      .catch(e => console.warn('Qrb boost status read failed:', e));
    return () => { live = false; };
  }, [walletAddress, rawBalances]);

  // Auto connect check
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

  // Accounts listener
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

  // Wallet connect
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

  // Swap quote, derived from live reserves on every render (no cached copy to go stale).
  const route = availableRoutes.find(r => r.id === routeId) ?? SWAP_ROUTES[0];
  const routeIsCrossDex = 'crossDex' in route;
  const swapPathSymbols = routeIsCrossDex
    ? (reversed ? [...route.path].reverse() : route.path)
    : orientedPath(route, reversed);
  const routeSegments = routeIsCrossDex
    ? orientedSegments(route, reversed)
    : [{ dex: route.dex, path: swapPathSymbols }];
  const routeFromSymbol = swapPathSymbols[0];
  const routeToSymbol = swapPathSymbols[swapPathSymbols.length - 1];
  const fromSymbol = nativeQuaiSide === 'FROM' ? 'QUAI' : routeFromSymbol;
  const toSymbol = nativeQuaiSide === 'TO' ? 'QUAI' : routeToSymbol;
  const dex = requireDex(routeSegments[0].dex);
  const routeDexLabels = [...new Set(routeSegments.map(segment => DEXES[segment.dex].label))].join(' → ');
  const fromTokenDecimals = TOKEN_REGISTRY[fromSymbol]?.decimals ?? 18;
  const toTokenDecimals = TOKEN_REGISTRY[toSymbol]?.decimals ?? 18;

  let amountInWei: bigint | null = null;
  let amountParseError: string | null = null;
  if (swapAmountIn) {
    try {
      amountInWei = parseUnits(swapAmountIn, fromTokenDecimals);
    } catch (e: any) {
      amountParseError = e.message;
    }
  }
  const quote = amountInWei && amountInWei > 0n
    ? routeIsCrossDex
      ? quoteCrossDexRoute(route, reversed, amountInWei, poolReserves, slippage, allPools)
      : quoteRoute(route, reversed, amountInWei, poolReserves, slippage, allPools)
    : null;
  const fromBalanceRaw = rawBalances[fromSymbol];
  const insufficientBalance = amountInWei !== null && fromBalanceRaw !== undefined && BigInt(fromBalanceRaw) < amountInWei;

  // A swap this far from the market price hands most of its value to whoever trades against it.
  const HIGH_IMPACT_PCT = 10;
  const needsImpactAck = !!quote && quote.priceImpactPct >= HIGH_IMPACT_PCT;

  const swapAmountOut = quote ? formatBaseUnits(quote.amountOut, toTokenDecimals, 6) : '';
  const minReceived = quote ? formatBaseUnits(quote.minimumReceived, toTokenDecimals, 6) : '0';
  const priceImpact = quote ? quote.priceImpactPct.toFixed(2) + '%' : '0.00%';
  const execPrice = quote ? quote.executionPrice.toFixed(6) : '0';

  const handleAmountInChange = (val: string) => {
    setImpactAck(false);
    setSwapAmountIn(val);
    setSwapTxHash(null);
    setSwapError(null);
  };

  const toggleSwapDirection = () => {
    setImpactAck(false);
    setReversed(r => !r);
    setNativeQuaiSide(side => side === 'FROM' ? 'TO' : side === 'TO' ? 'FROM' : null);
    setSwapAmountIn('');
    setSwapError(null);
    setSwapTxHash(null);
  };

  // Execute swap through the router of the DEX that owns the route's pools
  const executeSwap = async () => {
    if (!walletAddress) {
      connectWallet();
      return;
    }
    if (amountParseError) {
      setSwapError(amountParseError);
      return;
    }
    if (!amountInWei || amountInWei <= 0n) {
      setSwapError("Enter an amount to swap.");
      return;
    }
    if (insufficientBalance) {
      setSwapError(`Insufficient ${fromSymbol}: you hold ${getBalanceForToken(fromSymbol)}.`);
      return;
    }
    if (needsImpactAck && !impactAck) {
      setSwapError('This swap moves the price by ' + priceImpact + '. Tick the box to confirm you accept that.');
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

    let completedSegments = 0;
    try {
      // Re-read every hop's reserves right before signing so amountOutMin is not built from a stale page load.
      const hopPairs = new Set<string>();
      for (const segment of routeSegments) {
        for (let i = 0; i < segment.path.length - 1; i++) {
          const pool = findPool(segment.dex, segment.path[i], segment.path[i + 1], allPools);
          if (!pool) throw new Error(`No ${DEXES[segment.dex].label} pool for ${segment.path[i]}/${segment.path[i + 1]}.`);
          hopPairs.add(pool.pair);
        }
      }
      const fresh: Record<string, LPReserves> = { ...poolReserves };
      await Promise.all([...hopPairs].map(async pair => {
        fresh[pair.toLowerCase()] = await getLPReserves(pair);
      }));
      setPoolReserves(fresh);
      const freshQuote = routeIsCrossDex
        ? quoteCrossDexRoute(route, reversed, amountInWei, fresh, slippage, allPools)
        : quoteRoute(route, reversed, amountInWei, fresh, slippage, allPools);
      if (!freshQuote) throw new Error("Could not quote this swap from live reserves.");

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      if (routeIsCrossDex) {
        let segmentAmountIn = amountInWei;
        for (const [segmentIndex, segment] of routeSegments.entries()) {
          const segmentDex = requireDex(segment.dex);
          const segmentRoute = { id: `segment_${segment.dex}`, label: segment.path.join(' / '), dex: segment.dex, path: segment.path };
          const segmentQuote = quoteRoute(segmentRoute, false, segmentAmountIn, fresh, slippage, allPools);
          if (!segmentQuote) throw new Error(`Could not quote the ${segmentDex.label} segment ${segment.path.join(' → ')}.`);

          const nativeInput = fromSymbol === 'QUAI' && segmentIndex === 0;
          const outputSymbol = segment.path[segment.path.length - 1];
          const nativeOutput = toSymbol === 'QUAI' && segmentIndex === routeSegments.length - 1;
          const outputToken = nativeOutput ? null : tokenAddress(outputSymbol);
          const outputBefore = BigInt(nativeOutput ? await getQuaiBalance(walletAddress) : await getTokenBalance(outputToken!, walletAddress));
          const inputToken = nativeInput ? null : tokenAddress(segment.path[0]);
          if (inputToken) {
            const allowance = await getAllowance(inputToken, walletAddress, segmentDex.router);
            if (allowance < segmentAmountIn) {
              setPendingSwapStep('APPROVING');
              const approveTx = await sendWalletTransaction(provider, {
                from: walletAddress,
                to: inputToken,
                data: encodeApprove(segmentDex.router, segmentAmountIn),
                gas: '0x186a0'
              });
              await waitForTransaction(approveTx);
            }
          }

          setPendingSwapStep('SWAPPING');
          const segmentData = nativeInput
            ? encodeRouterSwapExactETH(segmentQuote.minimumReceived, segment.path.map(tokenAddress), walletAddress, deadline)
            : nativeOutput
              ? encodeRouterSwapExactTokensForETH(segmentAmountIn, segmentQuote.minimumReceived, segment.path.map(tokenAddress), walletAddress, deadline)
              : encodeRouterSwap(segmentAmountIn, segmentQuote.minimumReceived, segment.path.map(tokenAddress), walletAddress, deadline);
          const prepared = await prepareContractCall(
            walletAddress,
            segmentDex.router,
            segmentData,
            1.5,
            undefined,
            nativeInput ? segmentAmountIn : 0n
          );
          const swapTx = await sendWalletTransaction(provider, prepared.tx);
          setSwapTxHash(swapTx);
          await waitForTransaction(swapTx);

          // Native QUAI output is the terminal hop. Its wallet balance also moves down by gas, so a raw
          // before/after balance delta would be an unreliable receipt check here.
          if (nativeOutput) {
            completedSegments++;
            continue;
          }

          // Chain the confirmed balance delta into the next router; a quote is not guaranteed to be the exact
          // output if the pool moved between the read and confirmation.
          const outputAfter = BigInt(nativeOutput ? await getQuaiBalance(walletAddress) : await getTokenBalance(outputToken!, walletAddress));
          const received = outputAfter - outputBefore;
          if (received <= 0n) throw new Error(`The ${segmentDex.label} segment confirmed but no ${nativeOutput ? 'QUAI' : outputSymbol} was received.`);
          segmentAmountIn = received;
          completedSegments++;
        }
      } else {
        const swapPath = swapPathSymbols.map(tokenAddress);
        const nativeInput = fromSymbol === 'QUAI';
        const nativeOutput = toSymbol === 'QUAI';
        const tokenInAddress = nativeInput ? null : tokenAddress(routeFromSymbol);
        if (tokenInAddress) {
          const allowance = await getAllowance(tokenInAddress, walletAddress, dex.router);
          if (allowance < amountInWei) {
            setPendingSwapStep('APPROVING');
            console.log(`[Swap] Approving ${dex.label} router ${dex.router} to spend ${amountInWei}`);
            const approveTx = await sendWalletTransaction(provider, {
              from: walletAddress,
              to: tokenInAddress,
              data: encodeApprove(dex.router, amountInWei),
              gas: '0x186a0'
            });
            await waitForTransaction(approveTx);
          }
        }

        setPendingSwapStep('SWAPPING');
        const swapData = nativeInput
          ? encodeRouterSwapExactETH(freshQuote.minimumReceived, swapPath, walletAddress, deadline)
          : nativeOutput
            ? encodeRouterSwapExactTokensForETH(amountInWei, freshQuote.minimumReceived, swapPath, walletAddress, deadline)
            : encodeRouterSwap(amountInWei, freshQuote.minimumReceived, swapPath, walletAddress, deadline);
        console.log(`[Swap] ${nativeInput ? 'swapExactETHForTokens' : nativeOutput ? 'swapExactTokensForETH' : 'swapExactTokensForTokens'} via ${dex.label} path=${JSON.stringify(swapPath)}`);
        // On Cyprus-1 a reverted transaction burns its whole gas limit, so the swap is simulated against the
        // now-approved allowance first; if it would revert (slippage, dust pool, stale price) nothing is sent.
        const prepared = await prepareContractCall(
          walletAddress,
          dex.router,
          swapData,
          1.5,
          undefined,
          nativeInput ? amountInWei : 0n
        );
        const swapTx = await sendWalletTransaction(provider, prepared.tx);
        setSwapTxHash(swapTx);
        await waitForTransaction(swapTx);
      }

      setPendingSwapStep('IDLE');
      setSwapAmountIn('');
      loadWalletBalances(walletAddress);
      setTimeout(() => loadWalletBalances(walletAddress), 2000);
      setTimeout(() => {
        loadWalletBalances(walletAddress);
        fetchData(true);
      }, 5000);

    } catch (e: any) {
      console.error("[Swap] Failed:", e);
      const detail = parseSwapError(e);
      setSwapError(routeIsCrossDex && completedSegments > 0
        ? `${completedSegments} route segment${completedSegments === 1 ? '' : 's'} confirmed. The remaining route was not completed; your intermediate tokens remain in your wallet. ${detail}`
        : detail);
      setPendingSwapStep('IDLE');
    } finally {
      setSwapLoading(false);
    }
  };



  const selectRoute = (id: string, nativeSide: 'FROM' | 'TO' | null = null) => {
    setImpactAck(false);
    setRouteId(id);
    setReversed(false);
    setNativeQuaiSide(nativeSide);
    setSwapAmountIn('');
    setSwapError(null);
    setSwapTxHash(null);
  };

  const handleImportedToken = (token: TokenInfo) => {
    const existing = tokenCatalog.find(candidate => candidate.symbol.toLowerCase() === token.symbol.toLowerCase());
    if (existing && existing.address.toLowerCase() !== token.address.toLowerCase()) {
      setSwapError(`${token.symbol} is already used by another token in this app. Import it using its existing contract or choose a token with a different symbol.`);
      setImportTokenOpen(false);
      return;
    }
    if (!existing) setCustomTokens(tokens => [...tokens, token]);
    setImportTokenOpen(false);
    setSwapError(null);
  };

  const selectToken = (side: 'FROM' | 'TO', symbol: string) => {
    const normalized = symbol === 'QUAI' ? 'WQUAI' : symbol;
    const nextFrom = side === 'FROM' ? normalized : routeFromSymbol;
    const nextTo = side === 'TO' ? normalized : routeToSymbol;
    if (nextFrom === nextTo) {
      setSwapError('Choose two different tokens.');
      return;
    }
    const direct = availableRoutes.find(candidate => candidate.path[0] === nextFrom && candidate.path[candidate.path.length - 1] === nextTo);
    const reverse = availableRoutes.find(candidate => candidate.path[0] === nextTo && candidate.path[candidate.path.length - 1] === nextFrom);
    if (direct) {
      selectRoute(direct.id, symbol === 'QUAI' ? side : nativeQuaiSide === side ? null : nativeQuaiSide);
      setReversed(false);
    } else if (reverse) {
      selectRoute(reverse.id, symbol === 'QUAI' ? side : nativeQuaiSide === side ? null : nativeQuaiSide);
      setReversed(true);
    } else {
      setSwapError(`No live route found for ${tokenLabel(nextFrom)} / ${tokenLabel(nextTo)}. Importing a token does not create a pool.`);
    }
  };

  const formatAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const formatUnits = (valStr: string) => {
    return (Number(valStr) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  if (loading) {
    return (
      <div className="loader-container">
        <div className="loader" style={{ borderColor: 'rgba(255, 51, 68, 0.2)', borderTopColor: 'var(--accent-plasma)' }}></div>
        <p style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--accent-plasma)' }}>
          Loading Circleswap Protocol on Cyprus-1...
        </p>
      </div>
    );
  }

  const wquaiPrice = lpWquai ? (Number(lpWquai.reserve1) / Number(lpWquai.reserve0)) : 0;
  const bossPrice = lpBoss ? (Number(lpBoss.reserve1) / Number(lpBoss.reserve0)) : 0;

  return (
    <div className="app-container">
      {/* Top Header */}
      <header>
        <div className="brand-section">
          <img 
            src={`${import.meta.env.BASE_URL}QgoGIF.gif`} 
            className="brand-logo" 
            alt="Circleswap Logo" 
            style={{ borderRadius: '50%', width: '48px', height: '48px', objectFit: 'cover', border: '1px solid rgba(255, 51, 68, 0.5)' }} 
          />
          <div className="brand-title">
            <h1 style={{ background: 'linear-gradient(90deg, #ffffff 0%, var(--accent-plasma) 50%, var(--accent-violet) 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              CIRCLESWAP
            </h1>
            <p style={{ color: 'var(--accent-plasma)' }}>Quai DeFi Protocol & AMM DEX &bull; Dual-Reward Farms</p>
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

      {/* Primary Navigation Tabs */}
      <nav className="circleswap-nav">
        <button 
          className={`circleswap-nav-btn ${activeTab === 'SWAP' ? 'active' : ''}`} 
          onClick={() => navigateToTab('SWAP')}
        >
          <ArrowUpDown size={16} /> Swap
        </button>
        <button 
          className={`circleswap-nav-btn ${activeTab === 'FARMS' ? 'active' : ''}`} 
          onClick={() => navigateToTab('FARMS')}
        >
          <TrendingUp size={16} /> Farms & Pools
        </button>
        <button 
          className={`circleswap-nav-btn ${activeTab === 'QRB' ? 'active' : ''}`} 
          onClick={() => navigateToTab('QRB')}
        >
          <Sparkles size={16} /> Qrb Genesis
        </button>
        <button 
          className={`circleswap-nav-btn ${activeTab === 'ANALYTICS' ? 'active' : ''}`} 
          onClick={() => navigateToTab('ANALYTICS')}
        >
          <Activity size={16} /> Analytics & Ledger
        </button>
        <button 
          className={`circleswap-nav-btn ${activeTab === 'PAIRS' ? 'active' : ''}`} 
          onClick={() => navigateToTab('PAIRS')}
        >
          <Layers size={16} /> Pairs & Liquidity
        </button>
        {isLocalhost && (
          <button 
            className={`circleswap-nav-btn ${activeTab === 'DEPLOY' ? 'active' : ''}`} 
            onClick={() => navigateToTab('DEPLOY')}
          >
            <Rocket size={16} /> Deploy
          </button>
        )}
      </nav>

      {/* Multi-Token Portfolio Ticker */}
      {walletAddress && (
        <div className="portfolio-ticker">
           {tokenCatalog.filter(t => t.deployed !== false).map(t => {
            const bal = getBalanceForToken(t.symbol);
             const liveMetadata = contractMetadata[t.address.toLowerCase()];
            return (
              <div
                className="portfolio-chip"
                key={t.symbol}
                  title={`${liveMetadata?.name ?? t.name} · ${t.isNative ? 'Native Cyprus-1 asset' : t.address} · ${liveMetadata?.decimals ?? t.decimals} decimals`}
              >
                <TokenBubble token={t} metadata={liveMetadata} size="xs" />
                <span className="portfolio-chip-symbol">{liveMetadata?.symbol ?? t.symbol}</span>
                <span className="portfolio-chip-balance">{bal}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* TAB 5: ALL PAIRS & LIQUIDITY */}
      {activeTab === 'PAIRS' && <PairsPage onOpenLiquidity={() => setPoolModalOpen(true)} />}

      {/* TAB 6: DEPLOYMENT (lazy: carries the contracts' bytecode, localhost only) */}
      {isLocalhost && activeTab === 'DEPLOY' && (
        <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center' }}>Loading deployment tools…</div>}>
          <DeployPage
            walletAddress={walletAddress}
            onConnect={connectWallet}
            pools={allPools}
            onOpenLiquidity={() => setPoolModalOpen(true)}
          />
        </Suspense>
      )}

      {/* TAB 1: SWAP MODULE */}
      {activeTab === 'SWAP' && (
        <div className="swap-page-shell">
          <div className="glass-card swap-card uniswap-swap-card" style={{ borderColor: 'rgba(255, 51, 68, 0.25)' }}>
            <div className="swap-card-heading">
              <div>
                <div className="swap-eyebrow">Cyprus-1 · Swap</div>
                <div className="swap-title"><ArrowUpDown size={20} style={{ color: 'var(--accent-plasma)' }} /> Trade tokens</div>
              </div>
              <button type="button" className="swap-settings-button" title="Swap settings" onClick={() => document.getElementById('swap-settings')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>•••</button>
            </div>

            <div className="swap-route-summary">
              <div>
                <span className="swap-summary-label">Best available route</span>
                <strong>{tokenLabel(fromSymbol)} <span>→</span> {tokenLabel(toSymbol)}</strong>
              </div>
              <button type="button" className="swap-route-button" onClick={() => document.getElementById('route-options')?.toggleAttribute('open')}>
                <span>{routeIsCrossDex ? 'Multi-DEX' : dex.label}</span><span>⌄</span>
              </button>
            </div>

            <details id="route-options" className="swap-route-options">
              <summary>Choose a route manually</summary>
              <div className="pool-selector-tabs swap-route-grid">
                {availableRoutes.map(r => (
                  <button
                    key={r.id}
                    className={`pool-tab-btn ${routeId === r.id ? 'active' : ''}`}
                    onClick={() => selectRoute(r.id)}
                    title={`${'crossDex' in r ? r.segments.map(segment => DEXES[segment.dex].label).join(' → ') : DEXES[r.dex].label}: ${r.path.join(' → ')}`}
                  >
                    {r.path.map(tokenLabel).join(' → ')}<small>{'crossDex' in r ? 'Multi-DEX' : DEXES[r.dex].label}</small>
                  </button>
                ))}
                <button className="pool-tab-btn route-create-button" onClick={() => setPoolModalOpen(true)} title="Create a new pool or add liquidity to an existing one">
                  + Create Pool
                </button>
              </div>
            </details>

            {routeIsCrossDex && (
              <div style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)', color: 'var(--accent-amber, #f59e0b)', padding: '0.7rem 0.85rem', borderRadius: '10px', fontSize: '0.76rem', lineHeight: 1.4, marginBottom: '1rem' }}>
                This route crosses {routeDexLabels}. Each segment is a separate router transaction, so it is not atomic. The wallet will receive each intermediate token before the next segment is submitted; if you stop after a confirmed segment, your funds remain in your wallet.
              </div>
            )}

            {circleswapUnlisted > 0 && (
              <div className="dimmed-text" style={{ marginBottom: '0.75rem' }}>
                {circleswapUnlisted} more Circleswap pool{circleswapUnlisted === 1 ? '' : 's'} use{circleswapUnlisted === 1 ? 's' : ''} a token this app does not list, so {circleswapUnlisted === 1 ? 'it is' : 'they are'} not shown.
              </div>
            )}

            {/* Input In */}
            <div className="swap-input-group uniswap-token-input">
              <div className="swap-input-header">
                <span>You pay</span>
                {walletAddress && (
                  <span>
                    Balance: {getBalanceForToken(fromSymbol)}
                    {fromBalanceRaw !== undefined && BigInt(fromBalanceRaw) > 0n && (
                      <button
                        type="button"
                        onClick={() => handleAmountInChange(formatBaseUnits(BigInt(fromBalanceRaw), fromTokenDecimals, fromTokenDecimals))}
                        style={{ marginLeft: '0.5rem', background: 'transparent', border: '1px solid var(--panel-border)', color: 'var(--accent-plasma)', borderRadius: '4px', fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer', padding: '0 0.35rem' }}
                      >
                        MAX
                      </button>
                    )}
                  </span>
                )}
              </div>
              <div className="swap-input-row">
                <input 
                  type="text"
                  inputMode="decimal"
                  className="swap-field" 
                  placeholder="0.0" 
                  value={swapAmountIn}
                  onChange={(e) => handleAmountInChange(e.target.value)}
                />
                <TokenPicker value={fromSymbol} tokens={tokenCatalog.filter(token => token.deployed !== false)} balance={getBalanceForToken(fromSymbol)} metadata={contractMetadata} metadataStatus={contractMetadataStatus} onChange={symbol => selectToken('FROM', symbol)} onImport={() => setImportTokenOpen(true)} />
              </div>
            </div>

            {/* Middle Switch Arrow */}
            <div className="swap-arrow-container">
              <button className="swap-arrow-btn" onClick={toggleSwapDirection}>
                <ArrowUpDown size={16} />
              </button>
            </div>

            {/* Input Out */}
            <div className="swap-input-group uniswap-token-input">
              <div className="swap-input-header">
                <span>You receive</span>
                {walletAddress && (
                  <span>
                    Balance: {getBalanceForToken(toSymbol)}
                  </span>
                )}
              </div>
              <div className="swap-input-row">
                <input 
                  type="text"
                  className="swap-field" 
                  placeholder="0.0" 
                  value={swapAmountOut}
                  readOnly 
                />
                <TokenPicker value={toSymbol} tokens={tokenCatalog.filter(token => token.deployed !== false)} balance={getBalanceForToken(toSymbol)} metadata={contractMetadata} metadataStatus={contractMetadataStatus} onChange={symbol => selectToken('TO', symbol)} onImport={() => setImportTokenOpen(true)} />
              </div>
            </div>

            {/* Detail Sheet */}
            <div id="swap-settings" className="swap-details">
              <div className="swap-detail-row">
                <span className="swap-detail-label">Execution Price</span>
                <span className="swap-detail-value">{execPrice} {tokenLabel(toSymbol)} per {tokenLabel(fromSymbol)}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Price Impact</span>
                <span className={`swap-detail-value ${
                  parseFloat(priceImpact) < 1 ? 'impact-green' : (parseFloat(priceImpact) < 5 ? 'impact-orange' : 'impact-red')
                }`}>{priceImpact}</span>
              </div>
              <div className="swap-detail-row">
                <span className="swap-detail-label">Minimum Received</span>
                <span className="swap-detail-value">{minReceived} {tokenLabel(toSymbol)}</span>
              </div>
              <div className="swap-detail-row" style={{ alignItems: 'center' }}>
                <span className="swap-detail-label">Slippage Tolerance</span>
                <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                  {[0.1, 0.5, 1.0, 2.0].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      style={{
                        background: slippage === preset ? 'rgba(255, 51, 68, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                        border: slippage === preset ? '1px solid var(--accent-plasma)' : '1px solid var(--panel-border)',
                        color: slippage === preset ? 'var(--accent-plasma)' : 'var(--text-muted)',
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
                    min={0}
                    max={50}
                    step={0.1}
                    value={slippage} 
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setSlippage(clampSlippagePct(val));
                      setTimeout(() => handleAmountInChange(swapAmountIn), 10);
                    }}
                    style={{ background: 'transparent', border: '1px solid var(--panel-border)', borderRadius: '4px', width: '45px', color: 'inherit', fontSize: '0.75rem', textAlign: 'center', outline: 'none', marginLeft: '0.25rem' }}
                  />
                  <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>%</span>
                </div>
              </div>
            </div>

            {/* Step 1 Progress Card */}
            {pendingSwapStep === 'APPROVING' && (
              <div style={{ background: 'rgba(0, 242, 254, 0.05)', border: '1px solid rgba(0, 242, 254, 0.15)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="loader" style={{ width: '24px', height: '24px', borderWidth: '2px', margin: 0 }}></div>
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>{routeIsCrossDex ? 'Approving route segment…' : 'Step 1 of 2: Approving Router…'}</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{routeIsCrossDex ? `Authorising the next router in ${routeDexLabels}` : `Authorising the ${dex.label} Router to spend your tokens`}</div>
                </div>
              </div>
            )}

            {/* Step 2 Progress Card */}
            {pendingSwapStep === 'SWAPPING' && (
              <div style={{ background: 'rgba(255, 51, 68, 0.08)', border: '1px solid rgba(255, 51, 68, 0.25)', padding: '1rem', borderRadius: '14px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div className="loader" style={{ width: '24px', height: '24px', borderWidth: '2px', margin: 0, borderColor: 'rgba(255, 51, 68, 0.2)', borderTopColor: 'var(--accent-plasma)' }}></div>
                <div style={{ fontSize: '0.8rem' }}>
                  <strong>{routeIsCrossDex ? 'Executing route segment…' : 'Step 2 of 2: Routing Swap Atomically…'}</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{routeIsCrossDex ? `Swapping through ${routeDexLabels}` : `Executing swap via ${dex.label} Router`}</div>
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

            {needsImpactAck && (
              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.8rem', color: 'var(--error)', marginBottom: '1rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={impactAck} onChange={e => setImpactAck(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                <span>Price impact is {priceImpact}. This pool is small, so you will receive far less than the market rate. I understand and want to trade anyway.</span>
              </label>
            )}
            {!swapError && amountParseError && (
              <div style={{ fontSize: '0.8rem', color: 'var(--error)', marginBottom: '1rem' }}>{amountParseError}</div>
            )}
            {!swapError && !amountParseError && amountInWei !== null && amountInWei > 0n && !quote && (
              <div style={{ fontSize: '0.8rem', color: 'var(--error)', marginBottom: '1rem' }}>
                No quote: this pool has no usable liquidity for that amount.
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
              disabled={swapLoading || pendingSwapStep !== 'IDLE' || (!!walletAddress && (insufficientBalance || !!amountParseError || (needsImpactAck && !impactAck)))}
              style={{ justifyContent: 'center', background: 'linear-gradient(135deg, var(--accent-plasma) 0%, #8a2be2 100%)', color: '#fff' }}
            >
              {pendingSwapStep === 'APPROVING'
                ? 'Approving…'
                : pendingSwapStep === 'SWAPPING'
                ? 'Swapping…'
                : !walletAddress
                ? 'Connect Wallet to Swap'
                : insufficientBalance
                ? `Insufficient ${fromSymbol} balance`
                : 'Confirm Swap'}
            </button>
                <div className="swap-route-footer">
                  <span>{routeIsCrossDex ? 'Multi-DEX route' : `${dex.label} route`}</span>
                  <span>{route.path.map(tokenLabel).join(' → ')}</span>
                </div>
          </div>
        </div>
      )}

      {/* TAB 2: FARMS & LIQUIDITY MINING */}
      {activeTab === 'FARMS' && (
        <div>
          {/* Dual Reward Protocol Banner */}
          <div className="glass-card" style={{ marginBottom: '2rem', background: 'linear-gradient(135deg, rgba(255, 51, 68, 0.1) 0%, rgba(18, 22, 41, 0.8) 100%)', borderColor: 'rgba(255, 51, 68, 0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <TrendingUp size={22} style={{ color: 'var(--accent-plasma)' }} />
                  Circleswap Dual-Incentive Farms
                </h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Stake LP tokens or single assets to earn dual rewards in <strong style={{ color: 'var(--accent-plasma)' }}>BoltDelta (BDELTA)</strong> and <strong style={{ color: 'var(--accent-neon)' }}>Q0 Tokens</strong>.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn-primary" onClick={() => setPoolModalOpen(true)} style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}>
                  <Droplets size={14} /> Create Pool / Add Liquidity
                </button>
                <div style={{ background: 'rgba(255, 215, 0, 0.1)', border: '1px solid rgba(255, 215, 0, 0.3)', padding: '0.5rem 1rem', borderRadius: '12px', fontSize: '0.8rem', color: 'var(--accent-gold)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Zap size={14} /> Qrb Booster: {DEPLOYED.QRB === null ? 'Qrb not deployed' : !walletAddress ? `+${formatBoostPct()} for ${boostThresholdText} QRB held ${boostDurationText}` : qrbBoostState === 'ACTIVE' ? `ACTIVE (+${formatBoostPct()})` : qrbBoostState === 'MATURING' ? `MATURING (active in ${boostEligibleInText})` : `INACTIVE (hold at least ${boostThresholdText} QRB for ${boostDurationText})`}
                </div>
              </div>
            </div>
          </div>

          {!farmsLive && (
            <div style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)', padding: '0.75rem 1.25rem', borderRadius: '12px', color: 'var(--accent-amber, #f59e0b)', fontSize: '0.85rem', marginBottom: '1.5rem', fontWeight: 600 }}>
              CircleswapMasterChef is not deployed yet, so staking and harvesting are disabled. Balances below are your real wallet
              LP-token balances; nothing is staked and no rewards are accruing. APR is not shown until emissions are set on-chain.
            </div>
          )}

          {/* Farms Grid */}
          <div className="farms-grid">
            {FARM_REGISTRY.map((pool) => {
              const lpAddr = pool.stakeToken.address.toLowerCase();
              const held = pool.stakeToken.isLP ? lpBalances[lpAddr] : rawBalances[pool.stakeToken.symbol];
              const heldText = !walletAddress ? 'Connect wallet' : held === undefined ? '—' : formatBaseUnits(BigInt(held), 18, 6);
              const reserves = poolReserves[lpAddr];
              const wquaiAddr = CONTRACTS.WQUAI.toLowerCase();
              const wquaiSide = reserves
                ? (reserves.token0.toLowerCase() === wquaiAddr ? reserves.reserve0 : reserves.token1.toLowerCase() === wquaiAddr ? reserves.reserve1 : null)
                : null;

              return (
                <div className="farm-card" key={pool.pid}>
                  <div>
                    <div className="farm-top">
                      <div className="farm-title-group">
                        <h3>{pool.name}</h3>
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                          <span className="farm-dual-badge">
                            <Gift size={11} /> {pool.rewardTokens.tokenB ? 'Dual Rewards: BDELTA + Q0' : `Earns ${pool.rewardTokens.tokenA.symbol}`}
                          </span>
                          <span className="farm-multiplier-badge">{pool.allocPoint} alloc</span>
                        </div>
                      </div>
                    </div>

                    <div className="farm-metrics-row">
                      <div>
                        <div className="farm-metric-label">APR</div>
                        <div className="farm-metric-val">{farmsLive ? '—' : 'Not live'}</div>
                      </div>
                      <div>
                        <div className="farm-metric-label">Pool Liquidity</div>
                        <div className="farm-metric-val">
                          {wquaiSide ? `${formatUnits(wquaiSide)} WQUAI per side` : pool.stakeToken.isLP ? '—' : 'n/a'}
                        </div>
                      </div>
                    </div>

                    <div className="farm-rewards-panel">
                      <div className="farm-rewards-row">
                        <span className="reward-token-label">
                          <Coins size={14} style={{ color: 'var(--accent-plasma)' }} /> Pending {pool.rewardTokens.tokenA.symbol}
                        </span>
                        <span className="reward-token-val">—</span>
                      </div>
                      {pool.rewardTokens.tokenB && (
                        <div className="farm-rewards-row">
                          <span className="reward-token-label">
                            <Coins size={14} style={{ color: 'var(--accent-neon)' }} /> Pending {pool.rewardTokens.tokenB.symbol}
                          </span>
                          <span className="reward-token-val">—</span>
                        </div>
                      )}
                      <div className="farm-rewards-row" style={{ marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <span className="reward-token-label" style={{ fontSize: '0.75rem' }}>
                          <Shield size={12} /> In wallet
                        </span>
                        <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#fff' }}>
                          {heldText} {pool.stakeToken.symbol}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="farm-actions">
                    <button className="btn-primary" disabled={!farmsLive} title="Available once CircleswapMasterChef is deployed"
                      style={{ flex: 1, padding: '0.5rem', fontSize: '0.8rem', minHeight: '40px', justifyContent: 'center' }}>
                      Stake
                    </button>
                    <button className="btn-primary" disabled={!farmsLive} title="Available once CircleswapMasterChef is deployed"
                      style={{ flex: 1, padding: '0.5rem', fontSize: '0.8rem', minHeight: '40px', justifyContent: 'center', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid var(--panel-border)', boxShadow: 'none' }}>
                      Unstake
                    </button>
                    <button className="btn-primary" disabled={!farmsLive} title="Available once CircleswapMasterChef is deployed"
                      style={{ flex: 1, padding: '0.5rem', fontSize: '0.8rem', minHeight: '40px', justifyContent: 'center', background: 'linear-gradient(135deg, var(--accent-plasma) 0%, var(--accent-gold) 100%)', color: '#000' }}>
                      Harvest
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 3: QRB 1-OF-1 GENESIS SOVEREIGN ARTIFACT */}
      {activeTab === 'QRB' && (
        <div>
          <div className="qrb-hero-container">
            {/* Holographic Containment Pod with QgoGIF */}
            <div className="qrb-artwork-pod">
              <div className="qrb-gif-viewport">
                <img src={`${import.meta.env.BASE_URL}QgoGIF.gif`} alt="Circleswap Qrb 1-of-1 Genesis Singularity" />
                <div style={{ position: 'absolute', bottom: 12, left: 12, background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,51,68,0.4)', padding: '0.35rem 0.75rem', borderRadius: '8px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-plasma)', backdropFilter: 'blur(8px)' }}>
                  Singularity Core: Active
                </div>
              </div>
            </div>

            {/* Spec Sheet & Metadata */}
            <div className="qrb-spec-sheet">
              <div className="qrb-supply-badge">
                <Sparkles size={14} /> EDITION: 1 OF 1 GENESIS SOVEREIGN
              </div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, color: '#fff', lineHeight: 1.2 }}>
                Circleswap Qrb Genesis
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                The sovereign singular artifact of Circleswap on Quai Network (Cyprus-1 shard).
                The <strong>QRB</strong> ERC-20 has a fixed supply of <strong>1.0</strong>. Holding at least <strong>{boostThresholdText} QRB</strong> for <strong>{boostDurationText}</strong> earns <strong>+{formatBoostPct()}</strong> farm rewards; the boost is read from the token itself, and the holding time stops a balance being borrowed for a moment to claim it. A companion 1-of-1 NFT (with EIP-2981 royalties) is a collectible and grants no boost. Artwork lives on Arweave.
              </p>

              <div className="qrb-traits-grid">
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Max Supply</div>
                  <div className="qrb-trait-val" style={{ color: 'var(--accent-plasma)' }}>1.0 QRB (Strict)</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Core Catalyst</div>
                  <div className="qrb-trait-val">Radiant Dark Plasma</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Token Standards</div>
                  <div className="qrb-trait-val">QRB (ERC-20) + 1-of-1 NFT</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Stasis Pod</div>
                  <div className="qrb-trait-val">Class-IV Cryo Pod</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Farm Boost</div>
                  <div className="qrb-trait-val" style={{ color: 'var(--accent-gold)' }}>+{formatBoostPct()} rewards</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Boost Threshold</div>
                  <div className="qrb-trait-val">{boostThresholdText} QRB held {boostDurationText}</div>
                </div>
                <div className="qrb-trait-card">
                  <div className="qrb-trait-name">Shard Origin</div>
                  <div className="qrb-trait-val">Cyprus-1 (0x00)</div>
                </div>
              </div>

              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {artworkHref ? (
                  <a
                    href={artworkHref}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-primary"
                    style={{ textDecoration: 'none', fontSize: '0.85rem', padding: '0.6rem 1.25rem', background: 'linear-gradient(135deg, var(--accent-plasma) 0%, #8a2be2 100%)', color: '#fff' }}
                  >
                    <ExternalLink size={15} /> View Artwork on Arweave
                  </a>
                ) : (
                  <span className="btn-primary" style={{ fontSize: '0.85rem', opacity: 0.6, cursor: 'default', background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', boxShadow: 'none' }}>
                    Artwork: not yet uploaded to Arweave
                  </span>
                )}
              </div>

              {/* On-chain provenance: real addresses once deployed, an honest "not deployed" before */}
              <div style={{ marginTop: '1rem', display: 'grid', gap: '0.4rem', fontSize: '0.8rem' }}>
                {([['QRB token (ERC-20)', DEPLOYED.QRB], ['Artifact NFT (ERC-721)', DEPLOYED.QRB_NFT]] as const).map(([label, addr]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.3rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}><Shield size={12} /> {label}</span>
                    {addr ? (
                      <a href={`https://quaiscan.io/address/${addr}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-neon)', fontFamily: 'monospace' }}>{formatAddr(addr)}</a>
                    ) : (
                      <span style={{ color: 'var(--accent-amber, #f59e0b)' }}>Not deployed</span>
                    )}
                  </div>
                ))}
                {walletAddress && DEPLOYED.QRB && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Your QRB</span>
                    <span>{getBalanceForToken('QRB')} {qrbBoostState === 'ACTIVE' ? `(boost +${formatBoostPct()} active)` : qrbBoostState === 'MATURING' ? `(boost starts in ${boostEligibleInText})` : '(below boost threshold)'}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: ANALYTICS & TRANSACTION LEDGER */}
      {activeTab === 'ANALYTICS' && <TokenAnalyticsPage latestBlock={latestBlock} pools={allPools} poolReserves={poolReserves} />}
      {showLegacyAnalytics() && activeTab === 'ANALYTICS' && (
        <div>
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
                  MCap: {tokenDetail?.marketStats?.marketCapUsd ? `$${Number(tokenDetail.marketStats.marketCapUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Main Panels Layout */}
          <div className="dashboard-sections">
            {/* Left Side: Liquidity Pools */}
            <div className="side-panel">
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
                          selectRoute('Q0_WQUAI');
                          setActiveTab('SWAP');
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
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-violet) 0%, #a855f7 100%)', color: '#fff' }}
                        onClick={() => {
                          selectRoute('Q0_BOSS');
                          setActiveTab('SWAP');
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
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: '8px', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-gold) 0%, #f59e0b 100%)', color: '#000' }}
                        onClick={() => {
                          selectRoute('BOSS_WQUAI');
                          setActiveTab('SWAP');
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

              {/* Quainance DEX Card */}
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
                              selectRoute(tab);
                              setActiveTab('SWAP');
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
              </div>
            </div>

            {/* Right Side: Top Holders & Transaction Ledger */}
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
        </div>
      )}

      {/* Footer Info */}
      <footer style={{ marginTop: '3rem', paddingTop: '1.5rem', borderTop: '1px solid var(--panel-border)', display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-dim)', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          Circleswap Core: <a href={`https://quaiscan.io/token/${CONTRACTS.Q0}`} target="_blank" rel="noreferrer" className="link-hash">{CONTRACTS.Q0}</a> &bull; Dual Reward A: <a href={`https://quaiscan.io/token/${CONTRACTS.BDELTA}`} target="_blank" rel="noreferrer" className="link-hash">{CONTRACTS.BDELTA}</a>
        </div>
        <div>
          Circleswap DeFi Protocol &bull; Atomic Router Swaps &bull; Cyprus-1 Shard
        </div>
      </footer>

      {poolModalOpen && (
        <PoolModal
          walletAddress={walletAddress}
          rawBalances={rawBalances}
          pools={allPools}
          lpBalances={lpBalances}
          onConnect={connectWallet}
          onClose={() => setPoolModalOpen(false)}
          onDone={() => {
            fetchData(true);
            if (walletAddress) loadWalletBalances(walletAddress);
          }}
        />
      )}
      {importTokenOpen && (
        <ImportTokenModal
          onClose={() => setImportTokenOpen(false)}
          onImported={handleImportedToken}
        />
      )}
    </div>
  );
}
