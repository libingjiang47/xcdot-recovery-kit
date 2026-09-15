import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_PROBE_BLOCK_HASH,
  ARCHIVE_PROBE_STATE_ROOT,
  ArchiveRpcError,
  probeSubstrateArchive,
  probeSubstrateArchiveMatrix,
  retryArchiveRpc,
  type ArchiveOfflineProofResult,
  type ArchiveProbeRpcClient,
} from '../../src/diagnostics/substrate-archive.js';

const otherHash = `0x${'11'.repeat(32)}`;
const parentHash = `0x${'22'.repeat(32)}`;
const extrinsicsRoot = `0x${'33'.repeat(32)}`;

function successfulResponse(method: string): unknown {
  if (method === 'system_chain') return 'Moonbeam';
  if (method === 'chain_getHeader') {
    return {
      number: '0x1004c18',
      parentHash,
      stateRoot: ARCHIVE_PROBE_STATE_ROOT,
      extrinsicsRoot,
    };
  }
  if (method === 'state_getRuntimeVersion') {
    return {
      specName: 'moonbeam',
      implName: 'moonbeam-node',
      authoringVersion: '0x1',
      specVersion: '0x1131',
      implVersion: '0x1',
      transactionVersion: '0x3',
      stateVersion: '0x1',
    };
  }
  if (method === 'state_getMetadata') return '0x6d65746101';
  if (method === 'state_getStorage') return '0x010203';
  if (method === 'state_getReadProof') {
    return { at: ARCHIVE_PROBE_BLOCK_HASH, proof: ['0xaa', '0xbb'] };
  }
  throw new Error(`unexpected method ${method}`);
}

class MockRpc implements ArchiveProbeRpcClient {
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];

  constructor(private readonly handler: (method: string, params: readonly unknown[]) => unknown) {}

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }

  async close(): Promise<void> {}
}

async function passOffline(): Promise<ArchiveOfflineProofResult> {
  return { status: 'PASS', stdout: 'fixture verifier pass' };
}

async function makeOutput(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `xcdot-archive-probe-${name}-`));
}

describe('Substrate historical archive probe', () => {
  it('passes all five methods and records exact pinned parameters', async () => {
    const out = await makeOutput('all-pass');
    try {
      const client = new MockRpc((method) => successfulResponse(method));
      const result = await probeSubstrateArchive(
        {
          rpc: 'https://archive.example/rpc',
          providerName: 'fixture',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          timeoutMs: 1000,
          out,
          offlineVerifier: passOffline,
        },
        client,
      );
      expect(result.report.classification).toBe('HISTORICAL_PROOF');
      expect(result.report.transport.status).toBe('PASS');
      expect(result.report.header.status).toBe('PASS');
      expect(result.report.runtime.specVersion).toBe('4401');
      expect(result.report.metadata.bytes).toBe(5);
      expect(result.report.storage.valueBytes).toBe(3);
      expect(result.report.readProof.nodeCount).toBe(2);
      expect(result.report.offlineProof.status).toBe('PASS');
      expect(client.calls.map((call) => call.method)).toEqual([
        'system_chain',
        'chain_getHeader',
        'state_getRuntimeVersion',
        'state_getMetadata',
        'state_getStorage',
        'state_getReadProof',
      ]);
      expect(client.calls[1]?.params).toEqual([ARCHIVE_PROBE_BLOCK_HASH]);
      expect(client.calls[4]?.params).toEqual(['0x3a636f6465', ARCHIVE_PROBE_BLOCK_HASH]);
      expect(client.calls[5]?.params).toEqual([['0x3a636f6465'], ARCHIVE_PROBE_BLOCK_HASH]);
      expect(await readFile(join(out, 'report.txt'), 'utf8')).toContain(
        'CLASSIFICATION=HISTORICAL_PROOF',
      );
      expect(await readFile(join(out, 'storage.json'), 'utf8')).toContain('0x010203');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('stops after a transport failure and does not interpret archive methods', async () => {
    const out = await makeOutput('transport-fail');
    try {
      const client = new MockRpc(() => {
        throw new ArchiveRpcError('TIMEOUT', 'transport timeout', 'system_chain', {
          transient: true,
        });
      });
      const result = await probeSubstrateArchive(
        {
          rpc: 'wss://archive.example/ws',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          timeoutMs: 1000,
          out,
        },
        client,
      );
      expect(result.report.classification).toBe('UNREACHABLE');
      expect(result.report.errorCode).toBe('TIMEOUT');
      expect(result.report.header.status).toBe('NOT_RUN');
      expect(client.calls).toHaveLength(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('records a historical header lookup failure and does not run later methods', async () => {
    const out = await makeOutput('header-unavailable');
    try {
      const client = new MockRpc((method) => {
        if (method === 'chain_getHeader') {
          throw new ArchiveRpcError(
            'BLOCK_NOT_FOUND',
            'historical block not found',
            'chain_getHeader',
          );
        }
        return successfulResponse(method);
      });
      const result = await probeSubstrateArchive(
        {
          rpc: 'https://archive.example',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          out,
        },
        client,
      );
      expect(result.report.classification).toBe('UNREACHABLE');
      expect(result.report.header.errorCode).toBe('BLOCK_NOT_FOUND');
      expect(result.report.runtime.status).toBe('NOT_RUN');
      expect(client.calls.map((call) => call.method)).toEqual(['system_chain', 'chain_getHeader']);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('records pinned header mismatch and runtime mismatch as fail-closed', async () => {
    const headerOut = await makeOutput('header-mismatch');
    const runtimeOut = await makeOutput('runtime-mismatch');
    try {
      const wrongHeader = new MockRpc((method) => {
        const response = successfulResponse(method);
        if (method === 'chain_getHeader') {
          return { ...(response as Record<string, unknown>), stateRoot: otherHash };
        }
        return response;
      });
      const headerResult = await probeSubstrateArchive(
        {
          rpc: 'https://archive.example',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          out: headerOut,
        },
        wrongHeader,
      );
      expect(headerResult.report.classification).toBe('HEADER_ONLY');
      expect(headerResult.report.errorCode).toBe('PINNED_HEADER_MISMATCH');
      expect(headerResult.report.runtime.status).toBe('NOT_RUN');

      const wrongRuntime = new MockRpc((method) => {
        const response = successfulResponse(method);
        if (method === 'state_getRuntimeVersion') {
          return { ...(response as Record<string, unknown>), specVersion: '0x1132' };
        }
        return response;
      });
      const runtimeResult = await probeSubstrateArchive(
        {
          rpc: 'https://archive.example',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          out: runtimeOut,
        },
        wrongRuntime,
      );
      expect(runtimeResult.report.classification).toBe('HEADER_ONLY');
      expect(runtimeResult.report.errorCode).toBe('RUNTIME_VERSION_MISMATCH');
      expect(runtimeResult.report.metadata.status).toBe('NOT_RUN');
    } finally {
      await rm(headerOut, { recursive: true, force: true });
      await rm(runtimeOut, { recursive: true, force: true });
    }
  });

  it('distinguishes metadata, storage, and proof failures', async () => {
    const cases: Array<{
      name: string;
      failMethod: string;
      expected: string;
      error: ArchiveRpcError;
    }> = [
      {
        name: 'metadata',
        failMethod: 'state_getMetadata',
        expected: 'HEADER_ONLY',
        error: new ArchiveRpcError('METHOD_NOT_FOUND', 'method not found', 'state_getMetadata'),
      },
      {
        name: 'storage',
        failMethod: 'state_getStorage',
        expected: 'HISTORICAL_METADATA',
        error: new ArchiveRpcError('HISTORICAL_STORAGE_UNAVAILABLE', 'pruned', 'state_getStorage'),
      },
      {
        name: 'proof',
        failMethod: 'state_getReadProof',
        expected: 'HISTORICAL_STORAGE',
        error: new ArchiveRpcError('METHOD_NOT_FOUND', 'method not found', 'state_getReadProof'),
      },
    ];
    const outputs: string[] = [];
    try {
      for (const testCase of cases) {
        const out = await makeOutput(testCase.name);
        outputs.push(out);
        const client = new MockRpc((method) => {
          if (method === testCase.failMethod) throw testCase.error;
          return successfulResponse(method);
        });
        const result = await probeSubstrateArchive(
          {
            rpc: 'https://archive.example',
            blockHash: ARCHIVE_PROBE_BLOCK_HASH,
            retries: 1,
            out,
          },
          client,
        );
        expect(result.report.classification).toBe(testCase.expected);
        expect(
          result.report[
            testCase.failMethod === 'state_getMetadata'
              ? 'metadata'
              : testCase.failMethod === 'state_getStorage'
                ? 'storage'
                : 'readProof'
          ].status,
        ).toBe('FAIL');
      }
    } finally {
      await Promise.all(outputs.map((out) => rm(out, { recursive: true, force: true })));
    }
  });

  it('rejects a read proof for another block and an offline-invalid proof', async () => {
    const wrongBlockOut = await makeOutput('wrong-proof-block');
    const invalidOut = await makeOutput('invalid-proof');
    try {
      const wrongBlock = new MockRpc((method) => {
        const response = successfulResponse(method);
        return method === 'state_getReadProof'
          ? { ...(response as Record<string, unknown>), at: otherHash }
          : response;
      });
      const wrongBlockResult = await probeSubstrateArchive(
        {
          rpc: 'https://archive.example',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          out: wrongBlockOut,
        },
        wrongBlock,
      );
      expect(wrongBlockResult.report.classification).toBe('HISTORICAL_STORAGE');
      expect(wrongBlockResult.report.errorCode).toBe('READ_PROOF_INVALID');

      const invalid = await probeSubstrateArchive(
        {
          rpc: 'https://archive.example',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          out: invalidOut,
          offlineVerifier: async () => ({ status: 'FAIL', detail: 'mutated proof' }),
        },
        new MockRpc((method) => successfulResponse(method)),
      );
      expect(invalid.report.classification).toBe('HISTORICAL_STORAGE');
      expect(invalid.report.offlineProof.status).toBe('FAIL');
      expect(invalid.report.errorCode).toBe('READ_PROOF_INVALID');
    } finally {
      await rm(wrongBlockOut, { recursive: true, force: true });
      await rm(invalidOut, { recursive: true, force: true });
    }
  });

  it('retries HTTP 429 and preserves credential redaction', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const retry = await retryArchiveRpc(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ArchiveRpcError('RATE_LIMITED', 'HTTP 429', 'system_chain', {
            transient: true,
            httpStatus: 429,
          });
        }
        return 'ok';
      },
      { retries: 3, sleep: async (milliseconds) => delays.push(milliseconds) },
    );
    expect(retry).toEqual({ value: 'ok', attempts: 3 });
    expect(delays).toEqual([250, 500]);

    const out = await makeOutput('redaction');
    try {
      const result = await probeSubstrateArchive(
        {
          rpc: 'https://user:super-secret@example.com/rpc?apiKey=top-secret',
          providerName: 'secret-provider',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
          retries: 1,
          out,
          offlineVerifier: passOffline,
        },
        new MockRpc((method) => successfulResponse(method)),
      );
      expect(result.report.rpc).toMatchObject({
        scheme: 'https',
        host: 'example.com',
        credentialPresent: true,
        credentialsRedacted: true,
      });
      expect(result.reportText).not.toContain('super-secret');
      expect(result.reportText).not.toContain('top-secret');
      expect(await readFile(join(out, 'report.json'), 'utf8')).not.toContain('super-secret');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('continues a matrix after one provider fails and marks missing URLs explicitly', async () => {
    const out = await makeOutput('matrix');
    try {
      const result = await probeSubstrateArchiveMatrix({
        blockHash: ARCHIVE_PROBE_BLOCK_HASH,
        retries: 1,
        out,
        providers: [
          { name: 'first', rpc: 'https://first.example' },
          { name: 'second', rpc: 'https://second.example' },
          { name: 'dwellir' },
        ],
        offlineVerifier: passOffline,
        clientFactory: (provider) =>
          provider.name === 'first'
            ? new MockRpc(() => {
                throw new ArchiveRpcError('TIMEOUT', 'first timeout', 'system_chain', {
                  transient: true,
                });
              })
            : new MockRpc((method) => successfulResponse(method)),
      });
      expect(result.providers.map((provider) => provider.classification)).toEqual([
        'UNREACHABLE',
        'HISTORICAL_PROOF',
        'NO_KNOWN_SUBSTRATE_ENDPOINT',
      ]);
      expect(result.summary).toMatchObject({
        historicalStorageProviders: 1,
        historicalProofProviders: 1,
        canReconstructFinalState: true,
        canGenerateProofs: true,
      });
      expect(await readFile(join(out, 'matrix-summary.json'), 'utf8')).toContain(
        'HISTORICAL_PROOF',
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
