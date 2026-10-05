import { Wallet, JsonRpcProvider, QuaiTransaction, getCreateAddress, getZoneForAddress, isQiAddress, getAddress, Zone } from "quais";
import type { ChainClient, TxReceipt } from "./chain";

export const NETWORKS = {
    cyprus1: { chainId: 9n, rpc: "https://rpc.quai.network/cyprus1", pathingBase: "https://rpc.quai.network" },
    orchard: { chainId: 15000n, rpc: "https://orchard.rpc.quai.network/cyprus1", pathingBase: "https://orchard.rpc.quai.network" }
} as const;
export type NetworkName = keyof typeof NETWORKS;

/** True for an address that can host contracts in Cyprus-1: right zone, and a Quai (not Qi) address. */
export function isCyprus1QuaiAddress(address: string): boolean {
    return getZoneForAddress(address) === Zone.Cyprus1 && !isQiAddress(address);
}

/** Throws unless `address` is a Cyprus-1 Quai address. Used as DeployOptions.checkAddress. */
export function assertCyprus1(address: string): void {
    if (!isCyprus1QuaiAddress(address)) {
        throw new Error(`${address} is not a Cyprus-1 Quai address (zone ${String(getZoneForAddress(address))}); a contract there is unreachable from this shard`);
    }
}

/**
 * Quai only accepts a contract whose address lands in the deployer's zone. The address is derived from
 * (sender, nonce, initcode), so the SDK appends a 4-byte salt to the init data and increments it until the
 * derived address is in-zone. The salt sits after the ABI-encoded constructor arguments, which the
 * constructor ignores. Deterministic for a given (from, nonce, data).
 */
export function grindCreationData(
    from: string,
    nonce: number,
    data: string,
    isAcceptable: (address: string) => boolean = isCyprus1QuaiAddress,
    maxAttempts: number = 200_000
): { data: string; predictedAddress: string; attempts: number } {
    let salt = nonce >>> 0;
    for (let attempts = 1; attempts <= maxAttempts; attempts++) {
        const candidate = data + salt.toString(16).padStart(8, "0");
        const predictedAddress = getCreateAddress({ from, nonce, data: candidate });
        if (isAcceptable(predictedAddress)) return { data: candidate, predictedAddress, attempts };
        salt = (salt + 1) >>> 0;
    }
    throw new Error(`Could not grind an in-zone contract address in ${maxAttempts} attempts`);
}

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000) // a hung node must not hang the deploy
    });
    if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
    return json.result;
}

/**
 * ChainClient over a Quai zone RPC. Reads and receipts use raw JSON-RPC (the SDK's block/receipt parsing
 * chokes on Quai's transaction shape); signing and populating use quais. With no private key the client
 * can simulate but not send.
 */
export class QuaiChainClient implements ChainClient {
    readonly deployer: string;
    private wallet?: Wallet;
    private provider: JsonRpcProvider;

    constructor(
        private readonly network: NetworkName,
        opts: { privateKey?: string; from?: string; rpcUrl?: string } = {}
    ) {
        this.provider = new JsonRpcProvider(NETWORKS[network].pathingBase, undefined, { usePathing: true });
        this.rpcUrl = opts.rpcUrl ?? NETWORKS[network].rpc;
        if (opts.privateKey) {
            this.wallet = new Wallet(opts.privateKey, this.provider);
            this.deployer = getAddress(this.wallet.address);
        } else if (opts.from) {
            this.deployer = getAddress(opts.from);
        } else {
            throw new Error("QuaiChainClient needs a private key (to send) or a from address (to simulate)");
        }
        if (!isCyprus1QuaiAddress(this.deployer)) {
            throw new Error(`Deployer ${this.deployer} is not a Cyprus-1 Quai address (must start 0x00). Use an account from the Cyprus-1 zone.`);
        }
    }

    private rpcUrl: string;

    async getChainId() {
        return BigInt(await rpc(this.rpcUrl, "quai_chainId", []));
    }
    async getBalance(address: string) {
        return BigInt(await rpc(this.rpcUrl, "quai_getBalance", [getAddress(address), "latest"]));
    }
    async getGasPrice() {
        return BigInt(await rpc(this.rpcUrl, "quai_gasPrice", []));
    }
    async getBlockNumber() {
        return parseInt(await rpc(this.rpcUrl, "quai_blockNumber", []), 16);
    }
    async getCode(address: string) {
        return (await rpc(this.rpcUrl, "quai_getCode", [getAddress(address), "latest"])) as string;
    }
    async call(to: string, data: string) {
        return (await rpc(this.rpcUrl, "quai_call", [{ to: getAddress(to), data }, "latest"])) as string;
    }

    private async nextNonce(): Promise<number> {
        return parseInt(await rpc(this.rpcUrl, "quai_getTransactionCount", [this.deployer, "pending"]), 16);
    }

    async estimateCreate(data: string) {
        const ground = grindCreationData(this.deployer, await this.nextNonce(), data);
        return BigInt(await rpc(this.rpcUrl, "quai_estimateGas", [{ from: this.deployer, data: ground.data }]));
    }
    async estimateCall(to: string, data: string) {
        return BigInt(await rpc(this.rpcUrl, "quai_estimateGas", [{ from: this.deployer, to: getAddress(to), data }]));
    }

    /**
     * Builds and signs a creation transaction without broadcasting it, and refuses if the address it would
     * create is not a Cyprus-1 Quai address. Exposed so the whole path short of the network send can be
     * exercised with an unfunded key.
     */
    async prepareCreate(data: string, gasLimit: bigint): Promise<{ signed: string; predictedAddress: string; nonce: number }> {
        const wallet = this.requireWallet();
        const nonce = await this.nextNonce();
        const ground = grindCreationData(this.deployer, nonce, data);

        const pop: any = await wallet.populateQuaiTransaction({ from: this.deployer, data: ground.data, nonce, gasLimit });
        // The address was ground for exactly this nonce and data. If populate changed either, the address
        // would no longer be in-zone, so stop rather than send a creation into the wrong zone.
        if (Number(pop.nonce) !== nonce || pop.data !== ground.data) {
            throw new Error(`Populated transaction diverged from the ground one (nonce ${pop.nonce} vs ${nonce}); not sending`);
        }
        const predicted = getCreateAddress({ from: this.deployer, nonce: pop.nonce, data: pop.data });
        assertCyprus1(predicted);

        // quais' own sendTransaction signs the QuaiTransaction built from the populated request the same way.
        const signed = await wallet.signTransaction(QuaiTransaction.from(pop) as any);
        return { signed, predictedAddress: predicted, nonce };
    }

    async sendCreate(data: string, gasLimit: bigint) {
        const { signed } = await this.prepareCreate(data, gasLimit);
        return this.broadcast(signed);
    }

    async sendCall(to: string, data: string, gasLimit: bigint) {
        const wallet = this.requireWallet();
        const pop: any = await wallet.populateQuaiTransaction({ from: this.deployer, to: getAddress(to), data, gasLimit });
        const signed = await wallet.signTransaction(QuaiTransaction.from(pop) as any);
        return this.broadcast(signed);
    }

    private async broadcast(signed: string): Promise<string> {
        const wallet = this.requireWallet();
        const zone = await wallet.zoneFromAddress(this.deployer);
        // The runtime signature is (zone, signedTx, sender); the published typings omit `sender`.
        const resp = await (this.provider as any).broadcastTransaction(zone, signed, this.deployer);
        return resp.hash;
    }

    async getReceipt(txHash: string): Promise<TxReceipt | null> {
        const r = await rpc(this.rpcUrl, "quai_getTransactionReceipt", [txHash]);
        if (!r) return null;
        const status = typeof r.status === "string" ? parseInt(r.status, 16) : Number(r.status);
        // Only checksum a well-formed value; a malformed one must reach contractAddressFromReceipt as-is.
        const raw: string | null = r.contractAddress ?? null;
        let contractAddress = raw;
        if (raw && /^0x[0-9a-fA-F]{40}$/.test(raw)) contractAddress = getAddress(raw);
        return {
            status,
            contractAddress,
            blockNumber: parseInt(r.blockNumber, 16),
            gasUsed: BigInt(r.gasUsed)
        };
    }

    private requireWallet(): Wallet {
        if (!this.wallet) throw new Error("No signer: set QUAI_PRIVATE_KEY to send transactions");
        return this.wallet;
    }
}
