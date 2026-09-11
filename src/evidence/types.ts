import type { AssetIdentity, BlockIdentity, HolderRecord } from '../types.js';

export interface EvidenceStorageAssetRecord {
  kind: 'asset';
  key: string;
  value: string;
}

export interface EvidenceStorageMetadataRecord {
  kind: 'metadata';
  key: string;
  value: string;
}

export interface EvidenceStorageAccountRecord {
  kind: 'account';
  address: string;
  key: string;
  value: string;
  balancePlanck: string;
}

export type EvidenceStorageRecord =
  | EvidenceStorageAssetRecord
  | EvidenceStorageMetadataRecord
  | EvidenceStorageAccountRecord;

export interface EvidenceProofBatch {
  schemaVersion: 1;
  blockHash: string;
  stateRoot: string;
  batchIndex: number;
  keys: string[];
  proof: string[];
}

export interface EvidenceManifest {
  schemaVersion: 1;
  tool: 'xcdot-recovery-kit';
  evidenceFormat: 'xcdot-evidence-v1';
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
    extrinsicsRoot: string;
  };
  runtime: {
    specName: string;
    specVersion: number;
    transactionVersion: number;
    stateVersion: number;
    metadataSha256: string;
    runtimeCodeSha256?: string;
  };
  asset: {
    assetId: string;
    xc20Address: string;
    symbol: string;
    decimals: number;
    totalSupplyPlanck: string;
    accountCount: string;
  };
  holders: {
    count: number;
    sumBalancePlanck: string;
    holdersSha256: string;
    storageSha256: string;
  };
  proofs: {
    batchSize: number;
    batchCount: number;
    proofIndexSha256: string;
  };
  relayAnchor: {
    status: 'NOT_CAPTURED' | 'CAPTURED';
  };
  evidenceDigest: string;
}

export interface EvidenceCore {
  schemaVersion: 1;
  block: BlockIdentity;
  asset: AssetIdentity;
  assetDetails: unknown;
  metadata: unknown;
  holders: HolderRecord[];
  storageRecordCount: number;
}

export interface LegacyEvidenceCapture {
  block: BlockIdentity;
  asset: AssetIdentity;
  metadata: unknown;
  metadataScaleHex: string;
  storage: EvidenceStorageRecord[];
  holders: HolderRecord[];
  runtimeCodeHex?: string;
}
