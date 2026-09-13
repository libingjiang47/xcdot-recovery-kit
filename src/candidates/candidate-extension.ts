import { readFile } from 'node:fs/promises';
import { sha256Hex } from '../snapshot/digest.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { CandidateExtensionImportError } from '../utils/errors.js';

export interface CandidateExtensionRecord {
  address: string;
}

export interface CandidateExtensionImport {
  sourceFile: string;
  sourceSha256: string;
  rowCount: number;
  validRowCount: number;
  uniqueAddressCount: number;
  duplicateCount: number;
  records: CandidateExtensionRecord[];
  byAddress: Map<string, CandidateExtensionRecord>;
}

function canonicalAddress(value: string, line: number): string {
  const address = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new CandidateExtensionImportError(
      'Candidate extension address is not a canonical H160.',
      { line, value: address },
    );
  }
  return address.toLowerCase();
}

export async function parseCandidateExtensionNdjson(
  sourceFile: string,
): Promise<CandidateExtensionImport> {
  const bytes = await readFile(sourceFile);
  const lines = bytes
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const byAddress = new Map<string, CandidateExtensionRecord>();
  let duplicateCount = 0;
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new CandidateExtensionImportError('Candidate extension contains invalid JSON.', {
        sourceFile,
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CandidateExtensionImportError('Candidate extension line must be a JSON object.', {
        sourceFile,
        line: index + 1,
      });
    }
    const address = canonicalAddress(
      String((value as { address?: unknown }).address ?? ''),
      index + 1,
    );
    if (byAddress.has(address)) {
      duplicateCount += 1;
      continue;
    }
    byAddress.set(address, { address });
  }
  const records = [...byAddress.values()].sort((left, right) =>
    compareCanonicalStrings(left.address, right.address),
  );
  return {
    sourceFile,
    sourceSha256: sha256Hex(bytes),
    rowCount: lines.length,
    validRowCount: lines.length,
    uniqueAddressCount: records.length,
    duplicateCount,
    records,
    byAddress,
  };
}
