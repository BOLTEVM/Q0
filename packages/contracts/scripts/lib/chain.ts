// The minimal chain surface the deploy orchestration needs. The production implementation talks to Quai
// (quaiClient.ts); the tests implement it over an in-process Hardhat node, so the same orchestration runs
// in both places.

export interface TxReceipt {
    /** 1 = success, 0 = reverted. */
    status: number;
    /** Set by the node on a contract-creation receipt. The only accepted source of a deployed address. */
    contractAddress: string | null;
    blockNumber: number;
    gasUsed: bigint;
}

export interface ChainClient {
    /** Address that signs and pays. */
    readonly deployer: string;

    getChainId(): Promise<bigint>;
    getBalance(address: string): Promise<bigint>;
    getGasPrice(): Promise<bigint>;
    getBlockNumber(): Promise<number>;
    getCode(address: string): Promise<string>;
    /** Read-only contract call; returns the raw return data. */
    call(to: string, data: string): Promise<string>;

    /** Simulate a contract creation from `deployer`; throws if the constructor would revert. */
    estimateCreate(data: string): Promise<bigint>;
    /** Simulate a call from `deployer`; throws if it would revert. */
    estimateCall(to: string, data: string): Promise<bigint>;

    /** Sign and broadcast a contract creation. Returns the transaction hash. Throws without a signer. */
    sendCreate(data: string, gasLimit: bigint): Promise<string>;
    /** Sign and broadcast a call. Returns the transaction hash. Throws without a signer. */
    sendCall(to: string, data: string, gasLimit: bigint): Promise<string>;

    /** Null until the transaction is mined. */
    getReceipt(txHash: string): Promise<TxReceipt | null>;
}
