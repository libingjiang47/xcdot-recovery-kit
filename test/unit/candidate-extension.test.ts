import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCandidateExtensionNdjson } from '../../src/candidates/candidate-extension.js';

const ADDRESS_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDRESS_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('generic candidate extension discovery', () => {
  it('normalizes, deduplicates, sorts, and ignores diagnostic fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-candidate-extension-'));
    const path = join(root, 'holders.ndjson');
    try {
      await writeFile(
        path,
        [
          JSON.stringify({ address: `0x${ADDRESS_B.slice(2).toUpperCase()}`, balance: 'ignored' }),
          JSON.stringify({ address: ADDRESS_A }),
          JSON.stringify({ address: ADDRESS_B }),
        ].join('\n') + '\n',
      );
      const imported = await parseCandidateExtensionNdjson(path);
      expect(imported.rowCount).toBe(3);
      expect(imported.uniqueAddressCount).toBe(2);
      expect(imported.duplicateCount).toBe(1);
      expect(imported.records).toEqual([{ address: ADDRESS_A }, { address: ADDRESS_B }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-H160 address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-candidate-extension-invalid-'));
    const path = join(root, 'holders.ndjson');
    try {
      await writeFile(path, JSON.stringify({ address: '0x1234' }) + '\n');
      await expect(parseCandidateExtensionNdjson(path)).rejects.toMatchObject({
        code: 'CANDIDATE_EXTENSION_IMPORT_ERROR',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
