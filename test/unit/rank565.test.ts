import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  exactBalanceCandidates,
  expectedRank565UniqueTotal,
  RANK565_BLOCK_NUMBER,
  RANK565_MISSING_BALANCE_PLANCK,
  runRank565Diagnostic,
  scanTransferHistory,
  setDifference,
  type Rank565EvmClient,
  type Rank565Log,
} from '../../src/diagnostics/rank565.js';
import { XC_DOT_XC20_ADDRESS } from '../../src/asset/constants.js';

const address = (suffix: string): Address => `0x${suffix.padStart(40, '0')}` as Address;
const blockHash = `0x${'ab'.repeat(32)}` as Hex;

function topic(value: Address): Hex {
  return `0x${value.slice(2).padStart(64, '0')}` as Hex;
}

function transferLog(
  blockNumber: bigint,
  from: Address,
  to: Address,
  amountPlanck: string,
  logIndex = 0,
): Rank565Log {
  return {
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    logIndex,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      topic(from),
      topic(to),
    ],
    data: `0x${BigInt(amountPlanck).toString(16).padStart(64, '0')}` as Hex,
  };
}

function mockClient(
  balances: Record<string, bigint>,
  totalSupply: bigint,
  getLogs: Rank565EvmClient['getLogs'] = async () => [],
): Rank565EvmClient {
  return {
    getChainId: async () => 1284,
    getBlock: async () => ({ number: BigInt(RANK565_BLOCK_NUMBER), hash: blockHash }),
    getCode: async ({ address: queried }) =>
      queried.toLowerCase() === '0x0000000000000000000000000000000000000000' ? '0x' : '0x6000',
    readContract: async ({ functionName, args }) => {
      if (functionName === 'symbol') return 'xcDOT';
      if (functionName === 'decimals') return 10;
      if (functionName === 'totalSupply') return totalSupply;
      return balances[String(args?.[0] ?? '').toLowerCase()] ?? 0n;
    },
    getLogs,
  };
}

async function dispose(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

describe('Rank 565 diagnostic helpers', () => {
  it('computes the expected unique total using exact integer arithmetic', () => {
    expect(expectedRank565UniqueTotal('3054639787186518')).toBe('3054783061511369');
    expect(RANK565_MISSING_BALANCE_PLANCK).toBe('143274324851');
  });

  it('computes deterministic case-insensitive set differences', () => {
    expect(
      setDifference([address('b').toUpperCase(), address('a'), address('b')], [address('a')]),
    ).toEqual([address('b').toLowerCase()]);
  });

  it('returns one exact candidate and rejects duplicate candidate records', () => {
    expect(
      exactBalanceCandidates(
        [
          { address: address('1'), balancePlanck: RANK565_MISSING_BALANCE_PLANCK },
          { address: address('1').toUpperCase(), balancePlanck: RANK565_MISSING_BALANCE_PLANCK },
          { address: address('2'), balancePlanck: '1' },
        ],
        RANK565_MISSING_BALANCE_PLANCK,
      ),
    ).toEqual([address('1')]);
  });

  it('distinguishes zero, one, and multiple exact candidates', () => {
    const records = [
      { address: address('1'), balancePlanck: RANK565_MISSING_BALANCE_PLANCK },
      { address: address('2'), balancePlanck: RANK565_MISSING_BALANCE_PLANCK },
    ];
    expect(exactBalanceCandidates([], RANK565_MISSING_BALANCE_PLANCK)).toEqual([]);
    expect(
      exactBalanceCandidates(records.slice(0, 1), RANK565_MISSING_BALANCE_PLANCK),
    ).toHaveLength(1);
    expect(exactBalanceCandidates(records, RANK565_MISSING_BALANCE_PLANCK)).toHaveLength(2);
  });

  it('records zero-address evidence and leaves the importer anomaly unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-rank565-'));
    const output = join(root, 'diagnostics');
    const dataset = join(root, 'dataset');
    await mkdir(dataset, { recursive: true });
    await writeFile(
      join(dataset, 'page.csv'),
      `Rank,Account,Balance\n1,${address('1')},1\n2,${address('2')},2\n565,,14.3274324851\n`,
      'utf8',
    );
    try {
      const result = await runRank565Diagnostic(
        {
          dataset,
          evmRpc: 'mock://moonbeam',
          blockNumber: RANK565_BLOCK_NUMBER,
          output,
        },
        mockClient(
          { [address('1')]: 10_000_000_000n, [address('2')]: 20_000_000_000n },
          173_274_324_851n,
        ),
      );
      expect(result.status).toBe('UNRESOLVED');
      expect(result.report.zeroAddressBalancePlanck).toBe('0');
      expect(result.report.invalidRowCount).toBe(1);
      expect(result.report.invalidRows[0]).toMatchObject({
        rank: '565',
        account: '',
        balance: '14.3274324851',
        errorCode: 'SUBSCAN_INVALID_ADDRESS',
      });
      expect(result.report.limitations.join('\n')).toContain('start block');
      expect(await readFile(join(output, 'zero-address.json'), 'utf8')).toContain(
        '"balancePlanck": "0"',
      );
      expect(await readFile(join(dataset, 'page.csv'), 'utf8')).toContain(
        '2,0x0000000000000000000000000000000000000002,2',
      );
    } finally {
      await dispose(root);
    }
  });

  it('resumes a contiguous Transfer scan after a failed range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-rank565-scan-'));
    let failSecondRange = true;
    const first = address('1');
    const second = address('2');
    const client = mockClient({}, 0n, async ({ fromBlock, toBlock: _toBlock }) => {
      if (fromBlock === 3n && failSecondRange) throw new Error('provider stopped');
      return fromBlock === 1n
        ? [transferLog(1n, address('0'), first, '1')]
        : [transferLog(3n, first, second, '1')];
    });
    try {
      await expect(
        scanTransferHistory(
          root,
          client,
          XC_DOT_XC20_ADDRESS as Address,
          4n,
          1n,
          2,
          false,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'RANK565_DIAGNOSTIC_FAILED' });
      failSecondRange = false;
      const resumed = await scanTransferHistory(
        root,
        client,
        XC_DOT_XC20_ADDRESS as Address,
        4n,
        1n,
        2,
        true,
        () => undefined,
      );
      expect(resumed.records).toHaveLength(2);
      expect(resumed.ranges).toEqual([
        { fromBlock: '1', toBlock: '2', logCount: 1 },
        { fromBlock: '3', toBlock: '4', logCount: 1 },
      ]);
    } finally {
      await dispose(root);
    }
  });

  it('halves a rejected log range without skipping blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-rank565-range-'));
    const calls: string[] = [];
    const client = mockClient({}, 0n, async ({ fromBlock, toBlock }) => {
      calls.push(`${fromBlock}-${toBlock}`);
      if (toBlock - fromBlock + 1n > 1n) throw new Error('block range too wide');
      return [];
    });
    try {
      const result = await scanTransferHistory(
        root,
        client,
        XC_DOT_XC20_ADDRESS as Address,
        4n,
        1n,
        4,
        false,
        () => undefined,
      );
      expect(result.ranges).toEqual([
        { fromBlock: '1', toBlock: '1', logCount: 0 },
        { fromBlock: '2', toBlock: '2', logCount: 0 },
        { fromBlock: '3', toBlock: '3', logCount: 0 },
        { fromBlock: '4', toBlock: '4', logCount: 0 },
      ]);
      expect(calls).toEqual(['1-4', '1-2', '1-1', '2-2', '3-3', '4-4']);
    } finally {
      await dispose(root);
    }
  });
});
