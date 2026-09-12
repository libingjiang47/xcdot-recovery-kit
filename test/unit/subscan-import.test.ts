import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRfc4180, parseSubscanBalance, parseSubscanPage } from '../../src/subscan/csv.js';
import { runSubscanImport } from '../../src/subscan/import.js';

const address = (suffix: string): string => `0x${suffix.padStart(40, '0')}`;

async function makeInput(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'xcdot-subscan-'));
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content, 'utf8');
  return directory;
}

async function dispose(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

describe('Subscan CSV adapter', () => {
  it('parses BOM, CRLF, quoted fields, escaped quotes, and trailing blanks', () => {
    const records = parseRfc4180(
      '\ufeffRank,Account,Balance\r\n1,"0x0000000000000000000000000000000000000001","1.0"\r\n\r\n',
      'fixture.csv',
    );
    expect(records).toEqual([['Rank', 'Account', 'Balance'], ['1', address('1'), '1.0'], ['']]);
    expect(
      parseSubscanPage('\ufeffRank,Account,Balance\n1,"a,b",1\n', 'fixture.csv').headers,
    ).toEqual(['Rank', 'Account', 'Balance']);
    expect(parseSubscanBalance('0001.0000000001', 'fixture.csv', 2)).toBe('10000000001');
  });

  it('uses exact integer arithmetic for large balances', () => {
    expect(parseSubscanBalance('123456789012345678901234567890.1234567890', 'fixture.csv', 2)).toBe(
      '1234567890123456789012345678901234567890',
    );
    expect(parseSubscanBalance('47,991.4883085097', 'fixture.csv', 2)).toBe('479914883085097');
  });

  it('creates the same candidate digest when source file order changes', async () => {
    const first = await makeInput({
      'a.csv': `Rank,Account,Balance\n1,${address('1')},1\n`,
      'b.csv': `Rank,Account,Balance\n2,${address('2')},2\n`,
    });
    const second = await makeInput({
      'b.csv': `Rank,Account,Balance\n1,${address('1')},1\n`,
      'a.csv': `Rank,Account,Balance\n2,${address('2')},2\n`,
    });
    try {
      const firstResult = await runSubscanImport({ input: first, expectedFiles: 2 });
      const secondResult = await runSubscanImport({ input: second, expectedFiles: 2 });
      expect(firstResult.holdersSha256).toBe(secondResult.holdersSha256);
      expect(firstResult.subscanTotalBalancePlanck).toBe('30000000000');
      expect(await readFile(join(first, 'derived', 'holders.ndjson'), 'utf8')).toBe(
        await readFile(join(second, 'derived', 'holders.ndjson'), 'utf8'),
      );
    } finally {
      await dispose(first);
      await dispose(second);
    }
  });

  it.each([
    ['invalid address', `Rank,Account,Balance\n1,0x123,1\n`, 'SUBSCAN_INVALID_ADDRESS'],
    [
      'excess precision',
      `Rank,Account,Balance\n1,${address('1')},1.00000000001\n`,
      'SUBSCAN_BALANCE_PRECISION',
    ],
  ])('rejects %s', async (_label, content, code) => {
    const directory = await makeInput({ 'page.csv': content });
    try {
      await expect(runSubscanImport({ input: directory, expectedFiles: 1 })).rejects.toMatchObject({
        code,
      });
    } finally {
      await dispose(directory);
    }
  });

  it('rejects exact and semantic duplicate pages and conflicting balances', async () => {
    const exact = await makeInput({
      'a.csv': `Rank,Account,Balance\n1,${address('1')},1\n`,
      'b.csv': `Rank,Account,Balance\n1,${address('1')},1\n`,
    });
    const semantic = await makeInput({
      'a.csv': `Rank,Account,Balance\n1,${address('1')},1\n`,
      'b.csv': `Rank,Account,Balance\r\n1,${address('1')},1.0\r\n`,
    });
    const conflict = await makeInput({
      'a.csv': `Rank,Account,Balance\n1,${address('1')},1\n`,
      'b.csv': `Rank,Account,Balance\n2,${address('1')},2\n`,
    });
    try {
      await expect(runSubscanImport({ input: exact, expectedFiles: 2 })).rejects.toMatchObject({
        code: 'SUBSCAN_DUPLICATE_FILE',
      });
      await expect(runSubscanImport({ input: semantic, expectedFiles: 2 })).rejects.toMatchObject({
        code: 'SUBSCAN_SEMANTIC_DUPLICATE_PAGE',
      });
      await expect(runSubscanImport({ input: conflict, expectedFiles: 2 })).rejects.toMatchObject({
        code: 'SUBSCAN_DUPLICATE_BALANCE_CONFLICT',
      });
    } finally {
      await dispose(exact);
      await dispose(semantic);
      await dispose(conflict);
    }
  });

  it('check-only does not create derived output', async () => {
    const directory = await makeInput({
      'page.csv': `Rank,Account,Balance\n1,${address('1')},1\n`,
    });
    try {
      const result = await runSubscanImport({
        input: directory,
        expectedFiles: 1,
        checkOnly: true,
      });
      expect(result.checkOnly).toBe(true);
      await expect(readFile(join(directory, 'derived', 'holders.ndjson'))).rejects.toThrow();
      await expect(readFile(join(directory, 'raw-manifest.json'))).rejects.toThrow();
    } finally {
      await dispose(directory);
    }
  });
});
