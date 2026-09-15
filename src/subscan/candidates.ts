import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseSubscanAddress, parseSubscanBalance, parseSubscanPage } from './csv.js';
import { sha256Hex } from '../snapshot/digest.js';
import { compareCanonicalStrings } from '../utils/order.js';
import {
  FinalStateDiscoveryPartialError,
  SubscanDuplicateBalanceConflictError,
  SubscanImportIntegrityError,
  XcDotError,
} from '../utils/errors.js';

export interface CandidateDiscovery {
  datasetDirectory: string;
  rawDirectory: string;
  rawFileCount: number;
  rawRowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  uniqueValidAddressCount: number;
  exactDuplicateAddressCount: number;
  rawDatasetDigest?: string;
  addresses: string[];
  sourceBalances: Map<string, string>;
}

interface RawFile {
  name: string;
  bytes: Buffer;
  sha256: string;
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBlankRecord(record: readonly string[]): boolean {
  return record.every((value) => value.trim() === '');
}

function rawSums(files: readonly RawFile[]): string {
  return (
    files
      .map((file) => `${file.sha256}  ${file.name}`)
      .sort((a, b) =>
        compareCanonicalStrings(a.slice(a.indexOf('  ') + 2), b.slice(b.indexOf('  ') + 2)),
      )
      .join('\n') + '\n'
  );
}

async function readRawFiles(directory: string): Promise<RawFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new SubscanImportIntegrityError(`Cannot read Subscan dataset: ${directory}`, {
      directory,
      error: jsonError(error),
    });
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map((entry) => entry.name)
    .sort(compareCanonicalStrings);
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(directory, name));
      return { name, bytes, sha256: sha256Hex(bytes) };
    }),
  );
}

function parseAuditLine(line: string, lineNumber: number): { address: string; balance?: string } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new FinalStateDiscoveryPartialError('Subscan audit contains invalid JSON.', {
      lineNumber,
      error: jsonError(error),
    });
  }
  if (typeof value !== 'object' || value === null) {
    throw new FinalStateDiscoveryPartialError('Subscan audit line is not an object.', {
      lineNumber,
    });
  }
  const record = value as {
    address?: unknown;
    subscanBalancePlanck?: unknown;
    rawBalance?: unknown;
  };
  if (typeof record.address !== 'string') {
    throw new FinalStateDiscoveryPartialError('Subscan audit line has no address.', { lineNumber });
  }
  let address: string;
  try {
    address = parseSubscanAddress(record.address, 'audit', lineNumber);
  } catch (error) {
    throw new FinalStateDiscoveryPartialError('Subscan audit contains a non-H160 address.', {
      lineNumber,
      error: jsonError(error),
    });
  }
  const rawBalance = record.subscanBalancePlanck ?? record.rawBalance;
  if (rawBalance === undefined) return { address };
  if (typeof rawBalance !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rawBalance)) {
    throw new FinalStateDiscoveryPartialError('Subscan audit contains an invalid balance.', {
      lineNumber,
    });
  }
  return { address, balance: rawBalance };
}

async function fromAuditFile(
  datasetDirectory: string,
  auditPath: string,
): Promise<CandidateDiscovery> {
  const lines = (await readFile(auditPath, 'utf8')).split('\n').filter((line) => line !== '');
  const addresses = new Set<string>();
  const sourceBalances = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseAuditLine(lines[index] ?? '', index + 1);
    addresses.add(parsed.address);
    if (parsed.balance !== undefined) {
      const previous = sourceBalances.get(parsed.address);
      if (previous !== undefined && previous !== parsed.balance) {
        throw new SubscanDuplicateBalanceConflictError(
          'Subscan audit contains conflicting balances for one address.',
          { address: parsed.address },
        );
      }
      sourceBalances.set(parsed.address, parsed.balance);
    }
  }
  const sorted = [...addresses].sort(compareCanonicalStrings);
  return {
    datasetDirectory,
    rawDirectory: datasetDirectory,
    rawFileCount: 0,
    rawRowCount: lines.length,
    validRowCount: lines.length,
    invalidRowCount: 0,
    uniqueValidAddressCount: sorted.length,
    exactDuplicateAddressCount: lines.length - sorted.length,
    addresses: sorted,
    sourceBalances,
  };
}

export async function discoverCandidateAddresses(dataset: string): Promise<CandidateDiscovery> {
  const datasetDirectory = resolve(dataset);
  let rawDirectory = datasetDirectory;
  let files = await readRawFiles(rawDirectory);
  if (files.length === 0) {
    const parent = resolve(datasetDirectory, '..');
    const parentFiles = await readRawFiles(parent);
    if (parentFiles.length > 0) {
      rawDirectory = parent;
      files = parentFiles;
    }
  }
  if (files.length === 0) {
    const auditPath = join(datasetDirectory, 'provenance.ndjson');
    try {
      return await fromAuditFile(datasetDirectory, auditPath);
    } catch (error) {
      if (error instanceof XcDotError) throw error;
      throw new FinalStateDiscoveryPartialError(
        'No Subscan CSV files or imported provenance audit was found.',
        { dataset: datasetDirectory, audit: auditPath, error: jsonError(error) },
      );
    }
  }

  const rawDigest = sha256Hex(rawSums(files));
  const checksumPath = join(rawDirectory, 'RAW_SHA256SUMS');
  try {
    const recorded = await readFile(checksumPath, 'utf8');
    if (recorded !== rawSums(files)) {
      throw new SubscanImportIntegrityError(
        'Raw Subscan checksum file does not match the current CSV bytes.',
        { checksumPath },
      );
    }
  } catch (error) {
    if (error instanceof SubscanImportIntegrityError) throw error;
    // The checksum is optional for a newly supplied dataset; the CSV bytes are still hashed.
  }

  const addresses = new Set<string>();
  const sourceBalances = new Map<string, string>();
  let rawRowCount = 0;
  let validRowCount = 0;
  let invalidRowCount = 0;
  for (const file of files) {
    const parsed = parseSubscanPage(file.bytes.toString('utf8'), file.name);
    for (let index = 0; index < parsed.records.length; index += 1) {
      const record = parsed.records[index];
      if (record === undefined || isBlankRecord(record)) continue;
      rawRowCount += 1;
      const sourceRow = index + 2;
      let address: string;
      let balance: string;
      try {
        address = parseSubscanAddress(record[1] ?? '', file.name, sourceRow);
        balance = parseSubscanBalance(record[2] ?? '', file.name, sourceRow);
      } catch {
        invalidRowCount += 1;
        continue;
      }
      validRowCount += 1;
      addresses.add(address);
      const previous = sourceBalances.get(address);
      if (previous !== undefined && previous !== balance) {
        throw new SubscanDuplicateBalanceConflictError(
          'Subscan CSV contains conflicting balances for one address.',
          { address },
        );
      }
      sourceBalances.set(address, balance);
    }
  }
  const sorted = [...addresses].sort(compareCanonicalStrings);
  return {
    datasetDirectory,
    rawDirectory,
    rawFileCount: files.length,
    rawRowCount,
    validRowCount,
    invalidRowCount,
    uniqueValidAddressCount: sorted.length,
    exactDuplicateAddressCount: validRowCount - sorted.length,
    rawDatasetDigest: rawDigest,
    addresses: sorted,
    sourceBalances,
  };
}

export function serializeCandidateAddresses(addresses: readonly string[]): string {
  return (
    addresses.map((address) => JSON.stringify({ address: address.toLowerCase() })).join('\n') +
    (addresses.length > 0 ? '\n' : '')
  );
}

export function candidateAddressesSha256(addresses: readonly string[]): string {
  return sha256Hex(serializeCandidateAddresses(addresses));
}
