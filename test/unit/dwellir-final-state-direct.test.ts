import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
  DWELLIR_FINAL_STATE_PROBE_ENDPOINT,
  DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
  runDwellirFinalStateDirectProbe,
} from '../../src/diagnostics/dwellir-final-state-direct.js';

async function output(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `xcdot-dwellir-direct-probe-${name}-`));
}

describe('Dwellir direct final-state probe', () => {
  it('sends exactly storage and read-proof requests and verifies the proof', async () => {
    const out = await output('pass');
    const key = 'dwellir-direct-test-secret';
    const calls: Array<{ method: string; url: string }> = [];
    try {
      const result = await runDwellirFinalStateDirectProbe({
        key,
        out,
        retries: 1,
        rpcExecutor: async (url, payload) => {
          calls.push({ method: String(payload.method), url });
          const response =
            payload.method === 'state_getStorage'
              ? '0x010203'
              : {
                  at: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
                  proof: ['0xaa', '0xbb'],
                };
          return {
            httpStatus: 200,
            body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: response }),
          };
        },
        offlineVerifier: async (input) => {
          expect(input).toMatchObject({
            blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
            stateRoot: DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
            stateVersion: 1,
            value: '0x010203',
          });
          return { status: 'PASS' };
        },
      });
      expect(calls.map((call) => call.method)).toEqual(['state_getStorage', 'state_getReadProof']);
      expect(
        calls.every((call) => call.url === `${DWELLIR_FINAL_STATE_PROBE_ENDPOINT}${key}`),
      ).toBe(true);
      expect(result.report.storage.status).toBe('PASS');
      expect(result.report.readProof.status).toBe('PASS');
      expect(result.report.offlineProof.status).toBe('PASS');
      expect(result.report.status).toBe('DWELLIR_HISTORICAL_PROOF_CAPABLE');
      expect(result.report.canReconstructFinalState).toBe(true);
      expect(result.report.canGenerateVerifiableProofs).toBe(true);
      expect(result.report.storage.valueByteLength).toBe(3);
      expect(result.reportText).not.toContain(key);
      expect(await readFile(join(out, 'report.txt'), 'utf8')).toContain(
        'STATUS=DWELLIR_HISTORICAL_PROOF_CAPABLE',
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('preserves an explicit historical storage RPC error and stops before proof', async () => {
    const out = await output('storage-error');
    try {
      const calls: string[] = [];
      const result = await runDwellirFinalStateDirectProbe({
        key: 'secret',
        out,
        retries: 1,
        rpcExecutor: async (_url, payload) => {
          calls.push(String(payload.method));
          return {
            httpStatus: 200,
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              error: { code: -32000, message: 'block not found at historical state' },
            }),
          };
        },
      });
      expect(result.report.storage.status).toBe('FAIL');
      expect(result.report.status).toBe('DWELLIR_ARCHIVE_STATE_UNAVAILABLE');
      expect(result.report.storage.rpcError).toContain('block not found');
      expect(result.report.readProof.status).toBe('NOT_RUN');
      expect(calls).toEqual(['state_getStorage']);
      expect(await readFile(join(out, 'storage-code.json'), 'utf8')).toContain('block not found');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('reports storage-only capability when read proof is unavailable', async () => {
    const out = await output('proof-error');
    try {
      const result = await runDwellirFinalStateDirectProbe({
        key: 'secret',
        out,
        retries: 1,
        rpcExecutor: async (_url, payload) => ({
          httpStatus: 200,
          body: JSON.stringify(
            payload.method === 'state_getStorage'
              ? { jsonrpc: '2.0', id: payload.id, result: '0x010203' }
              : {
                  jsonrpc: '2.0',
                  id: payload.id,
                  error: { code: -32601, message: 'Method not found' },
                },
          ),
        }),
        offlineVerifier: async () => ({ status: 'PASS' }),
      });
      expect(result.report.storage.status).toBe('PASS');
      expect(result.report.readProof.status).toBe('FAIL');
      expect(result.report.offlineProof.status).toBe('NOT_RUN');
      expect(result.report.canReconstructFinalState).toBe(true);
      expect(result.report.canGenerateVerifiableProofs).toBe(false);
      expect(result.report.status).toBe('DWELLIR_HISTORICAL_STORAGE_ONLY');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
