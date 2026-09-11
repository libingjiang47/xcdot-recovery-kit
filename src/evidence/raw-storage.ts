import type { ApiPromise } from '@polkadot/api';
import { decodeStorageEntry, type StorageKeyLike } from '../asset/decode.js';
import { XC_DOT_ASSET_ID } from '../asset/constants.js';
import { canonicalizeHolders } from '../snapshot/canonicalize.js';
import { retryRpc } from '../verification/providers.js';
import {
  EvidenceBackendUnsupportedError,
  EnumerationUnsupportedError,
  StorageDecodeError,
} from '../utils/errors.js';
import type { HolderRecord } from '../types.js';
import type {
  EvidenceStorageAccountRecord,
  EvidenceStorageAssetRecord,
  EvidenceStorageMetadataRecord,
  EvidenceStorageRecord,
} from './types.js';

export interface LegacyStorageCapture {
  asset: EvidenceStorageAssetRecord;
  metadata: EvidenceStorageMetadataRecord;
  accounts: EvidenceStorageAccountRecord[];
  holders: HolderRecord[];
  decodedAsset: Record<string, unknown>;
  decodedMetadata: Record<string, unknown>;
}

function lowerHex(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value : (value as { toHex?: () => string })?.toHex?.();
  if (!text || !/^0x[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
    throw new StorageDecodeError(`Malformed raw ${label} returned by RPC.`);
  }
  return text.toLowerCase();
}

export function codecJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'bigint') return nested.toString(10);
      return nested;
    }),
  ) as unknown;
}

function keyHex(key: StorageKeyLike): string {
  return lowerHex(key.toHex(), 'storage key');
}

async function rawStorage(api: ApiPromise, key: string, blockHash: string): Promise<string> {
  const value = await retryRpc(() => api.rpc.state.getStorage(key, blockHash));
  if (!value || (value as { isNone?: boolean }).isNone === true) {
    throw new StorageDecodeError('Required storage value is absent at the pinned block.', { key });
  }
  return lowerHex(value, 'storage value');
}

function queryKey(query: unknown, args: unknown[], label: string): string {
  const key = (query as { key?: (...values: unknown[]) => unknown } | null)?.key;
  if (typeof key !== 'function') {
    throw new EnumerationUnsupportedError(`${label} does not expose a raw storage key encoder.`);
  }
  return lowerHex(key(...args), `${label} key`);
}

function queryMethod(
  assets: Record<string, unknown>,
  name: string,
): (...args: unknown[]) => Promise<unknown> {
  const query = assets[name];
  if (typeof query !== 'function') {
    throw new EvidenceBackendUnsupportedError(
      `Legacy Assets.${name} storage query is unavailable.`,
    );
  }
  return query as (...args: unknown[]) => Promise<unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new StorageDecodeError(`${label} did not decode to a record.`);
  }
  return value as Record<string, unknown>;
}

export function assertLegacyAssetsBackend(apiAt: { query: unknown }): Record<string, unknown> {
  const assets = (apiAt.query as Record<string, unknown> | undefined)?.assets;
  if (typeof assets !== 'object' || assets === null) {
    const queryNames = Object.keys((apiAt.query as Record<string, unknown> | undefined) ?? {})
      .filter((name) => name.toLowerCase().includes('asset'))
      .sort()
      .join(', ');
    throw new EvidenceBackendUnsupportedError(
      'Pinned runtime does not expose the proof-complete legacy Assets backend; ' +
        `asset-like query namespaces: ${queryNames || 'none'}. ` +
        'EvmForeignAssets is an EVM-backed registry and does not by itself enumerate ' +
        'complete H160 holder balances.',
    );
  }
  return assets as Record<string, unknown>;
}

export async function captureLegacyStorage(
  api: ApiPromise,
  blockHash: string,
  pageSize: number,
): Promise<LegacyStorageCapture> {
  const apiAt = await api.at(blockHash);
  const assets = assertLegacyAssetsBackend(apiAt);
  const assetQuery = queryMethod(assets, 'asset');
  const metadataQuery = queryMethod(assets, 'metadata');
  const accountQuery = assets.account as {
    key?: (...args: unknown[]) => unknown;
    entriesPaged?: (options: Record<string, unknown>) => Promise<Array<[StorageKeyLike, unknown]>>;
  };
  if (!accountQuery || typeof accountQuery.entriesPaged !== 'function') {
    throw new EnumerationUnsupportedError(
      'Assets.Account does not support paged storage enumeration at the pinned runtime.',
    );
  }

  const assetValue = await assetQuery(XC_DOT_ASSET_ID);
  const metadataValue = await metadataQuery(XC_DOT_ASSET_ID);
  if ((assetValue as { isNone?: boolean } | null)?.isNone) {
    throw new EvidenceBackendUnsupportedError('xcDOT Assets.Asset is absent at the pinned block.');
  }
  if ((metadataValue as { isNone?: boolean } | null)?.isNone) {
    throw new EvidenceBackendUnsupportedError(
      'xcDOT Assets.Metadata is absent at the pinned block.',
    );
  }

  const assetKey = queryKey(assets.asset, [XC_DOT_ASSET_ID], 'Assets.Asset');
  const metadataKey = queryKey(assets.metadata, [XC_DOT_ASSET_ID], 'Assets.Metadata');
  const asset: EvidenceStorageAssetRecord = {
    kind: 'asset',
    key: assetKey,
    value: await rawStorage(api, assetKey, blockHash),
  };
  const metadata: EvidenceStorageMetadataRecord = {
    kind: 'metadata',
    key: metadataKey,
    value: await rawStorage(api, metadataKey, blockHash),
  };

  const accounts: EvidenceStorageAccountRecord[] = [];
  const seenKeys = new Set<string>();
  let startKey: string | undefined;
  let previousLastKey: string | undefined;
  for (;;) {
    const options: Record<string, unknown> = { args: [XC_DOT_ASSET_ID], pageSize };
    if (startKey !== undefined) options.startKey = startKey;
    const page = await retryRpc(() => accountQuery.entriesPaged!(options));
    if (!Array.isArray(page))
      throw new EnumerationUnsupportedError('Account page is not an array.');
    if (page.length === 0) break;
    if (page.length > pageSize) {
      throw new EnumerationUnsupportedError('RPC returned more account entries than requested.');
    }
    let pageLastKey: string | undefined;
    for (const entry of page) {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry[0]) {
        throw new StorageDecodeError('Malformed Assets.Account page entry.');
      }
      const storageKey = keyHex(entry[0]);
      if (seenKeys.has(storageKey)) {
        throw new EnumerationUnsupportedError('RPC repeated an Assets.Account storage key.', {
          key: storageKey,
        });
      }
      if (previousLastKey !== undefined && storageKey <= previousLastKey) {
        throw new EnumerationUnsupportedError(
          'Assets.Account pagination is not strictly increasing.',
        );
      }
      if (pageLastKey !== undefined && storageKey <= pageLastKey) {
        throw new EnumerationUnsupportedError('Assets.Account page is unsorted or repeated.');
      }
      const decoded = decodeStorageEntry(entry[0], entry[1], XC_DOT_ASSET_ID);
      accounts.push({
        kind: 'account',
        address: decoded.address,
        key: storageKey,
        value: await rawStorage(api, storageKey, blockHash),
        balancePlanck: decoded.balancePlanck,
      });
      seenKeys.add(storageKey);
      pageLastKey = storageKey;
    }
    if (!pageLastKey || pageLastKey === startKey) {
      throw new EnumerationUnsupportedError('Assets.Account pagination did not advance.');
    }
    previousLastKey = pageLastKey;
    startKey = pageLastKey;
  }

  accounts.sort((a, b) => a.key.localeCompare(b.key));
  return {
    asset,
    metadata,
    accounts,
    holders: canonicalizeHolders(accounts),
    decodedAsset: asRecord(codecJson(assetValue), 'AssetDetails'),
    decodedMetadata: asRecord(codecJson(metadataValue), 'AssetMetadata'),
  };
}

export async function readRawStorage(
  api: ApiPromise,
  key: string,
  blockHash: string,
): Promise<string> {
  return rawStorage(api, lowerHex(key, 'storage key'), blockHash);
}

export function serializeStorageRecord(record: EvidenceStorageRecord): string {
  if (record.kind === 'asset')
    return JSON.stringify({ kind: record.kind, key: record.key, value: record.value });
  if (record.kind === 'metadata') {
    return JSON.stringify({ kind: record.kind, key: record.key, value: record.value });
  }
  return JSON.stringify({
    kind: record.kind,
    address: record.address,
    key: record.key,
    value: record.value,
    balancePlanck: record.balancePlanck,
  });
}

export function serializeStorage(records: readonly EvidenceStorageRecord[]): string {
  return records.map(serializeStorageRecord).join('\n') + '\n';
}
