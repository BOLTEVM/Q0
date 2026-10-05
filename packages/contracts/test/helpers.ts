import * as crypto from "crypto";
import { ethers } from "hardhat";

export const E18 = 10n ** 18n;
export const BOOST_THRESHOLD = 10n ** 14n; // 0.0001 QRB
export const BOOST_BPS = 5000n;
export const BOOST_MATURITY = 86400n; // 1 day, in seconds

/** A fresh, well-formed Arweave transaction id: 32 random bytes as base64url (43 characters). */
export function randomTxId(): string {
    const id = crypto.randomBytes(32).toString("base64url");
    if (id.length !== 43) throw new Error("unexpected txid length");
    return id;
}

export const TXID = randomTxId();
export const ARWEAVE_URI = `https://arweave.net/${TXID}`;
export const AR_SCHEME_URI = `ar://${TXID}`;

/** Decodes a `data:application/json;base64,...` URI and parses the JSON (which also proves it is valid JSON). */
export function decodeDataUri(uri: string): any {
    const prefix = "data:application/json;base64,";
    if (!uri.startsWith(prefix)) throw new Error(`not a base64 JSON data URI: ${uri.slice(0, 40)}`);
    return JSON.parse(Buffer.from(uri.slice(prefix.length), "base64").toString("utf8"));
}

export async function deployQrb(owner: string, uri: string = ARWEAVE_URI) {
    const qrb = await (await ethers.getContractFactory("Qrb")).deploy(owner, uri);
    await qrb.waitForDeployment();
    return qrb;
}

export async function deployNft(owner: string, royaltyReceiver: string, qrbAddress: string, uri: string = ARWEAVE_URI) {
    const nft = await (await ethers.getContractFactory("QrbArtifactNFT")).deploy(owner, royaltyReceiver, uri, qrbAddress);
    await nft.waitForDeployment();
    return nft;
}

/** Timestamp of the block a transaction was mined in. */
export async function stamp(tx: any): Promise<bigint> {
    const receipt = await tx.wait();
    return BigInt((await ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
}
