import { ethers, network } from "hardhat";
import { Wallet } from "quais";
import { isCyprus1QuaiAddress } from "../../quai-service/src/deploy/chain";

/**
 * Hardhat's default accounts are not Cyprus-1 addresses, and the deployment plan (rightly) refuses any other. These helpers
 * make real ones: ordinary accounts that are funded and can sign through impersonation, and contracts placed at such an
 * address. Seeds are private-key integers, so a given seed always gives the same account.
 */

/** The first Cyprus-1 account at or after `seed`, funded and impersonable, and the seed that produced it. */
async function accountFrom(seed: number): Promise<{ address: string; seed: number }> {
  for (let i = seed; i < seed + 1_000_000; i++) {
    const w = new Wallet("0x" + i.toString(16).padStart(64, "0"));
    if (isCyprus1QuaiAddress(w.address)) {
      await network.provider.send("hardhat_setBalance", [w.address, "0x" + (10n ** 24n).toString(16)]);
      await network.provider.send("hardhat_impersonateAccount", [w.address]);
      return { address: w.address, seed: i };
    }
  }
  throw new Error("no Cyprus-1 account found");
}

/** A funded, impersonable account whose address is a valid Cyprus-1 Quai address. The same seed gives the same account. */
export async function cyprus1Account(seed: number): Promise<string> {
  return (await accountFrom(seed)).address;
}

// Contracts get a fresh address every time (never one already used), far from the explicit seeds tests choose.
let cursor = 10_000_000;

/** A Cyprus-1 address holding a copy of `contract`'s code, for builders that (rightly) refuse any other address. */
export async function atCyprus1(contract: { getAddress(): Promise<string> }): Promise<string> {
  const { address, seed } = await accountFrom(cursor);
  cursor = seed + 1;
  await network.provider.send("hardhat_setCode", [address, await ethers.provider.getCode(await contract.getAddress())]);
  return address;
}
