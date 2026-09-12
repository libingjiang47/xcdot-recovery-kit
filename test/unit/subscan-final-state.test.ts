import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { runSubscanImport } from '../../src/subscan/import.js';
import {
  verifySubscanFinalState,
  type FinalStateClient,
} from '../../src/verification/subscan-final-state.js';

const address = (suffix: string): string => `0x${suffix.padStart(40, '0')}`;
const blockHash = `0x${'ab'.repeat(32)}` as Hex;

async function makeDataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xcdot-final-state-'));
  await writeFile(
    join(root, 'page.csv'),
    `Rank,Account,Balance\n1,${address('1')},1\n2,${address('2')},2\n`,
    'utf8',
  );
  await runSubscanImport({ input: root, expectedFiles: 1 });
  return join(root, 'derived');
}

function mockClient(
  balances: Record<string, bigint>,
  options: {
    symbol?: unknown;
    decimals?: unknown;
    totalSupply?: bigint;
    failAddress?: string;
    failTotalSupply?: boolean;
    code?: Hex;
  } = {},
): FinalStateClient {
  return {
    getChainId: async () => 1284,
    getBlock: async () => ({ number: 16796696n, hash: blockHash }),
    getCode: async () => options.code ?? '0x6000',
    readContract: async ({ functionName, args }) => {
      if (functionName === 'symbol') return options.symbol ?? 'xcDOT';
      if (functionName === 'decimals') return options.decimals ?? 10;
      if (functionName === 'totalSupply' && options.failTotalSupply) {
        throw new Error('execution reverted');
      }
      if (functionName === 'totalSupply') return options.totalSupply ?? 30000000000n;
      const holder = String(args?.[0] ?? '').toLowerCase();
      if (holder === options.failAddress?.toLowerCase()) throw new Error('execution reverted');
      return balances[holder] ?? 0n;
    },
  };
}

async function dispose(dataset: string): Promise<void> {
  await rm(join(dataset, '..'), { recursive: true, force: true });
}

describe('Subscan final-state verification', () => {
  it('passes on exact balances and produces deterministic holders', async () => {
    const first = await makeDataset();
    const second = await makeDataset();
    try {
      const firstResult = await verifySubscanFinalState(
        {
          dataset: first,
          evmRpc: 'mock://moonbeam',
          blockNumber: '16796696',
          substrateBlockHash: `0x${'cd'.repeat(32)}`,
          concurrency: 2,
        },
        mockClient({ [address('1')]: 10000000000n, [address('2')]: 20000000000n }),
      );
      const secondResult = await verifySubscanFinalState(
        {
          dataset: second,
          evmRpc: 'mock://moonbeam',
          blockNumber: '16796696',
          substrateBlockHash: `0x${'cd'.repeat(32)}`,
          concurrency: 2,
        },
        mockClient({ [address('2')]: 20000000000n, [address('1')]: 10000000000n }),
      );
      expect(firstResult.status).toBe('FINAL_STATE_RPC_VERIFIED');
      expect(secondResult.summary).toMatchObject({ status: 'FINAL_STATE_RPC_VERIFIED' });
      expect(await readFile(join(first, 'final-state', 'holders.ndjson'), 'utf8')).toBe(
        await readFile(join(second, 'final-state', 'holders.ndjson'), 'utf8'),
      );
    } finally {
      await dispose(first);
      await dispose(second);
    }
  });

  it('reports mismatches while retaining final balances', async () => {
    const dataset = await makeDataset();
    try {
      const result = await verifySubscanFinalState(
        {
          dataset,
          evmRpc: 'mock://moonbeam',
          blockNumber: '16796696',
          substrateBlockHash: `0x${'cd'.repeat(32)}`,
        },
        mockClient({ [address('1')]: 20000000000n, [address('2')]: 10000000000n }),
      );
      expect(result.status).toBe('FINAL_STATE_RPC_VERIFIED');
      expect(result.summary).toMatchObject({
        holders: { balanceMismatches: 2 },
        checks: { subscanBalancesMatch: 'FAIL', supplyCompleteness: 'PASS' },
      });
      expect(await readFile(join(dataset, 'final-state', 'subscan-diff.ndjson'), 'utf8')).toContain(
        'deltaPlanck',
      );
    } finally {
      await dispose(dataset);
    }
  });

  it('fails closed on supply shortfall and records an incomplete report', async () => {
    const dataset = await makeDataset();
    try {
      await expect(
        verifySubscanFinalState(
          {
            dataset,
            evmRpc: 'mock://moonbeam',
            blockNumber: '16796696',
            substrateBlockHash: `0x${'cd'.repeat(32)}`,
          },
          mockClient({ [address('1')]: 10000000000n, [address('2')]: 0n }),
        ),
      ).rejects.toMatchObject({ code: 'FINAL_STATE_SUPPLY_SHORTFALL' });
      expect(await readFile(join(dataset, 'final-state', 'summary.json'), 'utf8')).toContain(
        'INCOMPLETE',
      );
    } finally {
      await dispose(dataset);
    }
  });

  it('retains RPC errors as incomplete and resumes with the matching context', async () => {
    const dataset = await makeDataset();
    try {
      await expect(
        verifySubscanFinalState(
          {
            dataset,
            evmRpc: 'mock://moonbeam',
            blockNumber: '16796696',
            substrateBlockHash: `0x${'cd'.repeat(32)}`,
          },
          mockClient(
            { [address('1')]: 10000000000n, [address('2')]: 20000000000n },
            { failAddress: address('2') },
          ),
        ),
      ).rejects.toMatchObject({ code: 'SUBSCAN_FINAL_STATE_VERIFICATION' });
      const resumed = await verifySubscanFinalState(
        {
          dataset,
          evmRpc: 'mock://moonbeam',
          blockNumber: '16796696',
          substrateBlockHash: `0x${'cd'.repeat(32)}`,
          resume: true,
          force: true,
        },
        mockClient({ [address('1')]: 10000000000n, [address('2')]: 20000000000n }),
      );
      expect(resumed.status).toBe('FINAL_STATE_RPC_VERIFIED');
      await expect(
        verifySubscanFinalState(
          {
            dataset,
            evmRpc: 'mock://moonbeam',
            blockNumber: '16796697',
            substrateBlockHash: `0x${'cd'.repeat(32)}`,
            resume: true,
            force: true,
          },
          mockClient({ [address('1')]: 10000000000n, [address('2')]: 20000000000n }),
        ),
      ).rejects.toMatchObject({ code: 'FINAL_STATE_RESUME_CONTEXT_MISMATCH' });
    } finally {
      await dispose(dataset);
    }
  });

  it('rejects wrong contract metadata before querying candidates', async () => {
    const dataset = await makeDataset();
    try {
      await expect(
        verifySubscanFinalState(
          {
            dataset,
            evmRpc: 'mock://moonbeam',
            blockNumber: '16796696',
            substrateBlockHash: `0x${'cd'.repeat(32)}`,
          },
          mockClient(
            { [address('1')]: 10000000000n, [address('2')]: 20000000000n },
            { symbol: 'DOT' },
          ),
        ),
      ).rejects.toMatchObject({ code: 'SUBSCAN_FINAL_STATE_VERIFICATION' });
    } finally {
      await dispose(dataset);
    }
  });

  it.each([
    ['empty code', { code: '0x' as Hex }],
    ['totalSupply failure', { failTotalSupply: true }],
    ['wrong decimals', { decimals: 9 }],
  ])('rejects %s at the pinned block', async (_label, options) => {
    const dataset = await makeDataset();
    try {
      await expect(
        verifySubscanFinalState(
          {
            dataset,
            evmRpc: 'mock://moonbeam',
            blockNumber: '16796696',
            substrateBlockHash: `0x${'cd'.repeat(32)}`,
          },
          mockClient({ [address('1')]: 10000000000n, [address('2')]: 20000000000n }, options),
        ),
      ).rejects.toMatchObject({ code: 'SUBSCAN_FINAL_STATE_VERIFICATION' });
    } finally {
      await dispose(dataset);
    }
  });
});
