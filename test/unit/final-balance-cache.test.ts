import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFinalBalanceCache } from '../../src/storage/final-balance-cache.js';
import { MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH } from '../../src/final-state/constants.js';

const KEY = `0x${'ab'.repeat(32)}`;
const VALUE = `0x${'01'.padStart(64, '0')}`;

describe('final-state balance cache', () => {
  it('allows repeated identical records and rejects conflicting records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-final-cache-'));
    const directory = join(root, 'storage-batches');
    try {
      await mkdir(directory, { recursive: true });
      const batch = (index: number, value: string | null) =>
        JSON.stringify({
          schemaVersion: 1,
          blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
          batchIndex: index,
          keys: [KEY],
          values: [value],
        });
      await writeFile(join(directory, 'batch-000000.json'), batch(0, VALUE));
      await writeFile(join(directory, 'batch-000001.json'), batch(1, VALUE));
      const loaded = await loadFinalBalanceCache(directory, MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH);
      expect(loaded.values.get(KEY)).toBe(VALUE);
      await writeFile(join(directory, 'batch-000001.json'), batch(1, null));
      await expect(
        loadFinalBalanceCache(directory, MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH),
      ).rejects.toMatchObject({
        code: 'FINAL_STATE_BALANCE_CACHE_CONFLICT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
