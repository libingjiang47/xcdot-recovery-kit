import { describe, expect, it } from 'vitest';
import { assertLegacyAssetsBackend, serializeStorage } from '../../src/evidence/raw-storage.js';
import { batchFileName, partition, validateBatchSize } from '../../src/evidence/batching.js';

describe('evidence capture boundaries', () => {
  it('fails closed when the runtime exposes only EVM foreign assets', () => {
    expect(() =>
      assertLegacyAssetsBackend({
        query: { evmForeignAssets: {}, system: {} },
      }),
    ).toThrow(/proof-complete legacy Assets backend/i);
  });

  it('uses deterministic bounded proof batches and raw storage field order', () => {
    expect(validateBatchSize(128)).toBe(128);
    expect(() => validateBatchSize(0)).toThrow();
    expect(partition(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(batchFileName(3)).toBe('batch-000003.json');
    expect(
      serializeStorage([
        { kind: 'asset', key: '0xaa', value: '0xbb' },
        {
          kind: 'account',
          address: '0x0000000000000000000000000000000000000001',
          key: '0xcc',
          value: '0xdd',
          balancePlanck: '7',
        },
      ]),
    ).toBe(
      '{"kind":"asset","key":"0xaa","value":"0xbb"}\n' +
        '{"kind":"account","address":"0x0000000000000000000000000000000000000001","key":"0xcc","value":"0xdd","balancePlanck":"7"}\n',
    );
  });
});
