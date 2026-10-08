// The rules a real AMM deployment must satisfy before the first transaction is signed. One implementation, used by the deploy
// modal and by the command line, so the two can never disagree about what is safe to launch.
//
// They are strict on mainnet and only advisory elsewhere, and each can be overridden by an explicit acknowledgement, so a
// deliberate choice is possible but a slip is not.

import { TIMELOCK_MIN_DELAY, TIMELOCK_MAX_DELAY, type Reader } from './flows';
import { TOKEN_REGISTRY } from '../registries/tokens';

/** A delay shorter than this gives liquidity providers too little time to notice a change and leave. */
export const RECOMMENDED_MIN_DELAY = 2 * 86_400;

/** What the deployment is being asked to do. */
export interface AmmSettings {
    deployer: string;
    proposer: string;
    delaySeconds: number;
    openExecution: boolean;
    guardians: string[];
    wquai: string;
    probeTokens: [string, string];
}

/** What the chain says about the accounts and tokens the settings name. */
export interface AmmFacts {
    /** Whether the proposer is a contract (a multisig, say) rather than an ordinary account. */
    proposerIsContract: boolean;
    wquai: { hasCode: boolean; decimals?: number; symbol?: string };
    probeTokensHaveCode: [boolean, boolean];
}

export interface AmmAcks {
    allowAccountProposer?: boolean;
    allowShortDelay?: boolean;
    allowCustomWquai?: boolean;
}

export interface AmmAssessment {
    /** Reasons not to send anything. Each names the acknowledgement that overrides it, when one exists. */
    errors: { message: string; ack?: keyof AmmAcks }[];
    /** Worth reading, not worth stopping for. */
    warnings: string[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Applies the rules. `strict` is true for a real deployment to mainnet (`network === 'cyprus1'` and about to send). */
export function assessAmmSettings(strict: boolean, s: AmmSettings, f: AmmFacts, acks: AmmAcks = {}): AmmAssessment {
    const errors: AmmAssessment['errors'] = [];
    const warnings: string[] = [];
    const problem = (message: string, ack: keyof AmmAcks) => {
        if (strict && !acks[ack]) errors.push({ message, ack });
        else warnings.push(message);
    };

    if (s.delaySeconds < TIMELOCK_MIN_DELAY || s.delaySeconds > TIMELOCK_MAX_DELAY) {
        errors.push({ message: 'The delay must be between 1 and 30 days.' });
    } else if (s.delaySeconds < RECOMMENDED_MIN_DELAY) {
        problem('The delay is under 2 days: liquidity providers get little time to notice a change and withdraw.', 'allowShortDelay');
    }

    if (same(s.proposer, s.deployer)) {
        problem(
            'The proposer is the deploying account. That account then keeps standing power over the protocol (it can queue upgrades), which is exactly what a separate proposer avoids: use a multisig.',
            'allowAccountProposer'
        );
    } else if (!f.proposerIsContract) {
        problem(
            'The proposer is an ordinary account, not a contract. A single key that is lost stops all future upgrades, and one that is stolen can queue a malicious one (users then have only the delay to react): use a multisig.',
            'allowAccountProposer'
        );
    }

    if (s.guardians.length === 0) {
        warnings.push('No guardian: only the proposer can cancel a queued change. A second key that can veto (but not propose) is cheap insurance against a compromised proposer.');
    }
    for (const g of s.guardians) {
        if (same(g, s.deployer)) warnings.push(`Guardian ${g} is the deploying account; prefer a key that is not used for deploying.`);
    }
    if (!s.openExecution) {
        warnings.push('Execution is closed: only the proposer can run a ready operation, so a lost proposer stalls even decisions that were already public.');
    }

    if (!f.wquai.hasCode) errors.push({ message: `WQUAI ${s.wquai} has no code on this chain.` });
    else {
        if (f.wquai.decimals !== 18) errors.push({ message: `WQUAI ${s.wquai} reports ${f.wquai.decimals ?? 'no'} decimals; the router expects an 18-decimal wrapped native token.` });
        if (!same(s.wquai, TOKEN_REGISTRY.WQUAI.address)) {
            problem(
                `WQUAI ${s.wquai} is not the one in the app's token registry (${TOKEN_REGISTRY.WQUAI.address}): the app would route native QUAI through a different token than this router uses.`,
                'allowCustomWquai'
            );
        }
    }
    s.probeTokens.forEach((t, i) => {
        if (!f.probeTokensHaveCode[i]) errors.push({ message: `Probe token ${t} has no code on this chain, so the pool-placement probe cannot run.` });
    });
    return { errors, warnings };
}

/** Reads what the settings depend on from the chain: nothing is sent. */
export async function gatherAmmFacts(reader: Reader, s: Pick<AmmSettings, 'proposer' | 'wquai' | 'probeTokens'>): Promise<AmmFacts> {
    const hasCode = async (a: string) => {
        try {
            const code = await reader.getCode(a);
            return Boolean(code) && code !== '0x';
        } catch {
            return false;
        }
    };
    const wquaiHas = await hasCode(s.wquai);
    let decimals: number | undefined;
    let symbol: string | undefined;
    if (wquaiHas) {
        // Selectors of decimals() and symbol(); the reply is decoded by hand so this file needs no ABI of its own.
        try {
            decimals = Number(BigInt(await reader.call(s.wquai, '0x313ce567')));
        } catch {
            /* reported as a missing figure */
        }
        try {
            const raw = await reader.call(s.wquai, '0x95d89b41');
            const bytes = (h: string) => h.slice(2);
            const length = parseInt(bytes(raw).slice(64, 128), 16);
            symbol = new TextDecoder().decode(Uint8Array.from(bytes(raw).slice(128, 128 + length * 2).match(/../g) ?? [], b => parseInt(b, 16)));
        } catch {
            /* optional */
        }
    }
    return {
        proposerIsContract: await hasCode(s.proposer),
        wquai: { hasCode: wquaiHas, decimals, symbol },
        probeTokensHaveCode: [await hasCode(s.probeTokens[0]), await hasCode(s.probeTokens[1])]
    };
}
