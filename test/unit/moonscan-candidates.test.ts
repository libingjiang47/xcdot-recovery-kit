import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCandidateUniverse } from '../../src/candidates/candidate-universe.js';
import { parseMoonscanHolderCsv } from '../../src/candidates/moonscan.js';
import { candidateAddressesSha256 } from '../../src/subscan/candidates.js';

const ADDRESS_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDRESS_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDRESS_C = '0xcccccccccccccccccccccccccccccccccccccccc';

describe('Moonscan candidate discovery', () => {
  it('parses BOM/RFC-4180 CSV and converts exact decimal balances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-moonscan-csv-'));
    const path = join(root, 'holders.csv');
    try {
      await writeFile(
        path,
        `\ufeffHolderAddress,Balance,PendingBalanceUpdate\r\n0x${ADDRESS_B.slice(2).toUpperCase()},"1,234.5678901234","pending,review"\r\n${ADDRESS_A},0.0000000001,\r\n`,
        'utf8',
      );
      const imported = await parseMoonscanHolderCsv(path);
      expect(imported.rowCount).toBe(2);
      expect(imported.uniqueAddressCount).toBe(2);
      expect(imported.records.map((record) => record.address)).toEqual([ADDRESS_A, ADDRESS_B]);
      expect(imported.byAddress.get(ADDRESS_B)?.balancePlanckDiagnostic).toBe(12345678901234n);
      expect(imported.byAddress.get(ADDRESS_B)?.pendingBalanceUpdateRaw).toBe('pending,review');
      expect(imported.byAddress.get(ADDRESS_A)?.balancePlanckDiagnostic).toBe(1n);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows identical duplicate diagnostics and rejects conflicting duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xcdot-moonscan-duplicates-'));
    const same = join(root, 'same.csv');
    const conflict = join(root, 'conflict.csv');
    try {
      const header = 'HolderAddress,Balance,PendingBalanceUpdate\n';
      await writeFile(
        same,
        `${header}${ADDRESS_A},1.0000000000,\n${ADDRESS_A},1.0000000000,changed\n`,
      );
      const imported = await parseMoonscanHolderCsv(same);
      expect(imported.duplicateCount).toBe(1);
      await writeFile(
        conflict,
        `${header}${ADDRESS_A},1.0000000000,\n${ADDRESS_A},2.0000000000,\n`,
      );
      await expect(parseMoonscanHolderCsv(conflict)).rejects.toMatchObject({
        code: 'MOONSCAN_IMPORT_ERROR',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds a deterministic address-only union independent of source balances', () => {
    const subscan = {
      datasetDirectory: 'dataset',
      rawDirectory: 'dataset',
      rawFileCount: 1,
      rawRowCount: 2,
      validRowCount: 2,
      invalidRowCount: 0,
      uniqueValidAddressCount: 2,
      exactDuplicateAddressCount: 0,
      addresses: [ADDRESS_A, ADDRESS_B],
      sourceBalances: new Map([
        [ADDRESS_A, '1'],
        [ADDRESS_B, '2'],
      ]),
    };
    const moonscan = {
      sourceFile: 'moonscan.csv',
      sourceSha256: 'source',
      rowCount: 2,
      validRowCount: 2,
      uniqueAddressCount: 2,
      duplicateCount: 0,
      csvBalanceSumPlanckDiagnostic: 99n,
      records: [
        { address: ADDRESS_B, balancePlanckDiagnostic: 20n, pendingBalanceUpdateRaw: null },
        { address: ADDRESS_C, balancePlanckDiagnostic: 30n, pendingBalanceUpdateRaw: null },
      ],
      byAddress: new Map([
        [
          ADDRESS_B,
          { address: ADDRESS_B, balancePlanckDiagnostic: 20n, pendingBalanceUpdateRaw: null },
        ],
        [
          ADDRESS_C,
          { address: ADDRESS_C, balancePlanckDiagnostic: 30n, pendingBalanceUpdateRaw: null },
        ],
      ]),
    };
    const universe = buildCandidateUniverse(subscan, moonscan);
    expect(universe.addresses).toEqual([ADDRESS_A, ADDRESS_B, ADDRESS_C]);
    expect(universe.subscanOnly).toEqual([ADDRESS_A]);
    expect(universe.intersection).toEqual([ADDRESS_B]);
    expect(universe.moonscanOnly).toEqual([ADDRESS_C]);
    expect(universe.moonscanOnlySha256).toBe(candidateAddressesSha256([ADDRESS_C]));
    expect(universe.unionSha256).toBe(candidateAddressesSha256([ADDRESS_A, ADDRESS_B, ADDRESS_C]));
  });
});
