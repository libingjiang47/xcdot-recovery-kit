export interface HolderRecord {
  address: string;
  balancePlanck: string;
}

export interface BlockIdentity {
  blockNumber: string;
  blockHash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  genesisHash: string;
  specName: string;
  specVersion: number;
  transactionVersion: number;
  stateVersion: number;
}

export interface AssetIdentity {
  symbol: string;
  assetId: string;
  xc20Address: string;
  decimals: number;
  totalSupplyPlanck: string;
  accountCount: string;
  minimumBalancePlanck: string;
  isFrozen?: boolean | undefined;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  tool: 'xcdot-recovery-kit';
  chain: {
    name: 'Moonbeam';
    paraId: 2004;
    genesisHash: string;
  };
  snapshot: {
    blockNumber: string;
    blockHash: string;
    parentHash: string;
    stateRoot: string;
    specName: string;
    specVersion: number;
  };
  asset: AssetIdentity;
  holders: {
    count: number;
    totalBalancePlanck: string;
    sha256: string;
  };
  snapshotDigest: string;
}

export type CodeStatus = 'no_code' | 'has_code' | 'system_precompile' | 'unknown';

export interface AccountClassification {
  address: string;
  codeStatus: CodeStatus;
  classification: 'code-present' | 'no-code' | 'system-precompile' | 'unknown';
  codeSize?: number;
  codeHash?: string;
  source: string;
}

export interface VerificationResult {
  substrateSupplyMatchesHolderSum: boolean;
  evmSupplyMatchesSubstrateSupply: boolean;
  holderBalancesChecked: number;
  holderBalanceMismatches: Array<{
    address: string;
    expected: string;
    actual: string;
  }>;
  errors?: string[] | undefined;
  status: 'PASS' | 'FAIL' | 'NOT_RUN';
}

export interface ExtractionResult {
  block: BlockIdentity;
  asset: AssetIdentity;
  allAccounts: HolderRecord[];
  holders: HolderRecord[];
}
