import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XC_DOT_XC20_ADDRESS } from '../../src/asset/constants.js';
import {
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../../src/final-state/constants.js';
import {
  calculateBackwardWindow,
  classifyFinalBalances,
  runSqdBackwardRecovery,
  selectNewCandidates,
  updateBackwardProgressCounters,
  type DwellirRpcTransport,
  type FinalBalanceResult,
} from '../../src/sqd/backward-recovery.js';
import {
  SQD_DATASET,
  SQD_ENDPOINT,
  SqdNoContentError,
  TRANSFER_TOPIC0,
  type SqdRangeClient,
} from '../../src/sqd/client.js';
import { candidateAddressesSha256 } from '../../src/subscan/candidates.js';
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

  it('counts candidate-only progress as unproductive recovery progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-sqd-backward-unproductive-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      const newZero = candidateBalance(ADDRESS_D, 0n);
      const client: SqdRangeClient = {
        async fetchRange(fromBlock, toBlock) {
          return response(fromBlock, toBlock, [transfer(ADDRESS_A, ADDRESS_D)]);
        },
      };
      const result = await runSqdBackwardRecovery({
        work: join(root, 'work'),
        baseCandidates: base.candidates,
        baseBalances: base.balances,
        totalSupplyPlanck: '10',
        windowBlocks: 10,
        maxUnproductiveWindows: 1,
        transport: makeTransport(new Map([[newZero.substrateStorageKey, newZero.rawValue]])),
        sqdClient: client,
      });
      expect(result.summary.status).toBe('BACKWARD_DISCOVERY_STALLED');
      expect(result.summary.newCandidateCount).toBe(1);
      expect(result.summary.newPositiveCount).toBe(0);
      expect(result.summary.consecutiveNoNewCandidateWindows).toBe(0);
      expect(result.summary.consecutiveUnproductiveWindows).toBe(1);
      const round = JSON.parse(
        await readFile(join(root, 'work', 'rounds', '000001.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(round.productive).toBe(false);
      expect(round.deficitReductionPlanck).toBe('0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resets the unproductive counter when a positive balance is found', () => {
    expect(
      updateBackwardProgressCounters(
        { consecutiveNoNewCandidateWindows: 4, consecutiveUnproductiveWindows: 7 },
        1,
        100n,
      ),
    ).toEqual({
      productive: true,
      consecutiveNoNewCandidateWindows: 0,
      consecutiveUnproductiveWindows: 0,
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
          maxUnproductiveWindows: 1,
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
        maxUnproductiveWindows: 1,
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

  it('stops after the configured number of unproductive windows with a shortfall', async () => {
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
        maxUnproductiveWindows: 3,
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

  it('rebuilds the unproductive counter from a legacy checkpoint suffix on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-sqd-backward-migrate-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      const work = join(root, 'work');
      await mkdir(join(work, 'rounds'), { recursive: true });
      await writeFile(
        join(work, 'context.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            finalBlockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
            finalBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
            stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
            contract: XC_DOT_XC20_ADDRESS,
            balancesSlot: '0',
            totalSupplyPlanck: '20',
            sqdDataset: SQD_DATASET,
            sqdEndpoint: SQD_ENDPOINT,
            windowBlocks: 100,
            maxEmptyWindows: 100,
            baseCandidateDigest: candidateAddressesSha256(base.candidates),
            baseCandidateCount: 1,
          },
          null,
          2,
        ) + '\n',
      );
      await writeFile(
        join(work, 'checkpoint.json'),
        JSON.stringify({
          schemaVersion: 1,
          nextCursorEnd: 500,
          completedRounds: 5,
          consecutiveEmptyWindows: 0,
          knownCandidateCount: 1,
          knownPositiveCount: 1,
          knownFinalSumPlanck: '1',
          remainingDeficitPlanck: '19',
          newCandidateCountTotal: 0,
          newPositiveCountTotal: 0,
          newZeroCountTotal: 0,
          proofsCaptured: 0,
        }) + '\n',
      );
      for (let round = 1; round <= 5; round += 1) {
        const positive = round === 3;
        await writeFile(
          join(work, 'rounds', `${String(round).padStart(6, '0')}.json`),
          JSON.stringify({
            round,
            blockStart: 500 - round * 100,
            blockEnd: 599 - round * 100,
            transferLogCount: 1,
            transferAddressCount: 1,
            newCandidateCount: 1,
            newPositiveCount: positive ? 1 : 0,
            newZeroCount: positive ? 0 : 1,
            newPositiveSumPlanck: positive ? '1' : '0',
            knownCandidateCountAfter: 1,
            knownPositiveCountAfter: 1,
            knownFinalSumPlanckAfter: '1',
            remainingDeficitPlanckAfter: '19',
            proofsCaptured: 0,
          }) + '\n',
        );
      }
      let calls = 0;
      const result = await runSqdBackwardRecovery({
        work,
        baseCandidates: base.candidates,
        baseBalances: base.balances,
        totalSupplyPlanck: '20',
        windowBlocks: 100,
        maxUnproductiveWindows: 2,
        transport: makeTransport(new Map()),
        sqdClient: {
          async fetchRange() {
            calls += 1;
            throw new Error('resume should stall before scanning');
          },
        },
        resume: true,
      });
      expect(calls).toBe(0);
      expect(result.summary.status).toBe('BACKWARD_DISCOVERY_STALLED');
      expect(result.summary.rounds).toBe(5);
      expect(result.summary.consecutiveUnproductiveWindows).toBe(2);
      const checkpoint = JSON.parse(
        await readFile(join(work, 'checkpoint.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(checkpoint.schemaVersion).toBe(2);
      expect(checkpoint.consecutiveUnproductiveWindows).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
