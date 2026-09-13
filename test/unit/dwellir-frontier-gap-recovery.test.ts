import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XC_DOT_XC20_ADDRESS, MOONBEAM_GENESIS_HASH } from '../../src/asset/constants.js';
import {
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
} from '../../src/final-state/constants.js';
import {
  runDwellirFrontierGapRecovery,
  type DwellirFrontierGapOptions,
} from '../../src/storage/dwellir-frontier-gap-recovery.js';
import { deriveBalanceAccountStoragesKeyDirect } from '../../src/storage/substrate-evm.js';
import { encodeU256Storage } from '../../src/storage/solidity.js';
import type { DwellirRpcTransport, FinalBalanceResult } from '../../src/sqd/backward-recovery.js';
import { TRANSFER_TOPIC0 } from '../../src/sqd/client.js';

const ADDRESS_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDRESS_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDRESS_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const ADDRESS_D = '0xdddddddddddddddddddddddddddddddddddddddd';
const ADDRESS_E = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ADDRESS_F = '0xffffffffffffffffffffffffffffffffffffffff';
const INDEXED_HEAD_HASH = `0x${'11'.repeat(32)}`;

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function indexed(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function transfer(from: string, to: string, blockNumber: number): Record<string, unknown> {
  return {
    address: XC_DOT_XC20_ADDRESS,
    blockNumber: quantity(blockNumber),
    topics: [TRANSFER_TOPIC0, indexed(from), indexed(to)],
  };
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

function baseFixture(values: readonly [string, bigint][]): {
  candidates: string[];
  balances: FinalBalanceResult[];
} {
  return {
    candidates: values.map(([address]) => address),
    balances: values.map(([address, value]) => candidateBalance(address, value)),
  };
}

class FakeDwellir implements DwellirRpcTransport {
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];
  readonly storageKeys: string[] = [];
  readonly proofKeys: string[] = [];
  private proofFailures = 0;
  private storageFailures = 0;

  constructor(
    private readonly options: {
      finalBlock: number;
      indexedHead?: number;
      logs?: (fromBlock: number, toBlock: number) => unknown[];
      balances?: ReadonlyMap<string, string | null>;
      failProofFor?: string;
      failStorageFor?: string;
    },
  ) {}

  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'moon_getEthSyncBlockRange') {
      return [MOONBEAM_GENESIS_HASH, INDEXED_HEAD_HASH];
    }
    if (method === 'chain_getHeader') {
      return { number: quantity(this.options.indexedHead ?? this.options.finalBlock) };
    }
    if (method === 'eth_getBlockByNumber') {
      return { number: quantity(this.options.finalBlock), hash: MOONBEAM_OBSERVED_EVM_BLOCK_HASH };
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const fromBlock = Number(BigInt(filter.fromBlock));
      const toBlock = Number(BigInt(filter.toBlock));
      return this.options.logs?.(fromBlock, toBlock) ?? [];
    }
    if (method === 'state_getStorage') {
      const key = String(params[0]);
      if (key === this.options.failStorageFor && this.storageFailures === 0) {
        this.storageFailures += 1;
        throw new Error('simulated balance interruption');
      }
      this.storageKeys.push(key);
      if (!this.options.balances?.has(key)) throw new Error(`unexpected storage key ${key}`);
      return this.options.balances.get(key);
    }
    if (method === 'state_getReadProof') {
      const keys = params[0] as string[];
      const key = String(keys[0]);
      this.proofKeys.push(key);
      if (key === this.options.failProofFor && this.proofFailures === 0) {
        this.proofFailures += 1;
        throw new Error('simulated proof interruption');
      }
      return { at: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH, proof: ['0xaa'] };
    }
    throw new Error(`unexpected method ${method}`);
  }

  async batch(): Promise<unknown[]> {
    throw new Error('batch must not be used by the Frontier gap scanner');
  }
}

function options(
  root: string,
  base: { candidates: string[]; balances: FinalBalanceResult[] },
  transport: DwellirRpcTransport,
  overrides: Partial<DwellirFrontierGapOptions> = {},
): DwellirFrontierGapOptions {
  return {
    work: join(root, 'gap'),
    priorWork: join(root, 'prior'),
    baseCandidates: base.candidates,
    baseBalances: base.balances,
    gapStart: 1,
    gapEnd: 2_500,
    logWindowBlocks: 1_000,
    totalSupplyPlanck: '10',
    transport,
    ...overrides,
  };
}

describe('Dwellir Frontier coverage-gap recovery', () => {
  it('resolves the sync range and validates the Frontier genesis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-frontier-gap-sync-'));
    try {
      const base = baseFixture([[ADDRESS_A, 10n]]);
      const transport = new FakeDwellir({ finalBlock: 2_500 });
      const result = await runDwellirFrontierGapRecovery(options(root, base, transport));
      expect(result.summary.preflight).toMatchObject({
        genesisHash: MOONBEAM_GENESIS_HASH,
        indexedHeadHash: INDEXED_HEAD_HASH,
        indexedHeadNumber: 2_500,
        frontierGapCoverage: 'PASS',
      });
      expect(transport.calls.slice(0, 3).map((call) => call.method)).toEqual([
        'moon_getEthSyncBlockRange',
        'chain_getHeader',
        'eth_getBlockByNumber',
      ]);
      expect(transport.calls.some((call) => call.method === 'eth_getLogs')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('stops as too shallow before issuing eth_getLogs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-frontier-gap-shallow-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      const transport = new FakeDwellir({ finalBlock: 2_500, indexedHead: 1_999 });
      const result = await runDwellirFrontierGapRecovery(options(root, base, transport));
      expect(result.summary.status).toBe('DWELLIR_FRONTIER_INDEX_TOO_SHALLOW');
      expect(result.summary.preflight.frontierGapCoverage).toBe('FAIL');
      expect(transport.calls.some((call) => call.method === 'eth_getLogs')).toBe(false);
      expect(transport.calls.some((call) => call.method === 'eth_getBlockByNumber')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('scans inclusive ranges backward without overlap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-frontier-gap-ranges-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      const transport = new FakeDwellir({ finalBlock: 2_500 });
      const result = await runDwellirFrontierGapRecovery(
        options(root, base, transport, { totalSupplyPlanck: '2' }),
      );
      const ranges = transport.calls
        .filter((call) => call.method === 'eth_getLogs')
        .map((call) => {
          const filter = call.params[0] as { fromBlock: string; toBlock: string };
          return [Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))];
        });
      expect(ranges).toEqual([
        [1_501, 2_500],
        [501, 1_500],
        [1, 500],
      ]);
      expect(result.summary.status).toBe('GAP_EXHAUSTED_WITH_SHORTFALL');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('queries only truly new candidates from Transfer participants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-frontier-gap-new-'));
    try {
      const base = baseFixture([
        [ADDRESS_A, 1n],
        [ADDRESS_B, 0n],
        [ADDRESS_C, 0n],
      ]);
      const d = candidateBalance(ADDRESS_D, 4n);
      const e = candidateBalance(ADDRESS_E, 5n);
      const transport = new FakeDwellir({
        finalBlock: 2_500,
        balances: new Map([
          [d.substrateStorageKey, d.rawValue],
          [e.substrateStorageKey, e.rawValue],
        ]),
        logs: (_from, to) => [
          transfer(ADDRESS_B, ADDRESS_D, to),
          transfer(ADDRESS_C, ADDRESS_E, to),
        ],
      });
      const result = await runDwellirFrontierGapRecovery(options(root, base, transport));
      expect(result.summary.status).toBe('SUPPLY_COMPLETE');
      expect(transport.storageKeys).toEqual([d.substrateStorageKey, e.substrateStorageKey].sort());
      expect(transport.storageKeys).not.toContain(
        deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, ADDRESS_B, 0n)
          .substrateStorageKey,
      );
      expect(result.summary.newCandidatesTotal).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('completes supply early and captures proofs only for positive candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-frontier-gap-early-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      const d = candidateBalance(ADDRESS_D, 2n);
      const e = candidateBalance(ADDRESS_E, 0n);
      const transport = new FakeDwellir({
        finalBlock: 2_500,
        balances: new Map([
          [d.substrateStorageKey, d.rawValue],
          [e.substrateStorageKey, e.rawValue],
        ]),
        logs: (_from, to) => [
          transfer(ADDRESS_A, ADDRESS_D, to),
          transfer(ADDRESS_A, ADDRESS_E, to),
        ],
      });
      const result = await runDwellirFrontierGapRecovery(
        options(root, base, transport, { totalSupplyPlanck: '3' }),
      );
      expect(result.summary.status).toBe('SUPPLY_COMPLETE');
      expect(transport.calls.filter((call) => call.method === 'eth_getLogs')).toHaveLength(1);
      expect(transport.storageKeys).toEqual([d.substrateStorageKey, e.substrateStorageKey].sort());
      expect(transport.proofKeys).toEqual([d.substrateStorageKey]);
      expect(result.summary.proofsCaptured).toBe(1);
      expect(result.summary.finalStateRoot).toBe(MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reuses partial balance cache on resume and queries only the missing address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-frontier-gap-resume-'));
    try {
      const base = baseFixture([[ADDRESS_A, 1n]]);
      const d = candidateBalance(ADDRESS_D, 2n);
      const e = candidateBalance(ADDRESS_E, 3n);
      const f = candidateBalance(ADDRESS_F, 4n);
      const balances = new Map([
        [d.substrateStorageKey, d.rawValue],
        [e.substrateStorageKey, e.rawValue],
        [f.substrateStorageKey, f.rawValue],
      ]);
      const firstTransport = new FakeDwellir({
        finalBlock: 2_500,
        balances,
        failStorageFor: f.substrateStorageKey,
        logs: (_from, to) => [
          transfer(ADDRESS_A, ADDRESS_D, to),
          transfer(ADDRESS_A, ADDRESS_E, to),
          transfer(ADDRESS_A, ADDRESS_F, to),
        ],
      });
      await expect(
        runDwellirFrontierGapRecovery(
          options(root, base, firstTransport, { totalSupplyPlanck: '10' }),
        ),
      ).rejects.toThrow('simulated balance interruption');
      expect(firstTransport.storageKeys.slice().sort()).toEqual(
        [d.substrateStorageKey, e.substrateStorageKey].sort(),
      );
      const secondTransport = new FakeDwellir({
        finalBlock: 2_500,
        balances,
        logs: (_from, to) => [
          transfer(ADDRESS_A, ADDRESS_D, to),
          transfer(ADDRESS_A, ADDRESS_E, to),
          transfer(ADDRESS_A, ADDRESS_F, to),
        ],
      });
      const resumed = await runDwellirFrontierGapRecovery(
        options(root, base, secondTransport, { totalSupplyPlanck: '10', resume: true }),
      );
      expect(secondTransport.storageKeys).toEqual([f.substrateStorageKey]);
      expect(resumed.summary.status).toBe('SUPPLY_COMPLETE');
      expect(resumed.summary.finalKnownSumPlanck).toBe('10');
      expect(JSON.parse(await readFile(join(root, 'gap', 'checkpoint.json'), 'utf8')).status).toBe(
        'SUPPLY_COMPLETE',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
