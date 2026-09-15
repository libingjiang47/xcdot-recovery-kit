import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createNownodesRpcClient,
  NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
  NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
  NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
  NownodesRpcError,
  retryNownodesRpc,
  runNownodesFinalStateProbe,
  type NownodesProbeRpcClient,
} from '../../src/diagnostics/nownodes-final-state.js';

const parentHash = `0x${'11'.repeat(32)}`;
const otherRoot = `0x${'22'.repeat(32)}`;

function successfulResponse(method: string): unknown {
  if (method === 'chain_getHeader') {
    return {
      number: '0x1004c18',
      parentHash,
      stateRoot: NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
      extrinsicsRoot: `0x${'33'.repeat(32)}`,
    };
  }
  if (method === 'state_getRuntimeVersion') {
    return { specVersion: '0x1131', stateVersion: '0x1' };
  }
  if (method === 'state_getStorage') return '0x010203';
  if (method === 'state_getReadProof') {
    return { at: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH, proof: ['0xaa', '0xbb'] };
  }
  throw new Error(`unexpected method ${method}`);
}

class MockRpc implements NownodesProbeRpcClient {
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];

  constructor(private readonly handler: (method: string, params: readonly unknown[]) => unknown) {}

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }

  async close(): Promise<void> {}
}

async function output(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `xcdot-nownodes-probe-${name}-`));
}

describe('NOWNodes final-state minimal proof probe', () => {
  it('sends api-key authentication and JSON-RPC requests without exposing the key', async () => {
    const secret = 'nownodes-test-secret';
    let requestInit: RequestInit | undefined;
    const client = createNownodesRpcClient(
      'https://moonbeam.nownodes.io/',
      secret,
      1000,
      async (_input, init) => {
        requestInit = init;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    try {
      await expect(
        client.request('chain_getHeader', [NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH]),
      ).resolves.toBe('ok');
      expect(requestInit?.headers).toEqual({
        'content-type': 'application/json',
        'api-key': secret,
      });
      expect(String(requestInit?.body)).toContain('chain_getHeader');
    } finally {
      await client.close();
    }
  });

  it('runs only the narrow RPC sequence and verifies a matching proof offline', async () => {
    const out = await output('pass');
    try {
      const client = new MockRpc((method) => successfulResponse(method));
      const result = await runNownodesFinalStateProbe(
        {
          endpoint: 'https://moonbeam.nownodes.io/',
          key: 'secret',
          out,
          retries: 1,
          offlineVerifier: async (input) => {
            expect(input).toMatchObject({
              blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
              stateRoot: NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
              stateVersion: 1,
              key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
              value: '0x010203',
            });
            return { status: 'PASS', stdout: 'verified' };
          },
        },
        client,
      );
      expect(result.report.status).toBe('NOWNODES_HISTORICAL_PROOF_CAPABLE');
      expect(result.report.canReconstructFinalState).toBe(true);
      expect(result.report.canGenerateVerifiableProofs).toBe(true);
      expect(client.calls.map((call) => call.method)).toEqual([
        'chain_getHeader',
        'state_getRuntimeVersion',
        'state_getStorage',
        'state_getReadProof',
      ]);
      expect(client.calls[2]?.params).toEqual([
        NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
        NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      ]);
      expect(client.calls[3]?.params).toEqual([
        [NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY],
        NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      ]);
      expect(await readFile(join(out, 'storage-code.json'), 'utf8')).toContain('0x010203');
      expect(await readFile(join(out, 'report.txt'), 'utf8')).toContain(
        'STATUS=NOWNODES_HISTORICAL_PROOF_CAPABLE',
      );
      expect(await readFile(join(out, 'report.txt'), 'utf8')).not.toContain('secret');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('stops on a pinned header mismatch and does not query historical state', async () => {
    const out = await output('header-mismatch');
    try {
      const client = new MockRpc((method) => {
        const response = successfulResponse(method);
        return method === 'chain_getHeader'
          ? { ...(response as Record<string, unknown>), stateRoot: otherRoot }
          : response;
      });
      const result = await runNownodesFinalStateProbe({ key: 'secret', out, retries: 1 }, client);
      expect(result.report.status).toBe('PINNED_HEADER_MISMATCH');
      expect(result.report.header.status).toBe('FAIL');
      expect(result.report.storage.status).toBe('NOT_RUN');
      expect(client.calls.map((call) => call.method)).toEqual(['chain_getHeader']);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('classifies null historical storage as archive state unavailable', async () => {
    const out = await output('null-storage');
    try {
      const client = new MockRpc((method) =>
        method === 'state_getStorage' ? null : successfulResponse(method),
      );
      const result = await runNownodesFinalStateProbe({ key: 'secret', out, retries: 1 }, client);
      expect(result.report.status).toBe('NOWNODES_ARCHIVE_STATE_UNAVAILABLE');
      expect(result.report.storage.errorCode).toBe('NOWNODES_ARCHIVE_STATE_UNAVAILABLE');
      expect(result.report.readProof.status).toBe('NOT_RUN');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('distinguishes invalid read proofs from unavailable read proofs', async () => {
    const invalidOut = await output('invalid-proof');
    const unavailableOut = await output('unavailable-proof');
    try {
      const invalid = await runNownodesFinalStateProbe(
        { key: 'secret', out: invalidOut, retries: 1 },
        new MockRpc((method) =>
          method === 'state_getReadProof'
            ? { at: `0x${'44'.repeat(32)}`, proof: ['0xaa'] }
            : successfulResponse(method),
        ),
      );
      expect(invalid.report.status).toBe('NOWNODES_READ_PROOF_INVALID');

      const unavailable = await runNownodesFinalStateProbe(
        { key: 'secret', out: unavailableOut, retries: 1 },
        new MockRpc((method) => {
          if (method === 'state_getReadProof') {
            throw new NownodesRpcError('NOWNODES_METHOD_NOT_FOUND', 'method not found', method);
          }
          return successfulResponse(method);
        }),
      );
      expect(unavailable.report.status).toBe('NOWNODES_READ_PROOF_UNAVAILABLE');
      expect(unavailable.report.readProof.errorCode).toBe('NOWNODES_METHOD_NOT_FOUND');
    } finally {
      await rm(invalidOut, { recursive: true, force: true });
      await rm(unavailableOut, { recursive: true, force: true });
    }
  });

  it('records an offline proof failure and retries only transient failures', async () => {
    const out = await output('offline-fail');
    try {
      const result = await runNownodesFinalStateProbe(
        {
          key: 'secret',
          out,
          retries: 1,
          offlineVerifier: async () => ({ status: 'FAIL', detail: 'mutated proof' }),
        },
        new MockRpc((method) => successfulResponse(method)),
      );
      expect(result.report.status).toBe('NOWNODES_READ_PROOF_INVALID');
      expect(result.report.offlineProof.status).toBe('FAIL');
      expect(result.report.canGenerateVerifiableProofs).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }

    const delays: number[] = [];
    let calls = 0;
    await expect(
      retryNownodesRpc(
        async () => {
          calls += 1;
          if (calls < 3) {
            throw new NownodesRpcError('NOWNODES_RATE_LIMITED', 'HTTP 429', 'test', {
              transient: true,
              httpStatus: 429,
            });
          }
          return 'ok';
        },
        { attempts: 3, sleep: async (milliseconds) => delays.push(milliseconds) },
      ),
    ).resolves.toEqual({ value: 'ok', attempts: 3 });
    expect(delays).toEqual([1000, 3000]);
  });
});
