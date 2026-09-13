import { readFile } from 'node:fs/promises';
import { parseRfc4180, parseSubscanBalance } from '../subscan/csv.js';
import { sha256Hex } from '../snapshot/digest.js';
import { XC_DOT_DECIMALS } from '../asset/constants.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { XcDotError } from '../utils/errors.js';

export const MOONSCAN_HEADERS = ['HolderAddress', 'Balance', 'PendingBalanceUpdate'] as const;

export interface MoonscanHolderRecord {
  address: string;
  balancePlanckDiagnostic: bigint;
  pendingBalanceUpdateRaw: string | null;
}

export interface MoonscanImport {
  sourceFile: string;
  sourceSha256: string;
  rowCount: number;
  validRowCount: number;
  uniqueAddressCount: number;
  duplicateCount: number;
  csvBalanceSumPlanckDiagnostic: bigint;
  records: MoonscanHolderRecord[];
  byAddress: Map<string, MoonscanHolderRecord>;
}

export class MoonscanImportError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('MOONSCAN_IMPORT_ERROR', message, details);
    this.name = 'MoonscanImportError';
  }
}

function canonicalAddress(value: string, row: number): string {
  const address = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new MoonscanImportError('Moonscan HolderAddress is not a canonical H160.', {
      row,
      value: address,
    });
  }
  return address.toLowerCase();
}

function diagnosticBalance(value: string, sourceFile: string, row: number): bigint {
  try {
    return BigInt(parseSubscanBalance(value, sourceFile, row));
  } catch (error) {
    throw new MoonscanImportError('Moonscan Balance is not an exact unsigned decimal.', {
      sourceFile,
      row,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function parseMoonscanHolderCsv(sourceFile: string): Promise<MoonscanImport> {
  const bytes = await readFile(sourceFile);
  const records = parseRfc4180(bytes.toString('utf8'), sourceFile);
  const headers = records.shift();
  if (
    headers === undefined ||
    headers.length !== MOONSCAN_HEADERS.length ||
    headers.some((value, index) => value !== MOONSCAN_HEADERS[index])
  ) {
    throw new MoonscanImportError('Unsupported Moonscan holder CSV header.', { sourceFile });
  }

  const byAddress = new Map<string, MoonscanHolderRecord>();
  let rowCount = 0;
  let validRowCount = 0;
  let duplicateCount = 0;
  let csvBalanceSumPlanckDiagnostic = 0n;
  for (const [index, row] of records.entries()) {
    if (row.every((value) => value.trim() === '')) continue;
    rowCount += 1;
    const sourceRow = index + 2;
    if (row.length !== MOONSCAN_HEADERS.length) {
      throw new MoonscanImportError('Moonscan holder row has an unexpected column count.', {
        sourceFile,
        row: sourceRow,
      });
    }
    const address = canonicalAddress(row[0] ?? '', sourceRow);
    const balancePlanckDiagnostic = diagnosticBalance(row[1] ?? '', sourceFile, sourceRow);
    const pendingBalanceUpdateRaw = (row[2] ?? '').trim() || null;
    validRowCount += 1;
    csvBalanceSumPlanckDiagnostic += balancePlanckDiagnostic;
    const existing = byAddress.get(address);
    if (existing !== undefined) {
      duplicateCount += 1;
      if (existing.balancePlanckDiagnostic !== balancePlanckDiagnostic) {
        throw new MoonscanImportError(
          'Moonscan contains conflicting diagnostic balances for one address.',
          { sourceFile, row: sourceRow, address },
        );
      }
      continue;
    }
    byAddress.set(address, {
      address,
      balancePlanckDiagnostic,
      pendingBalanceUpdateRaw,
    });
  }

  const ordered = [...byAddress.values()].sort((left, right) =>
    compareCanonicalStrings(left.address, right.address),
  );
  return {
    sourceFile,
    sourceSha256: sha256Hex(bytes),
    rowCount,
    validRowCount,
    uniqueAddressCount: ordered.length,
    duplicateCount,
    csvBalanceSumPlanckDiagnostic,
    records: ordered,
    byAddress,
  };
}

export function serializeMoonscanDiagnosticBalance(value: bigint): string {
  const scale = 10n ** BigInt(XC_DOT_DECIMALS);
  const whole = value / scale;
  const fraction = (value % scale).toString(10).padStart(XC_DOT_DECIMALS, '0');
  return whole.toString(10) + '.' + fraction;
}
