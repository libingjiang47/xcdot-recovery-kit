import type { HolderRecord } from '../types.js';

export interface SubscanRawFile {
  name: string;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface SubscanRawManifestFile {
  file: string;
  sizeBytes: number;
  sha256: string;
}

export interface SubscanRawManifest {
  schemaVersion: 1;
  dataset: 'moonbeam-subscan-xcdot-holders';
  source: {
    provider: 'Moonbeam Subscan';
    csvFileCount: number;
    files: SubscanRawManifestFile[];
    rawDatasetDigest: string;
  };
  asset: {
    symbol: 'xcDOT';
    decimals: 10;
    assetId: string;
    contract: string;
  };
}

export interface SubscanRow {
  address: string;
  balancePlanck: string;
  rank: string;
  sourceFile: string;
  sourceRow: number;
  rawAddress: string;
  rawBalance: string;
}

export interface SubscanPageAudit {
  file: string;
  sha256: string;
  sizeBytes: number;
  rawRows: number;
  validRows: number;
  blankRows: number;
  invalidRows: number;
  schemaFingerprint: string;
  rankMin?: string;
  rankMax?: string;
}

export interface SubscanDuplicate {
  address: string;
  balancePlanck: string;
  occurrences: Array<{
    sourceFile: string;
    sourceRow: number;
    rawAddress: string;
    rawBalance: string;
  }>;
}

export interface SubscanImportResult {
  rawFileCount: number;
  rawRowCount: number;
  parsedRowCount: number;
  uniqueAddressCount: number;
  positiveHolderCount: number;
  zeroBalanceCount: number;
  exactDuplicateCount: number;
  conflictingDuplicateCount: number;
  invalidRowCount: number;
  subscanTotalBalancePlanck: string;
  subscanTotalBalanceXcdot: string;
  rawDatasetDigest: string;
  holdersSha256: string;
  holders: HolderRecord[];
  outputDirectory: string;
  checkOnly: boolean;
}
