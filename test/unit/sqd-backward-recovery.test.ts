import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XC_DOT_XC20_ADDRESS } from '../../src/asset/constants.js';
import {
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../../src/final-state/constants.js';
import {
  calculateBackwardWindow,
  classifyFinalBalances,
  runSqdBackwardRecovery,
  selectNewCandidates,
  type DwellirRpcTransport,
  type FinalBalanceResult,
} from '../../src/sqd/backward-recovery.js';
import { SqdNoContentError, TRANSFER_TOPIC0, type SqdRangeClient } from '../../src/sqd/client.js';
import { deriveBalanceAccountStoragesKeyDirect } from '../../src/storage/substrate-evm.js';
import { encodeU256Storage } from '../../src/storage/solidity.js';

const ADDRESS_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDRESS_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDRESS_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const ADDRESS_D = '0xdddddddddddddddddddddddddddddddddddddddd';
const ADDRESS_E = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function indexed(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function transfer(from: string, to: string): Record<string, unknown> {
  return { topics: [TRANSFER_TOPIC0, indexed(from), indexed(to)] };
}

function line(number: number, logs?: unknown[]): string {
  return JSON.stringify(logs === undefined ? { header: { number } } : { header: { number }, logs });
}

function candidateBalance(address: string, value: bigint): FinalBalanceResult {
  const key = deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, 0n);
  return {
    address,
    substrateStorageKey: key.substrateStorageKey,
    rawValue: encodeU256Storage(value),
    balancePlanck: value.toString(10),
  };
}

function response(blockStart: number, blockEnd: number, logs: unknown[] = []): string {
  return [line(blockStart), line(blockEnd, logs)].join('\n');
}

function makeTransport(
  values: ReadonlyMap<string, string | null>,
): DwellirRpcTransport & { storageKeys: string[]; proofKeys: string[] } {
  const storageKeys: string[] = [];
  const proofKeys: string[] = [];
  return {
    storageKeys,
    proofKeys,
    async call(method, params) {
      const key = String(params[0]);
      if (method === 'state_getStorage') {
        storageKeys.push(key);
        if (!values.has(key)) throw new Error(`unexpected storage key ${key}`);
        return values.get(key);
      }
      if (method === 'state_getReadProof') {
        proofKeys.push(key);
        return { at: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH, proof: ['0xaa'] };
      }
      throw new Error(`unexpected RPC method ${method}`);
    },
    async batch() {
      return [];
    },
  };
}

function baseFixture(values: readonly [string, bigint][]): {
  candidates: string[];
  balances: FinalBalanceResult[];
} {
  return {
    candidates: values.map(([address]) => address),
    balances: values.map(([address, value]) => candidateBalance(address, value)),
  };
}

describe('SQD backward incremental recovery', () => {
  it('calculates inclusive backward windows and the next cursor', () => {
    expect(calculateBackwardWindow(1_000, 100)).toEqual({
      blockStart: 901,
      blockEnd: 1_000,
      nextCursorEnd: 900,
    });
    expect(calculateBackwardWindow(900, 100)).toEqual({
      blockStart: 801,
      blockEnd: 900,
      nextCursorEnd: 800,
    });
  });

  it('deduplicates a backward round and selects only addresses outside the known set', () => {
    expect(
      selectNewCandidates(
        [ADDRESS_C.toUpperCase(), ADDRESS_B, ADDRESS_C, ADDRESS_A],
        new Set([ADDRESS_A, ADDRESS_B]),
      ),
    ).toEqual([ADDRESS_C]);
  });

  it('classifies positive and zero balances and computes an exact positive sum', () => {
    const balances = [candidateBalance(ADDRESS_A, 7n), candidateBalance(ADDRESS_B, 0n)];
    expect(classifyFinalBalances(balances)).toMatchObject({
      positive: [balances[0]],
      zero: [balances[1]],
      positiveSum: 7n,
    });
  });

  it('queries only new candidates, captures proofs only for positives, and never verifies them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-sqd-backward-exact-'));
    try {
      const base = baseFixture([
        [ADDRESS_A, 1n],
        [ADDRESS_B, 1n],
        [ADDRESS_C, 1n],
      ]);
      const newZero = candidateBalance(ADDRESS_D, 0n);
      const newPositive = candidateBalance(ADDRESS_E, 7n);
      const values = new Map<string, string | null>([
        [newZero.substrateStorageKey, newZero.rawValue],
        [newPositive.substrateStorageKey, newPositive.rawValue],
      ]);
      const transport = makeTransport(values);
      const sqdClient: SqdRangeClient = {
        async fetchRange(fromBlock, toBlock) {
          return response(fromBlock, toBlock, [
            transfer(ADDRESS_A, ADDRESS_D),
            transfer(ADDRESS_B, ADDRESS_E),
          ]);
        },
      };
      const result = await runSqdBackwardRecovery({
        work: join(root, 'work'),
        baseCandidates: base.candidates,
        baseBalances: base.balances,
        totalSupplyPlanck: '10',
        windowBlocks: 100,
        transport,
        sqdClient,
      });
      expect(result.summary.status).toBe('SUPPLY_COMPLETE');
      expect(result.summary.newCandidateCount).toBe(2);
      expect(result.summary.newPositiveCount).toBe(1);
      expect(result.summary.newZeroCount).toBe(1);
      expect(result.summary.finalKnownSumPlanck).toBe('10');
      expect(result.summary.remainingDeficitPlanck).toBe('0');
      expect(transport.storageKeys).toEqual(
        [newZero.substrateStorageKey, newPositive.substrateStorageKey].sort(),
      );
      expect(transport.proofKeys).toEqual([newPositive.substrateStorageKey]);
      expect(result.summary.proofVerification).toBe('NOT_RUN');
      const proof = JSON.parse(
        await readFile(join(root, 'work', 'proofs', `${ADDRESS_E}.json`), 'utf8'),
      ) as { stateRoot: string };
      expect(proof.stateRoot).toBe(MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clamps an above-head 204 response and records the uncovered top range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-sqd-backward-clamp-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      const newPositive = candidateBalance(ADDRESS_D, 1n);
      const transport = makeTransport(
        new Map([[newPositive.substrateStorageKey, newPositive.rawValue]]),
      );
      const calls: string[] = [];
      const sqdClient: SqdRangeClient = {
        async fetchRange(fromBlock, toBlock) {
          calls.push(`${fromBlock}-${toBlock}`);
          if (calls.length === 1) throw new SqdNoContentError(16_669_568);
          return response(fromBlock, toBlock, [transfer(ADDRESS_A, ADDRESS_D)]);
        },
      };
      const result = await runSqdBackwardRecovery({
        work: join(root, 'work'),
        baseCandidates: base.candidates,
        baseBalances: base.balances,
        totalSupplyPlanck: '2',
        windowBlocks: 100_000,
        transport,
        sqdClient,
      });
      expect(calls).toEqual(['16696697-16796696', '16569569-16669568']);
      expect(result.summary.status).toBe('SUPPLY_COMPLETE');
      expect(result.summary.sqdFinalizedHead).toBe(16_669_568);
      expect(result.summary.sqdCoverageGapStart).toBe(16_669_569);
      expect(result.summary.sqdCoverageGapEnd).toBe(16_796_696);
      expect(result.summary.sqdCoverageGapBlocks).toBe(127_128);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes durable balances without repeating balance or proof requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-sqd-backward-resume-'));
    try {
      const base = baseFixture([
        [ADDRESS_A, 1n],
        [ADDRESS_B, 2n],
      ]);
      const d = candidateBalance(ADDRESS_D, 4n);
      const e = candidateBalance(ADDRESS_E, 5n);
      const transport = makeTransport(
        new Map([
          [d.substrateStorageKey, d.rawValue],
          [e.substrateStorageKey, e.rawValue],
        ]),
      );
      let firstScan = true;
      const firstClient: SqdRangeClient = {
        async fetchRange(fromBlock, toBlock) {
          if (firstScan) {
            firstScan = false;
            return response(fromBlock, toBlock, [
              transfer(ADDRESS_A, ADDRESS_D),
              transfer(ADDRESS_B, ADDRESS_E),
            ]);
          }
          throw new Error('simulated SQD interruption');
        },
      };
      await expect(
        runSqdBackwardRecovery({
          work: join(root, 'work'),
          baseCandidates: base.candidates,
          baseBalances: base.balances,
          totalSupplyPlanck: '20',
          windowBlocks: 100,
          maxEmptyWindows: 1,
          transport,
          sqdClient: firstClient,
        }),
      ).rejects.toThrow('simulated SQD interruption');
      expect(transport.storageKeys).toHaveLength(2);
      expect(transport.proofKeys).toHaveLength(2);

      const storageCount = transport.storageKeys.length;
      const proofCount = transport.proofKeys.length;
      const secondClient: SqdRangeClient = {
        async fetchRange(fromBlock, toBlock) {
          return response(fromBlock, toBlock);
        },
      };
      const resumed = await runSqdBackwardRecovery({
        work: join(root, 'work'),
        baseCandidates: base.candidates,
        baseBalances: base.balances,
        totalSupplyPlanck: '20',
        windowBlocks: 100,
        maxEmptyWindows: 1,
        transport,
        sqdClient: secondClient,
        resume: true,
      });
      expect(resumed.summary.status).toBe('BACKWARD_DISCOVERY_STALLED');
      expect(transport.storageKeys).toHaveLength(storageCount);
      expect(transport.proofKeys).toHaveLength(proofCount);
      expect(resumed.summary.finalKnownSumPlanck).toBe('12');
      expect(resumed.summary.remainingDeficitPlanck).toBe('8');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops after the configured number of empty windows with a shortfall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-sqd-backward-stall-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      let calls = 0;
      const client: SqdRangeClient = {
        async fetchRange(fromBlock, toBlock) {
          calls += 1;
          return response(fromBlock, toBlock);
        },
      };
      const result = await runSqdBackwardRecovery({
        work: join(root, 'work'),
        baseCandidates: base.candidates,
        baseBalances: base.balances,
        totalSupplyPlanck: '10',
        windowBlocks: 10,
        maxEmptyWindows: 3,
        transport: makeTransport(new Map()),
        sqdClient: client,
      });
      expect(calls).toBe(3);
      expect(result.summary.status).toBe('BACKWARD_DISCOVERY_STALLED');
      expect(result.summary.remainingDeficitPlanck).toBe('9');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
