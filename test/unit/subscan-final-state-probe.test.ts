import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runSubscanFinalStateProbe,
  SUBSCAN_FINAL_STATE_PROBE_CONTRACT,
  SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT,
  SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY,
  parseSubscanHistoricalInteger,
} from '../../src/diagnostics/subscan-final-state.js';

const address = (suffix: string): string => `0x${suffix.padStart(40, '0')}`;

const capabilities = {
  schema_version: 1,
  generation: { id: 'generation-test' },
  capabilities: [
    {
      capability_id: 'header-template',
      provider_key: 'subscan',
      matcher: {
        kind: 'template',
        path: '/v1/gateway/subscan/{network}/api/scan/header',
      },
      methods: ['POST'],
      operations: [{ method: 'POST', billing: { mode: 'metered' } }],
      free_rate_limit: { requests_per_second: 2 },
      readiness: { status: 'ready' },
    },
    {
      capability_id: 'etherscan-template',
      provider_key: 'subscan',
      matcher: {
        kind: 'template',
        path: '/v1/gateway/subscan/{network}/api/scan/evm/etherscan',
      },
      methods: ['GET'],
      operations: [{ method: 'GET', billing: { mode: 'metered' } }],
      free_rate_limit: { requests_per_second: 2 },
      readiness: { status: 'ready' },
    },
  ],
};

const openapi = {
  openapi: '3.1.0',
  info: { version: 'runtime-test' },
  paths: {
    '/v1/gateway/subscan/{network}/api/scan/header': {
      post: {
        'x-pubfi-registry-readiness': { status: 'ready' },
        'x-pubfi-free-variant': { suffix: ':free' },
      },
    },
    '/v1/gateway/subscan/{network}/api/scan/evm/etherscan': {
      get: {
        'x-pubfi-registry-readiness': { status: 'ready' },
        'x-pubfi-free-variant': { suffix: ':free' },
      },
    },
  },
};

function candidateText(): string {
  return (
    [1, 2, 3, 4, 5].map((value) => JSON.stringify({ address: address(String(value)) })).join('\n') +
    '\n'
  );
}

interface MockOptions {
  stateRoot?: string;
  totalSupply?: string;
  invalidBalanceAddress?: string;
}

async function makeDataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xcdot-subscan-probe-'));
  await writeFile(join(root, 'candidate-addresses.ndjson'), candidateText(), 'utf8');
  return root;
}

function makeFetch(options: MockOptions = {}): {
  fetchImpl: typeof fetch;
  calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: string | undefined;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: string | undefined;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const parsed = new URL(url);
    let payload: unknown;
    if (parsed.pathname === '/v1/capabilities') {
      payload = { ...capabilities, next_cursor: null };
    } else if (parsed.pathname === '/openapi.json') {
      payload = openapi;
    } else if (parsed.pathname.endsWith('/api/scan/header:free')) {
      payload = {
        code: 0,
        message: 'Success',
        api_key: 'test-key',
        data: {
          block_num: 16796696,
          state_root: options.stateRoot ?? SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT,
          parent_hash: `0x${'11'.repeat(32)}`,
          extrinsics_root: `0x${'22'.repeat(32)}`,
        },
      };
    } else if (parsed.pathname.endsWith('/api/scan/evm/etherscan:free')) {
      const module = parsed.searchParams.get('module');
      const action = parsed.searchParams.get('action');
      if (module === 'stats' && action === 'tokensupplyhistory') {
        payload = {
          status: '1',
          message: 'OK',
          result: options.totalSupply ?? SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY,
        };
      } else if (module === 'account' && action === 'tokenbalancehistory') {
        const queriedAddress = parsed.searchParams.get('address');
        payload = {
          status: '1',
          message: 'OK',
          result: queriedAddress === options.invalidBalanceAddress ? '1.5' : '0',
        };
      } else {
        throw new Error(`Unexpected Etherscan query: ${parsed.search}`);
      }
    } else {
      throw new Error(`Unexpected mock URL: ${url}`);
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

async function runProbe(
  dataset: string,
  options: MockOptions = {},
): Promise<Awaited<ReturnType<typeof runSubscanFinalStateProbe>>> {
  const mock = makeFetch(options);
  const result = await runSubscanFinalStateProbe({
    dataset,
    out: join(dataset, 'diagnostics'),
    pubfiKey: 'test-key',
    apiOrigin: 'https://api.pubfi.ai',
    timeoutMs: 1000,
    retries: 1,
    delayMs: 0,
    fetchImpl: mock.fetchImpl,
    sleep: async () => undefined,
  });
  return { ...result, calls: mock.calls } as Awaited<
    ReturnType<typeof runSubscanFinalStateProbe>
  > & { calls: typeof mock.calls };
}

describe('Subscan/PubFi final-state minimal probe', () => {
  it('discovers current routes and passes header, supply, and five integer balances', async () => {
    const dataset = await makeDataset();
    try {
      const result = await runProbe(dataset);
      expect(result.report).toMatchObject({
        pubfiKeyPresent: true,
        pubfiHeaderRouteReady: true,
        pubfiEtherscanRouteReady: true,
        headerQuery: 'PASS',
        headerStateRootMatch: 'PASS',
        totalSupplyQuery: 'PASS',
        totalSupplyMatch: 'PASS',
        sampleAddressCount: 5,
        sampleBalanceSuccessCount: 5,
        historicalBalanceQuery: 'PASS',
        canUseSubscanForFinalBalances: 'true',
        status: 'SUBSCAN_FINAL_STATE_CAPABLE',
      });
      expect(result.report.observedStateRoot).toBe(SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT);
      expect(result.report.observedTotalSupplyPlanck).toBe(SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY);
      const gatewayCalls = result.calls.filter((call) => call.url.includes('/v1/gateway/'));
      expect(gatewayCalls).toHaveLength(7);
      expect(gatewayCalls.every((call) => call.authorization === 'Bearer test-key')).toBe(true);
      expect(gatewayCalls[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/v1/gateway/subscan/moonbeam/api/scan/header:free'),
        body: JSON.stringify({ block_num: 16796696 }),
      });
      expect(gatewayCalls[1]?.url).toContain('module=stats');
      expect(gatewayCalls.slice(2).every((call) => call.url.includes('module=account'))).toBe(true);
      expect(
        gatewayCalls
          .slice(1)
          .every((call) =>
            call.url.includes(`contractaddress=${SUBSCAN_FINAL_STATE_PROBE_CONTRACT}`),
          ),
      ).toBe(true);
      for (const name of [
        'README.md',
        'header.json',
        'total-supply.json',
        'sample-balances.ndjson',
        'report.txt',
      ]) {
        expect(await readFile(join(dataset, 'diagnostics', name), 'utf8')).not.toContain(
          'test-key',
        );
      }
      expect(await readFile(join(dataset, 'diagnostics', 'header.json'), 'utf8')).toContain(
        '[REDACTED]',
      );
      expect(
        await readFile(join(dataset, 'diagnostics', 'sample-balances.ndjson'), 'utf8'),
      ).toContain(`"address":"${address('1')}"`);
    } finally {
      await rm(dataset, { recursive: true, force: true });
    }
  });

  it('stops on an exact header state-root mismatch before supply or balances', async () => {
    const dataset = await makeDataset();
    try {
      const result = await runProbe(dataset, { stateRoot: `0x${'33'.repeat(32)}` });
      expect(result.report).toMatchObject({
        headerQuery: 'PASS',
        headerStateRootMatch: 'FAIL',
        totalSupplyQuery: 'NOT_RUN',
        sampleBalanceSuccessCount: 0,
        canUseSubscanForFinalBalances: 'false',
        status: 'SUBSCAN_BLOCK_MISMATCH',
      });
      expect(result.calls.some((call) => call.url.includes('tokensupplyhistory'))).toBe(false);
    } finally {
      await rm(dataset, { recursive: true, force: true });
    }
  });

  it('stops on a total-supply mismatch before balance queries', async () => {
    const dataset = await makeDataset();
    try {
      const result = await runProbe(dataset, { totalSupply: '1' });
      expect(result.report).toMatchObject({
        headerStateRootMatch: 'PASS',
        totalSupplyQuery: 'PASS',
        totalSupplyMatch: 'FAIL',
        observedTotalSupplyPlanck: '1',
        historicalBalanceQuery: 'NOT_RUN',
        canUseSubscanForFinalBalances: 'false',
        status: 'SUBSCAN_HISTORICAL_STATE_MISMATCH',
      });
      expect(result.calls.some((call) => call.url.includes('tokenbalancehistory'))).toBe(false);
    } finally {
      await rm(dataset, { recursive: true, force: true });
    }
  });

  it('classifies an invalid historical balance result as unavailable after five attempts', async () => {
    const dataset = await makeDataset();
    try {
      const result = await runProbe(dataset, { invalidBalanceAddress: address('3') });
      expect(result.report).toMatchObject({
        sampleAddressCount: 5,
        sampleBalanceSuccessCount: 4,
        historicalBalanceQuery: 'FAIL',
        canUseSubscanForFinalBalances: 'false',
        status: 'SUBSCAN_BALANCE_HISTORY_UNAVAILABLE',
      });
      expect(result.calls.filter((call) => call.url.includes('tokenbalancehistory'))).toHaveLength(
        5,
      );
      expect(
        await readFile(join(dataset, 'diagnostics', 'sample-balances.ndjson'), 'utf8'),
      ).toContain('not a decimal unsigned integer');
    } finally {
      await rm(dataset, { recursive: true, force: true });
    }
  });

  it('parses only non-negative decimal integers without floating point', () => {
    expect(parseSubscanHistoricalInteger('2334516727484230', 'balance')).toBe('2334516727484230');
    expect(parseSubscanHistoricalInteger(0, 'balance')).toBe('0');
    expect(() => parseSubscanHistoricalInteger('1.5', 'balance')).toThrow(
      'balance is not a decimal unsigned integer',
    );
  });
});
