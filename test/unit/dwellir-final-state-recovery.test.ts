import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XC_DOT_XC20_ADDRESS } from '../../src/asset/constants.js';
import { MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH } from '../../src/final-state/constants.js';
import { candidateAddressesSha256 } from '../../src/subscan/candidates.js';
import {
  buildDwellirCurlArguments,
  recoverDwellirFinalState,
  type DwellirRpcTransport,
} from '../../src/storage/dwellir-final-state-recovery.js';
import {
  deriveAccountStoragesKeyDirect,
  deriveBalanceAccountStoragesKeyDirect,
  deriveTotalSupplyAccountStoragesKeyDirect,
} from '../../src/storage/substrate-evm.js';
import { encodeU256Storage } from '../../src/storage/solidity.js';

const TEST_ADDRESS_A = '0x1111111111111111111111111111111111111111';
const TEST_ADDRESS_B = '0x2222222222222222222222222222222222222222';
const TEST_ADDRESS_C = '0x3333333333333333333333333333333333333333';

describe('Dwellir curl timeout arguments', () => {
  const base = {
    endpoint: 'https://dwellir.invalid/test-key',
    body: {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'state_getStorage',
      params: [],
    },
    timeoutMs: 120_000,
    retries: 5,
  };

  it('keeps the default connection timeout at 20 seconds', () => {
    const args = buildDwellirCurlArguments(base);
    expect(args[args.indexOf('--connect-timeout') + 1]).toBe('20');
    expect(args[args.indexOf('--max-time') + 1]).toBe('120');
  });

  it('supports an explicitly extended connection timeout', () => {
    const args = buildDwellirCurlArguments({ ...base, connectTimeoutMs: 120_000 });
    expect(args[args.indexOf('--connect-timeout') + 1]).toBe('120');
  });

  it('rejects a connection timeout longer than the overall timeout', () => {
    expect(() => buildDwellirCurlArguments({ ...base, connectTimeoutMs: 120_001 })).toThrow(
      'connect-timeout-ms must not exceed timeout-ms',
    );
  });
});

describe('direct Moonbeam EVM AccountStorages key derivation', () => {
  it('matches the pinned Frontier Blake2_128Concat double-map encoding for xcDOT totalSupply', () => {
    const derived = deriveTotalSupplyAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, 2n);
    expect(derived.evmStorageSlot).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    );
    expect(derived.substrateStorageKey).toBe(
      '0x1da53b775b270400e7e61ed5cbc5a146ab1160471b1418779239ba8e2b847e421f720ca3a567a7892f51ba4eabe649ccffffffff1fcacbd218edc0eba20fc2308c7780800649d8fcd39471b32a600d9c85a03f380000000000000000000000000000000000000000000000000000000000000002',
    );
  });

  it('rejects malformed contract and slot keys', () => {
    expect(() =>
      deriveAccountStoragesKeyDirect(
        '0x1234',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ),
    ).toThrow();
    expect(() => deriveAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, '0x12')).toThrow();
  });

  it('recovers all candidate balances, captures proofs, and publishes only after verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-dwellir-recovery-test-'));
    const dataset = join(root, 'dataset');
    const output = join(root, 'output');
    const work = join(root, 'work');
    const addresses = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ];
    try {
      await mkdir(dataset, { recursive: true });
      await writeFile(
        join(dataset, 'provenance.ndjson'),
        addresses.map((address) => JSON.stringify({ address })).join('\n') + '\n',
        'utf8',
      );

      const totalKey = deriveTotalSupplyAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, 2n);
      const zeroKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        '0x0000000000000000000000000000000000000000',
        0n,
      );
      const firstKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        addresses[0]!,
        0n,
      );
      const secondKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        addresses[1]!,
        0n,
      );
      const values = new Map<string, string | null>([
        [totalKey.substrateStorageKey, encodeU256Storage(3n)],
        [zeroKey.substrateStorageKey, null],
        [firstKey.substrateStorageKey, encodeU256Storage(1n)],
        [secondKey.substrateStorageKey, encodeU256Storage(2n)],
      ]);
      const transport: DwellirRpcTransport = {
        async batch(calls) {
          return calls.map((call) => values.get(String(call.params[0])) ?? null);
        },
        async call(method, params) {
          if (method === 'state_getStorage') return values.get(String(params[0])) ?? null;
          if (method === 'state_getReadProof') {
            return {
              at: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
              proof: ['0xaa'],
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      };
      let verifierCalls = 0;
      const result = await recoverDwellirFinalState({
        dataset,
        out: output,
        work,
        transport,
        expectedCandidateCount: addresses.length,
        expectedCandidateSha256: candidateAddressesSha256(addresses),
        expectedTotalSupplyPlanck: '3',
        storageBatchSize: 2,
        proofBatchSize: 2,
        offlineVerifier: async () => {
          verifierCalls += 1;
          return { stdout: 'FINAL_STATE_OFFLINE_VERIFICATION=PASS' };
        },
      });
      expect(result.status).toBe('VERIFIED');
      expect(result.holderCount).toBe(2);
      expect(result.totalSupplyPlanck).toBe('3');
      expect(verifierCalls).toBe(2);
      const holders = await readFile(
        join(output, 'substrate-storage/positive-holders.ndjson'),
        'utf8',
      );
      expect(holders).toContain('"balancePlanck":"1"');
      expect(holders).toContain('"balancePlanck":"2"');
      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) as {
        status: string;
      };
      expect(manifest.status).toBe('VERIFIED');
      expect(await readFile(join(output, 'SHA256SUMS'), 'utf8')).toContain('proofs/index.ndjson');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses the cached Subscan state and queries only Moonscan-only addresses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-moonscan-reconciliation-test-'));
    const dataset = join(root, 'dataset');
    const moonscan = join(root, 'moonscan-export.txt');
    const output = join(root, 'output');
    const work = join(root, 'work');
    const diff = join(root, 'diff');
    try {
      await mkdir(join(dataset), { recursive: true });
      await writeFile(
        join(dataset, 'provenance.ndjson'),
        [TEST_ADDRESS_A, TEST_ADDRESS_B].map((address) => JSON.stringify({ address })).join('\n') +
          '\n',
      );
      await writeFile(
        moonscan,
        [
          'HolderAddress,Balance,PendingBalanceUpdate',
          `${TEST_ADDRESS_B},99.0000000000,`,
          `${TEST_ADDRESS_C},1.0000000000,`,
        ].join('\n') + '\n',
      );

      const totalKey = deriveTotalSupplyAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, 2n);
      const zeroKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        '0x0000000000000000000000000000000000000000',
        0n,
      );
      const firstKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        TEST_ADDRESS_A,
        0n,
      );
      const secondKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        TEST_ADDRESS_B,
        0n,
      );
      const thirdKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        TEST_ADDRESS_C,
        0n,
      );
      const cachedDirectory = join(work, 'storage-batches');
      await mkdir(cachedDirectory, { recursive: true });
      await writeFile(
        join(cachedDirectory, 'batch-000000.json'),
        JSON.stringify({
          schemaVersion: 1,
          blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
          batchIndex: 0,
          keys: [totalKey.substrateStorageKey, zeroKey.substrateStorageKey],
          values: [encodeU256Storage(3n), null],
        }),
      );
      await writeFile(
        join(cachedDirectory, 'batch-000001.json'),
        JSON.stringify({
          schemaVersion: 1,
          blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
          batchIndex: 1,
          keys: [firstKey.substrateStorageKey, secondKey.substrateStorageKey],
          values: [encodeU256Storage(1n), encodeU256Storage(1n)],
        }),
      );

      const liveStorageReads: string[] = [];
      const values = new Map<string, string | null>([
        [thirdKey.substrateStorageKey, encodeU256Storage(1n)],
      ]);
      const transport: DwellirRpcTransport = {
        async batch(calls) {
          for (const call of calls) liveStorageReads.push(String(call.params[0]));
          return calls.map((call) => values.get(String(call.params[0])) ?? null);
        },
        async call(method) {
          if (method === 'state_getReadProof') {
            return { at: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH, proof: ['0xaa'] };
          }
          throw new Error(`unexpected method ${method}`);
        },
      };
      let verifierCalls = 0;
      const result = await recoverDwellirFinalState({
        dataset,
        moonscanCsv: moonscan,
        out: output,
        work,
        candidateDiffOut: diff,
        transport,
        expectedSubscanCandidateCount: 2,
        expectedSubscanCandidateSha256: candidateAddressesSha256([TEST_ADDRESS_A, TEST_ADDRESS_B]),
        expectedMoonscanOnlyCount: 1,
        expectedMoonscanOnlySha256: candidateAddressesSha256([TEST_ADDRESS_C]),
        expectedMoonscanAddressCount: 2,
        expectedExistingCachedAddressCount: 2,
        expectedExistingFinalSumPlanck: '2',
        expectedTotalSupplyPlanck: '3',
        storageBatchSize: 2,
        proofBatchSize: 2,
        force: true,
        offlineVerifier: async () => {
          verifierCalls += 1;
          return { stdout: 'FINAL_STATE_OFFLINE_VERIFICATION=PASS' };
        },
      });
      expect(result.status).toBe('VERIFIED');
      expect(result.candidateCount).toBe(3);
      expect(result.holderCount).toBe(3);
      expect(result.totalSupplyPlanck).toBe('3');
      expect(verifierCalls).toBe(3);
      expect(liveStorageReads).toEqual([thirdKey.substrateStorageKey]);
      const summary = JSON.parse(
        await readFile(join(output, 'substrate-storage/summary.json'), 'utf8'),
      ) as {
        candidateSet: {
          count: number;
          subscanOnlyCount: number;
          intersectionCount: number;
          moonscanOnlyCount: number;
        };
      };
      expect(summary.candidateSet).toMatchObject({
        count: 3,
        subscanOnlyCount: 1,
        intersectionCount: 1,
        moonscanOnlyCount: 1,
      });
      expect(await readFile(join(diff, 'candidate-union.ndjson'), 'utf8')).toContain(
        TEST_ADDRESS_C,
      );

      const resumed = await recoverDwellirFinalState({
        dataset,
        moonscanCsv: moonscan,
        out: output,
        work,
        candidateDiffOut: diff,
        transport: {
          async batch() {
            throw new Error('resume should not query the live transport');
          },
          async call() {
            throw new Error('resume should not query the live transport');
          },
        },
        expectedSubscanCandidateCount: 2,
        expectedSubscanCandidateSha256: candidateAddressesSha256([TEST_ADDRESS_A, TEST_ADDRESS_B]),
        expectedMoonscanOnlyCount: 1,
        expectedMoonscanOnlySha256: candidateAddressesSha256([TEST_ADDRESS_C]),
        expectedMoonscanAddressCount: 2,
        expectedExistingCachedAddressCount: 2,
        expectedExistingFinalSumPlanck: '2',
        expectedTotalSupplyPlanck: '3',
        storageBatchSize: 2,
        proofBatchSize: 2,
        offlineVerifier: async () => {
          verifierCalls += 1;
          return { stdout: 'FINAL_STATE_OFFLINE_VERIFICATION=PASS' };
        },
      });
      expect(resumed.status).toBe('VERIFIED');
      expect(liveStorageReads).toEqual([thirdKey.substrateStorageKey]);
      expect(verifierCalls).toBe(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses a generic candidate extension and queries only its uncached addresses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-generic-extension-recovery-test-'));
    const dataset = join(root, 'dataset');
    const extension = join(root, 'extension.ndjson');
    const output = join(root, 'output');
    const work = join(root, 'work');
    const diff = join(root, 'diff');
    try {
      await mkdir(dataset, { recursive: true });
      await writeFile(
        join(dataset, 'provenance.ndjson'),
        JSON.stringify({ address: TEST_ADDRESS_A }) + '\n',
      );
      await writeFile(
        extension,
        [
          JSON.stringify({ address: TEST_ADDRESS_A }),
          JSON.stringify({ address: TEST_ADDRESS_C }),
        ].join('\n') + '\n',
      );

      const totalKey = deriveTotalSupplyAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, 2n);
      const zeroKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        '0x0000000000000000000000000000000000000000',
        0n,
      );
      const firstKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        TEST_ADDRESS_A,
        0n,
      );
      const secondKey = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        TEST_ADDRESS_C,
        0n,
      );
      const cachedDirectory = join(work, 'storage-batches');
      await mkdir(cachedDirectory, { recursive: true });
      await writeFile(
        join(cachedDirectory, 'batch-000000.json'),
        JSON.stringify({
          schemaVersion: 1,
          blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
          batchIndex: 0,
          keys: [
            totalKey.substrateStorageKey,
            zeroKey.substrateStorageKey,
            firstKey.substrateStorageKey,
          ],
          values: [encodeU256Storage(3n), null, encodeU256Storage(1n)],
        }),
      );

      const liveReads: string[] = [];
      const values = new Map([[secondKey.substrateStorageKey, encodeU256Storage(2n)]]);
      const transport: DwellirRpcTransport = {
        async batch(calls) {
          return calls.map((call) => {
            liveReads.push(String(call.params[0]));
            return values.get(String(call.params[0])) ?? null;
          });
        },
        async call(method) {
          if (method === 'state_getReadProof') {
            return { at: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH, proof: ['0xaa'] };
          }
          throw new Error(`unexpected method ${method}`);
        },
      };
      let verifierCalls = 0;
      const result = await recoverDwellirFinalState({
        dataset,
        candidateExtension: extension,
        candidateDiffOut: diff,
        out: output,
        work,
        transport,
        expectedSubscanCandidateCount: 1,
        expectedSubscanCandidateSha256: candidateAddressesSha256([TEST_ADDRESS_A]),
        expectedExistingCachedAddressCount: 1,
        expectedExistingFinalSumPlanck: '1',
        expectedTotalSupplyPlanck: '3',
        storageBatchSize: 2,
        proofBatchSize: 2,
        offlineVerifier: async () => {
          verifierCalls += 1;
          return { stdout: 'FINAL_STATE_OFFLINE_VERIFICATION=PASS' };
        },
      });
      expect(result.status).toBe('VERIFIED');
      expect(result.candidateCount).toBe(2);
      expect(result.holderCount).toBe(2);
      expect(liveReads).toEqual([secondKey.substrateStorageKey]);
      expect(verifierCalls).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
