import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  reconstructFinalState,
  retryFinalStateRpc,
  type FinalStateEvmClient,
} from '../../src/reconstruction/final-state.js';
import { XC_DOT_XC20_ADDRESS } from '../../src/asset/constants.js';
import {
  candidateAddressesSha256,
  discoverCandidateAddresses,
} from '../../src/subscan/candidates.js';

const blockHash = `0x${'ab'.repeat(32)}` as Hex;
const address = (suffix: string): string => `0x${suffix.padStart(40, '0')}`;

function mockClient(
  balances: Record<string, bigint>,
  options: { blockHash?: Hex; failAddress?: string; code?: Hex; totalSupply?: bigint } = {},
): FinalStateEvmClient {
  return {
    getChainId: async () => 1284,
    getBlock: async ({ blockNumber }) => ({
      number: blockNumber,
      hash: options.blockHash ?? blockHash,
    }),
    getCode: async () => options.code ?? '0x6000',
    readContract: async ({ functionName, args }) => {
      if (functionName === 'symbol') return 'xcDOT';
      if (functionName === 'decimals') return 10;
      if (functionName === 'totalSupply')
        return (
          options.totalSupply ?? Object.values(balances).reduce((sum, value) => sum + value, 0n)
        );
      const holder = String(args?.[0] ?? '').toLowerCase();
      if (holder === options.failAddress?.toLowerCase()) throw new Error('provider unavailable');
      return balances[holder] ?? 0n;
    },
  };
}

async function makeDataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xcdot-final-reconstruction-'));
  await writeFile(
    join(root, 'page.csv'),
    `Rank,Account,Balance\n1,${address('1')},1\n2,${address('2')},2\n`,
    'utf8',
  );
  return root;
}

async function makeRunOptions(root: string, overrides: Record<string, unknown> = {}) {
  return {
    dataset: root,
    evmRpc: 'mock://moonbeam',
    blockNumber: '16796696',
    expectedCandidateCount: 2,
    retries: 1,
    delayMs: 0,
    timeoutMs: 1000,
    out: join(root, 'out'),
    workDirectory: join(root, 'work'),
    ...overrides,
  } as const;
}

describe('v0.26 final EVM-state reconstruction', () => {
  it('deduplicates valid H160 membership and excludes the invalid Rank 565 row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-candidate-discovery-'));
    try {
      await writeFile(
        join(root, 'page.csv'),
        `Rank,Account,Balance\n1,${address('A')},1\n2,${address('a')},1\n3,,14.3274324851\n4,${address('2')},2\n`,
        'utf8',
      );
      const discovery = await discoverCandidateAddresses(root);
      expect(discovery.addresses).toEqual([address('2'), address('a')]);
      expect(discovery.validRowCount).toBe(3);
      expect(discovery.invalidRowCount).toBe(1);
      expect(discovery.exactDuplicateAddressCount).toBe(1);
      expect(candidateAddressesSha256(discovery.addresses)).toBe(
        '663ba4f654b91916a10b4c1efcaffd412e02e4013a2071e1f5650a477d85f8ba',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reproduces the frozen 7288-address candidate set digest', async () => {
    const discovery = await discoverCandidateAddresses('snapshots/subscan');
    expect(discovery.rawFileCount).toBe(73);
    expect(discovery.rawRowCount).toBe(7290);
    expect(discovery.validRowCount).toBe(7289);
    expect(discovery.invalidRowCount).toBe(1);
    expect(discovery.addresses.length).toBe(7288);
    expect(candidateAddressesSha256(discovery.addresses)).toBe(
      '1a9aee3427b27d051cb1e1f6aa599d44f8f9d91ca9f868f082b6703c1853cfff',
    );
  });

  it('uses address-only candidates and accepts exact final supply despite Subscan differences', async () => {
    const root = await makeDataset();
    try {
      const result = await reconstructFinalState(
        await makeRunOptions(root),
        mockClient({ [address('1')]: 1n, [address('2')]: 2n }),
      );
      expect(result.status).toBe('FINAL_STATE_RPC_VERIFIED');
      expect(result.summary.finalState).toMatchObject({
        successful: 2,
        positive: 2,
        zero: 0,
        knownFinalSumPlanck: '3',
        unaccountedSupplyPlanck: '0',
        subscanBalanceMatchCount: 0,
        subscanBalanceMismatchCount: 2,
      });
      expect(await readFile(join(root, 'out', 'candidate-addresses.ndjson'), 'utf8')).toBe(
        `{"address":"${address('1')}"}\n{"address":"${address('2')}"}\n`,
      );
      expect(await readFile(join(root, 'out', 'evm-rpc', 'positive-holders.ndjson'), 'utf8')).toBe(
        `{"address":"${address('1')}","balancePlanck":"1"}\n{"address":"${address('2')}","balancePlanck":"2"}\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies zero balances, shortfall, and overflow without changing the query set', async () => {
    const root = await makeDataset();
    try {
      const zero = await reconstructFinalState(
        await makeRunOptions(root, {
          out: join(root, 'zero-out'),
          workDirectory: join(root, 'zero-work'),
        }),
        mockClient({ [address('1')]: 0n, [address('2')]: 1n }, { totalSupply: 3n }),
      );
      expect(zero.status).toBe('FINAL_STATE_SUPPLY_SHORTFALL');
      expect(zero.summary.finalState.zero).toBe(1);
      expect(zero.summary.rank565.requiredForFinalCompleteness).toBe(null);
      expect(
        await readFile(join(root, 'zero-out', 'evm-rpc', 'zero-balance-candidates.ndjson'), 'utf8'),
      ).toBe(`{"address":"${address('1')}"}\n`);

      const rank565 = await reconstructFinalState(
        await makeRunOptions(root, {
          out: join(root, 'rank565-out'),
          workDirectory: join(root, 'rank565-work'),
        }),
        mockClient({ [address('1')]: 0n, [address('2')]: 0n }, { totalSupply: 143274324851n }),
      );
      expect(rank565.status).toBe('FINAL_STATE_SUPPLY_SHORTFALL');
      expect(rank565.summary.rank565.requiredForFinalCompleteness).toBe(true);

      const overflow = await reconstructFinalState(
        await makeRunOptions(root, {
          out: join(root, 'overflow-out'),
          workDirectory: join(root, 'overflow-work'),
        }),
        mockClient({ [address('1')]: 2n, [address('2')]: 2n }, { totalSupply: 3n }),
      );
      expect(overflow.status).toBe('FINAL_STATE_SUPPLY_OVERFLOW');
      expect(overflow.summary.finalState.unaccountedSupplyPlanck).toBe('-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('resumes successful addresses and rejects a changed pinned context', async () => {
    const root = await makeDataset();
    try {
      const first = await reconstructFinalState(
        await makeRunOptions(root, { out: join(root, 'resume-out') }),
        mockClient({ [address('1')]: 1n, [address('2')]: 2n }, { failAddress: address('2') }),
      );
      expect(first.status).toBe('FINAL_STATE_INCOMPLETE');
      const resumed = await reconstructFinalState(
        await makeRunOptions(root, { resume: true, out: join(root, 'resume-out') }),
        mockClient({ [address('1')]: 1n, [address('2')]: 2n }),
      );
      expect(resumed.status).toBe('FINAL_STATE_RPC_VERIFIED');
      expect(resumed.summary.finalState.queried).toBe(2);

      await expect(
        reconstructFinalState(
          await makeRunOptions(root, {
            resume: true,
            out: join(root, 'resume-out'),
          }),
          mockClient(
            { [address('1')]: 1n, [address('2')]: 2n },
            { blockHash: `0x${'cd'.repeat(32)}` as Hex },
          ),
        ),
      ).rejects.toMatchObject({ code: 'FINAL_STATE_RESUME_CONTEXT_MISMATCH' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects conflicting successful checkpoint records', async () => {
    const root = await makeDataset();
    try {
      const options = await makeRunOptions(root, { out: join(root, 'conflict-out') });
      await reconstructFinalState(options, mockClient({ [address('1')]: 1n, [address('2')]: 2n }));
      await appendFile(
        join(root, 'work', 'results.ndjson'),
        `{"address":"${address('1')}","finalBalancePlanck":"9","status":"SUCCESS"}\n`,
        'utf8',
      );
      await expect(
        reconstructFinalState(
          { ...options, resume: true },
          mockClient({ [address('1')]: 1n, [address('2')]: 2n }),
        ),
      ).rejects.toMatchObject({ code: 'FINAL_STATE_BALANCE_CONFLICT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the bounded 1,2,4,8 second transient retry schedule', async () => {
    let calls = 0;
    const delays: number[] = [];
    const value = await retryFinalStateRpc(
      async () => {
        calls += 1;
        if (calls < 5) throw new Error('HTTP 503');
        return 'ok';
      },
      { attempts: 5, sleep: async (milliseconds) => delays.push(milliseconds) },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it('keeps final artifacts deterministic when concurrency changes', async () => {
    const root = await makeDataset();
    try {
      const balances = { [address('1')]: 10n, [address('2')]: 20n };
      const first = await reconstructFinalState(
        await makeRunOptions(root, {
          concurrency: 1,
          out: join(root, 'serial-out'),
          workDirectory: join(root, 'serial-work'),
        }),
        mockClient(balances),
      );
      const second = await reconstructFinalState(
        await makeRunOptions(root, {
          concurrency: 2,
          out: join(root, 'parallel-out'),
          workDirectory: join(root, 'parallel-work'),
        }),
        mockClient({ ...balances }),
      );
      expect(first.summary.candidateSet.candidateAddressesSha256).toBe(
        second.summary.candidateSet.candidateAddressesSha256,
      );
      expect(
        await readFile(join(root, 'serial-out', 'evm-rpc', 'positive-holders.ndjson'), 'utf8'),
      ).toBe(
        await readFile(join(root, 'parallel-out', 'evm-rpc', 'positive-holders.ndjson'), 'utf8'),
      );
      expect(XC_DOT_XC20_ADDRESS).toBe('0xffffffff1fcacbd218edc0eba20fc2308c778080');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
