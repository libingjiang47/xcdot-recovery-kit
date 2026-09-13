import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractIndexedAddress,
  parseSqdJsonl,
  runSqdCandidateDiscovery,
  serializeSqdCandidateAddresses,
  sqdCandidateAddressesSha256,
  TRANSFER_TOPIC0,
  ZERO_ADDRESS,
} from '../../src/sqd/xcdot-transfer-candidates.js';
import {
  createSqdCurlTransport,
  retrySqdRequest,
  SqdRpcError,
  type SqdRangeClient,
} from '../../src/sqd/client.js';

const ADDRESS_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDRESS_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDRESS_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const ADDRESS_D = '0xdddddddddddddddddddddddddddddddddddddddd';

function indexed(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function transfer(from: string, to: string): Record<string, unknown> {
  return { topics: [TRANSFER_TOPIC0, indexed(from), indexed(to)] };
}

function line(number: number, logs?: unknown[]): string {
  return JSON.stringify(logs === undefined ? { header: { number } } : { header: { number }, logs });
}

function fakeClient(responses: Record<string, string>): SqdRangeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchRange(fromBlock, toBlock) {
      const key = `${fromBlock}-${toBlock}`;
      calls.push(key);
      const response = responses[key];
      if (response === undefined) throw new Error(`missing fixture response ${key}`);
      return response;
    },
  };
}

async function outputRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `xcdot-sqd-${name}-`));
}

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected action to fail');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('SQD xcDOT Transfer candidate discovery', () => {
  it('decodes an ABI-indexed H160 and rejects invalid padding and length', () => {
    expect(extractIndexedAddress(indexed('0x921b35e54b45b60ee8142fa234baeb2ff5e307e0'))).toBe(
      '0x921b35e54b45b60ee8142fa234baeb2ff5e307e0',
    );
    expectErrorCode(
      () => extractIndexedAddress(`0x01${'0'.repeat(22)}${ADDRESS_A.slice(2)}`),
      'SQD_STREAM_INVALID_TRANSFER_LOG',
    );
    expectErrorCode(() => extractIndexedAddress('0x1234'), 'SQD_STREAM_INVALID_TRANSFER_LOG');
  });

  it('extracts both from and to, excludes zero, and deterministically deduplicates', () => {
    const parsed = parseSqdJsonl(
      [
        line(100, [transfer(ADDRESS_A, ADDRESS_B)]),
        line(105, [transfer(ADDRESS_B, ADDRESS_C), transfer(ADDRESS_A, ADDRESS_C)]),
        line(110, [transfer(ZERO_ADDRESS, ADDRESS_D)]),
      ].join('\n') + '\n',
    );
    expect([...parsed.addresses].sort()).toEqual([ADDRESS_A, ADDRESS_B, ADDRESS_C, ADDRESS_D]);
    expect(parsed.transferLogCount).toBe(4);
    expect(parsed.zeroAddressOccurrenceCount).toBe(1);
    expect(serializeSqdCandidateAddresses([...parsed.addresses])).toBe(
      [ADDRESS_A, ADDRESS_B, ADDRESS_C, ADDRESS_D]
        .map((address) => JSON.stringify({ address }))
        .join('\n') + '\n',
    );
  });

  it('fails closed for a wrong topic0 and malformed Transfer topics', () => {
    expectErrorCode(
      () =>
        parseSqdJsonl(
          line(1, [{ topics: [`0x${'11'.repeat(32)}`, indexed(ADDRESS_A), indexed(ADDRESS_B)] }]),
        ),
      'SQD_STREAM_INVALID_TRANSFER_LOG',
    );
    expectErrorCode(
      () => parseSqdJsonl(line(1, [{ topics: [TRANSFER_TOPIC0, indexed(ADDRESS_A)] }])),
      'SQD_STREAM_INVALID_TRANSFER_LOG',
    );
  });

  it('parses JSONL line by line and accepts empty log ranges', () => {
    const parsed = parseSqdJsonl([line(100), line(150, []), line(200)].join('\n'));
    expect(parsed.lastReturnedBlock).toBe(200);
    expect(parsed.transferLogCount).toBe(0);
    expect(parsed.addresses.size).toBe(0);
  });

  it('rejects no progress and non-monotonic response headers', () => {
    expectErrorCode(() => parseSqdJsonl(''), 'SQD_STREAM_NO_PROGRESS');
    expectErrorCode(
      () => parseSqdJsonl([line(100), line(105), line(103)].join('\n')),
      'SQD_STREAM_NON_MONOTONIC_BLOCK',
    );
  });

  it('retries only transient HTTP failures with the specified backoff', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await expect(
      retrySqdRequest(
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error('HTTP 503');
          }
          return 'ok';
        },
        { attempts: 3, sleep: async (milliseconds) => delays.push(milliseconds) },
      ),
    ).resolves.toEqual({ value: 'ok', attempts: 3 });
    expect(delays).toEqual([2000, 4000]);
  });

  it('does not retry permanent HTTP failures', async () => {
    let attempts = 0;
    await expect(
      retrySqdRequest(
        async () => {
          attempts += 1;
          throw new SqdRpcError('HTTP 403', { httpStatus: 403 });
        },
        { attempts: 5, sleep: async () => undefined },
      ),
    ).rejects.toThrow('HTTP 403');
    expect(attempts).toBe(1);
  });

  it('builds the narrow SQD request and retries HTTP 429 through the curl transport', async () => {
    const requests: Array<{ endpoint: string; body: string; timeoutMs: number }> = [];
    let calls = 0;
    const delays: number[] = [];
    const transport = createSqdCurlTransport({
      endpoint: 'https://sqd.example/stream',
      timeoutMs: 1234,
      retries: 2,
      sleep: async (milliseconds) => delays.push(milliseconds),
      httpExecutor: async (endpoint, body, timeoutMs) => {
        requests.push({ endpoint, body, timeoutMs });
        calls += 1;
        return calls === 1
          ? { httpStatus: 429, body: 'slow down' }
          : { httpStatus: 200, body: `${line(0)}\n${line(9)}` };
      },
    });
    await expect(transport.fetchRange(0, 9)).resolves.toContain('"number":9');
    expect(delays).toEqual([2000]);
    const request = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(request).toMatchObject({ type: 'evm', fromBlock: 0, toBlock: 9 });
    expect(request).not.toHaveProperty('transactions');
    expect(request.logs).toEqual([
      {
        address: ['0xffffffff1fcacbd218edc0eba20fc2308c778080'],
        topic0: [TRANSFER_TOPIC0],
      },
    ]);
  });

  it('advances a partial response from the last returned header, not requestedEnd', async () => {
    const root = await outputRoot('partial');
    try {
      const client = fakeClient({
        '0-99': [line(0), line(23, [transfer(ADDRESS_A, ADDRESS_B)])].join('\n'),
        '24-123': [line(24), line(123)].join('\n'),
      });
      const result = await runSqdCandidateDiscovery({
        fromBlock: 0,
        toBlock: 123,
        windowBlocks: 100,
        out: join(root, 'out.ndjson'),
        work: join(root, 'work'),
        client,
      });
      expect(client.calls).toEqual(['0-99', '24-123']);
      expect(result.summary.lastCompletedBlock).toBe(123);
      expect(result.summary.uniqueNonZeroAddressCount).toBe(2);
      expect(result.sha256File).toMatch(/out\.sha256$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes after a partial run without restarting from block zero', async () => {
    const root = await outputRoot('resume');
    try {
      const firstClient: SqdRangeClient = {
        async fetchRange(fromBlock) {
          if (fromBlock === 0)
            return [line(0), line(100, [transfer(ADDRESS_A, ADDRESS_B)])].join('\n');
          throw new Error('simulated crash');
        },
      };
      await expect(
        runSqdCandidateDiscovery({
          fromBlock: 0,
          toBlock: 200,
          windowBlocks: 101,
          out: join(root, 'out.ndjson'),
          work: join(root, 'work'),
          client: firstClient,
        }),
      ).rejects.toThrow('simulated crash');
      const secondClient = fakeClient({
        '101-200': [line(101), line(200, [transfer(ADDRESS_B, ADDRESS_C)])].join('\n'),
      });
      const result = await runSqdCandidateDiscovery({
        fromBlock: 0,
        toBlock: 200,
        windowBlocks: 101,
        out: join(root, 'out.ndjson'),
        work: join(root, 'work'),
        client: secondClient,
        resume: true,
      });
      expect(secondClient.calls).toEqual(['101-200']);
      expect(result.summary.requestCount).toBe(2);
      expect(result.summary.uniqueNonZeroAddressCount).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a changed resume context unless force is supplied', async () => {
    const root = await outputRoot('context');
    try {
      const client = fakeClient({ '0-9': [line(0), line(9)].join('\n') });
      await runSqdCandidateDiscovery({
        fromBlock: 0,
        toBlock: 9,
        windowBlocks: 10,
        out: join(root, 'out.ndjson'),
        work: join(root, 'work'),
        client,
      });
      await expect(
        runSqdCandidateDiscovery({
          fromBlock: 0,
          toBlock: 10,
          windowBlocks: 10,
          out: join(root, 'out.ndjson'),
          work: join(root, 'work'),
          client,
          resume: true,
        }),
      ).rejects.toMatchObject({ code: 'SQD_CONTEXT_MISMATCH' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces byte-identical output and digest under different response chunking', async () => {
    const root = await outputRoot('deterministic');
    try {
      const responseFor = (from: number, to: number): string => {
        const logs = [
          [10, transfer(ADDRESS_A, ADDRESS_B)] as const,
          [60, transfer(ADDRESS_B, ADDRESS_C)] as const,
          [150, transfer(ADDRESS_C, ADDRESS_D)] as const,
        ]
          .filter(([block]) => block >= from && block <= to)
          .map(([, log]) => log);
        return [
          line(from),
          ...(logs.length > 0 ? [line(Math.min(to, from + 10), logs)] : []),
          line(to),
        ].join('\n');
      };
      const first = await runSqdCandidateDiscovery({
        fromBlock: 0,
        toBlock: 200,
        windowBlocks: 101,
        out: join(root, 'first.ndjson'),
        work: join(root, 'first-work'),
        client: {
          fetchRange: async (from, to) => responseFor(from, to),
        },
      });
      const second = await runSqdCandidateDiscovery({
        fromBlock: 0,
        toBlock: 200,
        windowBlocks: 51,
        out: join(root, 'second.ndjson'),
        work: join(root, 'second-work'),
        client: {
          fetchRange: async (from, to) => responseFor(from, to),
        },
      });
      expect(await readFile(first.outputFile)).toEqual(await readFile(second.outputFile));
      expect(first.summary.candidateSha256).toBe(second.summary.candidateSha256);
      expect(await readFile(first.sha256File)).toEqual(await readFile(second.sha256File));
      expect(sqdCandidateAddressesSha256([ADDRESS_D, ADDRESS_A, ADDRESS_B, ADDRESS_C])).toBe(
        first.summary.candidateSha256,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
