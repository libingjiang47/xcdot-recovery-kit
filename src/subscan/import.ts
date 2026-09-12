import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readGitCommit, pathExists } from '../snapshot/io.js';
import { fileSha256s, sha256Hex } from '../snapshot/digest.js';
import { formatDot } from '../utils/numbers.js';
import { compareCanonicalStrings } from '../utils/order.js';
import {
  SubscanDuplicateBalanceConflictError,
  SubscanDuplicateFileError,
  SubscanFileCountMismatchError,
  SubscanImportIntegrityError,
  SubscanSemanticDuplicatePageError,
  SubscanSchemaMismatchError,
  XcDotError,
} from '../utils/errors.js';
import {
  MOONBEAM_GENESIS_HASH,
  XC_DOT_ASSET_ID_DECIMAL,
  XC_DOT_DECIMALS,
  XC_DOT_SYMBOL,
  XC_DOT_XC20_ADDRESS,
} from '../asset/constants.js';
import { parseSubscanAddress, parseSubscanBalance, parseSubscanPage } from './csv.js';
import type {
  SubscanDuplicate,
  SubscanImportResult,
  SubscanPageAudit,
  SubscanRawFile,
  SubscanRawManifest,
  SubscanRow,
} from './types.js';

const DATASET = 'moonbeam-subscan-xcdot-holders' as const;
const IMPORTER_VERSION = '0.25.0';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function canonicalHoldersNdjson(
  holders: readonly { address: string; balancePlanck: string }[],
): string {
  return (
    holders.map((holder) => JSON.stringify(holder)).join('\n') + (holders.length > 0 ? '\n' : '')
  );
}

function canonicalHoldersCsv(
  holders: readonly { address: string; balancePlanck: string }[],
): string {
  const rows = ['address,balance_planck,balance_xcdot'];
  for (const holder of holders) {
    rows.push(
      `${holder.address},${holder.balancePlanck},${formatDot(BigInt(holder.balancePlanck), 10)}`,
    );
  }
  return rows.join('\n') + '\n';
}

function discoveryRawSums(files: readonly SubscanRawFile[]): string {
  return (
    files
      .map((file) => `${file.sha256}  ${file.name}`)
      .sort((a, b) =>
        compareCanonicalStrings(a.slice(a.indexOf('  ') + 2), b.slice(b.indexOf('  ') + 2)),
      )
      .join('\n') + '\n'
  );
}

function semanticPageDigest(rows: readonly SubscanRow[]): string {
  return sha256Hex(
    rows.map((row) => JSON.stringify([row.address, row.balancePlanck])).join('\n') +
      (rows.length > 0 ? '\n' : ''),
  );
}

function isBlankRecord(record: readonly string[]): boolean {
  return record.every((value) => value.trim() === '');
}

async function discoverRawFiles(input: string): Promise<SubscanRawFile[]> {
  let entries;
  try {
    entries = await readdir(input, { withFileTypes: true });
  } catch (error) {
    throw new SubscanImportIntegrityError(`Cannot read Subscan input directory: ${input}`, {
      input,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map((entry) => entry.name)
    .sort(compareCanonicalStrings);
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(input, name));
      return { name, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes), bytes };
    }),
  );
}

function validateRanks(rows: readonly SubscanRow[]): void {
  if (rows.length === 0) return;
  const ranks = rows.map((row) => BigInt(row.rank)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let index = 1; index < ranks.length; index += 1) {
    const previous = ranks[index - 1];
    const current = ranks[index];
    if (previous === undefined || current === undefined || current !== previous + 1n) {
      throw new SubscanSchemaMismatchError('Subscan Rank values are not unique and contiguous.', {
        rank: current?.toString(10) ?? 'unknown',
      });
    }
  }
}

export interface SubscanImportOptions {
  input: string;
  expectedFiles: number;
  checkOnly?: boolean;
  force?: boolean;
}

export async function runSubscanImport(
  options: SubscanImportOptions,
  emitProgress: (message: string) => void = (message) => console.error(message),
): Promise<SubscanImportResult> {
  const input = resolve(options.input);
  const outputDirectory = join(input, 'derived');
  if (!options.checkOnly && (await pathExists(outputDirectory)) && !options.force) {
    throw new SubscanImportIntegrityError(
      `Derived import already exists: ${outputDirectory}; use --force to replace it.`,
      { outputDirectory },
    );
  }

  const files = await discoverRawFiles(input);
  if (files.length !== options.expectedFiles) {
    throw new SubscanFileCountMismatchError('Unexpected number of direct Subscan CSV files.', {
      expectedFiles: options.expectedFiles,
      actualFiles: files.length,
    });
  }

  const rawSums = discoveryRawSums(files);
  const rawDatasetDigest = sha256Hex(rawSums);
  const rawManifest: SubscanRawManifest = {
    schemaVersion: 1,
    dataset: DATASET,
    source: {
      provider: 'Moonbeam Subscan',
      csvFileCount: files.length,
      files: files.map(({ name, sizeBytes, sha256 }) => ({ file: name, sizeBytes, sha256 })),
      rawDatasetDigest,
    },
    asset: {
      symbol: XC_DOT_SYMBOL,
      decimals: XC_DOT_DECIMALS,
      assetId: XC_DOT_ASSET_ID_DECIMAL,
      contract: XC_DOT_XC20_ADDRESS,
    },
  };
  if (!options.checkOnly) {
    await writeFile(join(input, 'RAW_SHA256SUMS'), rawSums, 'utf8');
    await writeFile(join(input, 'raw-manifest.json'), json(rawManifest), 'utf8');
  }

  const duplicateHashes = new Map<string, string[]>();
  for (const file of files) {
    duplicateHashes.set(file.sha256, [...(duplicateHashes.get(file.sha256) ?? []), file.name]);
  }
  const duplicateFiles = [...duplicateHashes.values()].filter((names) => names.length > 1);
  if (duplicateFiles.length > 0) {
    throw new SubscanDuplicateFileError('Two Subscan CSV files have identical bytes.', {
      files: duplicateFiles.map((names) => names.join(',')).join(';'),
    });
  }

  const pages: SubscanPageAudit[] = [];
  const allRows: SubscanRow[] = [];
  const pageDigests = new Map<string, string>();
  let invalidError: Error | undefined;

  for (const file of files) {
    const parsed = parseSubscanPage(Buffer.from(file.bytes).toString('utf8'), file.name);
    const rows: SubscanRow[] = [];
    let blankRows = 0;
    let invalidRows = 0;
    for (let index = 0; index < parsed.records.length; index += 1) {
      const record = parsed.records[index];
      const sourceRow = index + 2;
      if (record === undefined) continue;
      if (isBlankRecord(record)) {
        blankRows += 1;
        continue;
      }
      try {
        const rawRank = record[0] ?? '';
        if (!/^\d+$/.test(rawRank.trim())) {
          throw new SubscanSchemaMismatchError('Subscan Rank is not an unsigned integer.', {
            sourceFile: file.name,
            sourceRow,
            rawValue: rawRank,
          });
        }
        rows.push({
          rank: rawRank.trim(),
          address: parseSubscanAddress(record[1] ?? '', file.name, sourceRow),
          balancePlanck: parseSubscanBalance(record[2] ?? '', file.name, sourceRow),
          sourceFile: file.name,
          sourceRow,
          rawAddress: record[1] ?? '',
          rawBalance: record[2] ?? '',
        });
      } catch (error) {
        invalidRows += 1;
        if (!invalidError && error instanceof Error) invalidError = error;
      }
    }

    const pageDigest = semanticPageDigest(rows);
    const previousFile = pageDigests.get(pageDigest);
    if (previousFile && previousFile !== file.name) {
      throw new SubscanSemanticDuplicatePageError(
        'Two Subscan pages contain the same ordered rows.',
        {
          firstFile: previousFile,
          secondFile: file.name,
        },
      );
    }
    pageDigests.set(pageDigest, file.name);
    allRows.push(...rows);
    const ranks = rows.map((row) => BigInt(row.rank));
    pages.push({
      file: file.name,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      rawRows: parsed.records.length,
      validRows: rows.length,
      blankRows,
      invalidRows,
      schemaFingerprint: parsed.schemaFingerprint,
      ...(ranks.length > 0
        ? {
            rankMin: ranks.reduce((a, b) => (a < b ? a : b)).toString(10),
            rankMax: ranks.reduce((a, b) => (a > b ? a : b)).toString(10),
          }
        : {}),
    });
  }

  const fingerprints = new Set(pages.map((page) => page.schemaFingerprint));
  if (fingerprints.size !== 1) {
    throw new SubscanSchemaMismatchError('Subscan CSV schema fingerprints differ between files.', {
      fingerprintCount: fingerprints.size,
    });
  }
  if (invalidError) {
    if (invalidError instanceof XcDotError) {
      Object.assign(invalidError.details, {
        rawFileCount: files.length,
        rawRowCount: pages.reduce((sum, page) => sum + page.rawRows, 0),
        invalidRowCount: pages.reduce((sum, page) => sum + page.invalidRows, 0),
      });
    }
    throw invalidError;
  }
  validateRanks(allRows);

  const grouped = new Map<string, SubscanRow[]>();
  for (const row of allRows) grouped.set(row.address, [...(grouped.get(row.address) ?? []), row]);
  const duplicates: SubscanDuplicate[] = [];
  const canonicalAll = [] as Array<{ address: string; balancePlanck: string }>;
  for (const [address, rows] of grouped) {
    const balances = new Set(rows.map((row) => row.balancePlanck));
    if (balances.size > 1) {
      throw new SubscanDuplicateBalanceConflictError(
        'An address has conflicting Subscan balances.',
        {
          address,
          sourceRows: rows.map((row) => `${row.sourceFile}:${row.sourceRow}`).join(','),
        },
      );
    }
    const first = rows[0];
    if (!first) continue;
    canonicalAll.push({ address, balancePlanck: first.balancePlanck });
    if (rows.length > 1) {
      duplicates.push({
        address,
        balancePlanck: first.balancePlanck,
        occurrences: rows.map(({ sourceFile, sourceRow, rawAddress, rawBalance }) => ({
          sourceFile,
          sourceRow,
          rawAddress,
          rawBalance,
        })),
      });
    }
  }
  canonicalAll.sort((a, b) => compareCanonicalStrings(a.address, b.address));
  const holders = canonicalAll.filter((holder) => BigInt(holder.balancePlanck) > 0n);
  const holdersNdjson = canonicalHoldersNdjson(holders);
  const holdersSha256 = sha256Hex(holdersNdjson);
  let subscanTotal = 0n;
  for (const holder of holders) subscanTotal += BigInt(holder.balancePlanck);
  const provenance = allRows
    .map(({ address, sourceFile, sourceRow, rawAddress, rawBalance }) =>
      JSON.stringify({ address, sourceFile, sourceRow, rawAddress, rawBalance }),
    )
    .join('\n');
  const provenanceNdjson = provenance === '' ? '' : `${provenance}\n`;
  const duplicatesNdjson =
    duplicates.length === 0
      ? ''
      : duplicates.map((duplicate) => JSON.stringify(duplicate)).join('\n') + '\n';
  const holdersJson = json(holders);
  const holdersCsv = canonicalHoldersCsv(holders);
  const summary = {
    schemaVersion: 1,
    dataset: DATASET,
    source: {
      provider: 'Moonbeam Subscan',
      status: 'DISCOVERY_ONLY',
      rawFileCount: files.length,
      rawDatasetDigest,
    },
    asset: {
      symbol: XC_DOT_SYMBOL,
      decimals: XC_DOT_DECIMALS,
      assetId: XC_DOT_ASSET_ID_DECIMAL,
      contract: XC_DOT_XC20_ADDRESS,
    },
    import: {
      rawRowCount: allRows.length + pages.reduce((sum, page) => sum + page.blankRows, 0),
      parsedRowCount: allRows.length,
      uniqueAddressCount: canonicalAll.length,
      positiveHolderCount: holders.length,
      zeroBalanceCount: canonicalAll.length - holders.length,
      exactDuplicateCount: allRows.length - canonicalAll.length,
      conflictingDuplicateCount: 0,
      invalidRowCount: pages.reduce((sum, page) => sum + page.invalidRows, 0),
    },
    balances: {
      subscanTotalBalancePlanck: subscanTotal.toString(10),
      subscanTotalBalanceXcdot: formatDot(subscanTotal, XC_DOT_DECIMALS),
    },
    canonical: { holdersSha256 },
    status: 'DISCOVERY_ONLY',
  };
  const importManifest = {
    schemaVersion: 1,
    tool: 'xcdot-recovery-kit',
    importerVersion: IMPORTER_VERSION,
    dataset: DATASET,
    schemaFingerprint: pages[0]?.schemaFingerprint ?? '',
    rawDatasetDigest,
    candidate: {
      holdersSha256,
      count: holders.length,
      totalBalancePlanck: subscanTotal.toString(10),
    },
    asset: {
      symbol: XC_DOT_SYMBOL,
      decimals: XC_DOT_DECIMALS,
      assetId: XC_DOT_ASSET_ID_DECIMAL,
      contract: XC_DOT_XC20_ADDRESS,
      genesisHash: MOONBEAM_GENESIS_HASH,
      paraId: 2004,
    },
  };
  const importProvenance = {
    schemaVersion: 1,
    toolCommit: (await readGitCommit()) ?? 'unknown',
    toolVersion: IMPORTER_VERSION,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    command: process.argv.slice(2).join(' '),
  };
  const derivedFiles: Record<string, string> = {
    'duplicates.ndjson': duplicatesNdjson,
    'holders.csv': holdersCsv,
    'holders.json': holdersJson,
    'holders.ndjson': holdersNdjson,
    'import-manifest.json': json(importManifest),
    'import-provenance.json': json(importProvenance),
    'pages.json': json(pages),
    'provenance.ndjson': provenanceNdjson,
    'summary.json': json(summary),
  };
  if (!options.checkOnly) {
    const tempDirectory = await mkdtemp(join(dirname(outputDirectory), '.tmp-subscan-'));
    try {
      for (const [name, contents] of Object.entries(derivedFiles)) {
        await writeFile(join(tempDirectory, name), contents, 'utf8');
      }
      const hashes = fileSha256s(derivedFiles);
      const sums =
        Object.entries(hashes)
          .sort(([a], [b]) => compareCanonicalStrings(a, b))
          .map(([name, hash]) => `${hash}  ${name}`)
          .join('\n') + '\n';
      await writeFile(join(tempDirectory, 'SHA256SUMS'), sums, 'utf8');
      if (await pathExists(outputDirectory))
        await rm(outputDirectory, { recursive: true, force: true });
      await rename(tempDirectory, outputDirectory);
    } catch (error) {
      await rm(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  emitProgress(
    `[subscan] files=${files.length} rows=${allRows.length} unique=${canonicalAll.length} holders=${holders.length}`,
  );
  emitProgress(`[subscan] raw_dataset_digest=${rawDatasetDigest}`);
  emitProgress(`[subscan] holders_sha256=${holdersSha256}`);
  return {
    rawFileCount: files.length,
    rawRowCount: allRows.length + pages.reduce((sum, page) => sum + page.blankRows, 0),
    parsedRowCount: allRows.length,
    uniqueAddressCount: canonicalAll.length,
    positiveHolderCount: holders.length,
    zeroBalanceCount: canonicalAll.length - holders.length,
    exactDuplicateCount: allRows.length - canonicalAll.length,
    conflictingDuplicateCount: 0,
    invalidRowCount: pages.reduce((sum, page) => sum + page.invalidRows, 0),
    subscanTotalBalancePlanck: subscanTotal.toString(10),
    subscanTotalBalanceXcdot: formatDot(subscanTotal, XC_DOT_DECIMALS),
    rawDatasetDigest,
    holdersSha256,
    holders,
    outputDirectory,
    checkOnly: Boolean(options.checkOnly),
  };
}
