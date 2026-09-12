import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
  DWELLIR_FINAL_STATE_PROBE_ENDPOINT,
  DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
  DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
  runDwellirFinalStateProbe,
} from '../../src/diagnostics/dwellir-final-state.js';
import { type NownodesProbeRpcClient } from '../../src/diagnostics/nownodes-final-state.js';

const parentHash = `0x${'11'.repeat(32)}`;

function successfulResponse(method: string): unknown {
  if (method === 'chain_getHeader') {
    return {
      number: '0x1004c18',
      parentHash,
      stateRoot: DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
      extrinsicsRoot: `0x${'33'.repeat(32)}`,
    };
  }
  if (method === 'state_getStorage') return '0x010203';
  if (method === 'state_getReadProof') {
    return { at: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH, proof: ['0xaa', '0xbb'] };
  }
  throw new Error(`unexpected method ${method}`);
}

class MockRpc implements NownodesProbeRpcClient {
  readonly calls: string[] = [];

  constructor(private readonly handler: (method: string) => unknown) {}

  async request(method: string): Promise<unknown> {
    this.calls.push(method);
    return this.handler(method);
  }

  async close(): Promise<void> {}
}

async function output(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `xcdot-dwellir-probe-${name}-`));
}

describe('Dwellir final-state minimal proof probe', () => {
  it('uses the key in the URL path and executes exactly the three requested RPCs', async () => {
    const out = await output('pass');
    const key = 'dwellir-test-secret';
    const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
    try {
      const result = await runDwellirFinalStateProbe({
        key,
        out,
        retries: 1,
        fetchImpl: async (input, init) => {
          const request = JSON.parse(String(init?.body)) as { method: string };
          calls.push({ method: request.method, url: String(input), init: init ?? {} });
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: calls.length,
              result: successfulResponse(request.method),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
        offlineVerifier: async () => ({ status: 'PASS' }),
      });
      expect(result.report.provider).toBe('DWELLIR');
      expect(result.report.dwellirKeyPresent).toBe(true);
      expect(result.report.status).toBe('DWELLIR_HISTORICAL_PROOF_CAPABLE');
      expect(calls.map((call) => call.method)).toEqual([
        'chain_getHeader',
        'state_getStorage',
        'state_getReadProof',
      ]);
      expect(
        calls.every((call) => call.url === `${DWELLIR_FINAL_STATE_PROBE_ENDPOINT}${key}`),
      ).toBe(true);
      expect(calls.every((call) => !('api-key' in (call.init.headers ?? {})))).toBe(true);
      expect(calls[1]?.init.body).toContain(DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY);
      expect(result.reportText).not.toContain(key);
      expect(result.reportText).not.toContain('NOWNODES');
      expect(await readFile(join(out, 'report.txt'), 'utf8')).toContain(
        'STATUS=DWELLIR_HISTORICAL_PROOF_CAPABLE',
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('stops on a pinned header mismatch and preserves a Dwellir-labelled diagnostic', async () => {
    const out = await output('header-mismatch');
    try {
      const client = new MockRpc((method) => {
        const response = successfulResponse(method);
        return method === 'chain_getHeader'
          ? { ...(response as Record<string, unknown>), stateRoot: `0x${'22'.repeat(32)}` }
          : response;
      });
      const result = await runDwellirFinalStateProbe({ key: 'secret', out, retries: 1 }, client);
      expect(result.report.status).toBe('PINNED_HEADER_MISMATCH');
      expect(result.reportText).toContain('PROVIDER=DWELLIR');
      expect(result.reportText).not.toContain('NOWNODES');
      expect(client.calls).toEqual(['chain_getHeader']);
      expect(await readFile(join(out, 'header.json'), 'utf8')).toContain('PINNED_HEADER_MISMATCH');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
