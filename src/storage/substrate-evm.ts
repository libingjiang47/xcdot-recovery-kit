import type { ApiPromise } from '@polkadot/api';
import { hexToU8a, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto';
import { retryRpc } from '../verification/providers.js';
import {
  FinalStateStorageBackendUnsupportedError,
  FinalStateStorageLayoutError,
} from '../utils/errors.js';
import { decodeU256Storage, deriveMappingStorageSlot, storageSlotHex } from './solidity.js';

export interface AccountStoragesQuery {
  key: (...args: unknown[]) => unknown;
  meta?: unknown;
}

function lowerHex(value: unknown, label: string): string {
  const text =
    typeof value === 'string' ? value : (value as { toHex?: () => string } | null)?.toHex?.();
  if (!text || !/^0x[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
    throw new FinalStateStorageLayoutError(`RPC returned malformed ${label}.`, {
      value: String(value),
    });
  }
  return text.toLowerCase();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalH160(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new FinalStateStorageLayoutError(`${label} is not a canonical H160.`, { value });
  }
  return value.toLowerCase();
}

function canonicalH256(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new FinalStateStorageLayoutError(`${label} is not a canonical H256.`, { value });
  }
  return value.toLowerCase();
}

export function accountStoragesQuery(apiAt: { query: unknown }): AccountStoragesQuery {
  const query = record(apiAt.query);
  const evm = query === undefined ? undefined : record(query.evm);
  const accountStorages = evm?.accountStorages;
  if (
    (typeof accountStorages !== 'function' && typeof accountStorages !== 'object') ||
    accountStorages === null ||
    typeof (accountStorages as { key?: unknown }).key !== 'function'
  ) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Pinned runtime metadata does not expose pallet_evm::AccountStorages with a key encoder.',
      { pallet: 'Evm', storage: 'AccountStorages' },
    );
  }
  return accountStorages as AccountStoragesQuery;
}

export function deriveAccountStoragesKey(
  apiAt: { query: unknown },
  contract: string,
  evmStorageSlot: string,
): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    throw new FinalStateStorageLayoutError(
      'AccountStorages contract key is not a canonical H160.',
      {
        contract,
      },
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(evmStorageSlot)) {
    throw new FinalStateStorageLayoutError('EVM storage slot is not a canonical H256.', {
      evmStorageSlot,
    });
  }
  const query = accountStoragesQuery(apiAt);
  return lowerHex(
    query.key(contract.toLowerCase(), evmStorageSlot.toLowerCase()),
    'AccountStorages key',
  );
}

/**
 * Derive the raw Substrate key for Moonbeam pallet_evm::AccountStorages without
 * runtime metadata. Runtime 4401 uses the construct_runtime pallet prefix `EVM`
 * and Frontier defines AccountStorages as
 * StorageDoubleMap<Blake2_128Concat, H160, Blake2_128Concat, H256, H256>.
 */
export function deriveAccountStoragesKeyDirect(contract: string, evmStorageSlot: string): string {
  const contractHex = canonicalH160(contract, 'AccountStorages contract key');
  const slotHex = canonicalH256(evmStorageSlot, 'EVM storage slot');
  const contractBytes = hexToU8a(contractHex);
  const slotBytes = hexToU8a(slotHex);
  return u8aToHex(
    u8aConcat(
      xxhashAsU8a(stringToU8a('EVM'), 128),
      xxhashAsU8a(stringToU8a('AccountStorages'), 128),
      blake2AsU8a(contractBytes, 128),
      contractBytes,
      blake2AsU8a(slotBytes, 128),
      slotBytes,
    ),
  ).toLowerCase();
}

export function deriveBalanceAccountStoragesKeyDirect(
  contract: string,
  address: string,
  balancesSlot: bigint,
): { evmStorageSlot: string; substrateStorageKey: string } {
  const evmStorageSlot = deriveMappingStorageSlot(address, balancesSlot);
  return {
    evmStorageSlot,
    substrateStorageKey: deriveAccountStoragesKeyDirect(contract, evmStorageSlot),
  };
}

export function deriveTotalSupplyAccountStoragesKeyDirect(
  contract: string,
  totalSupplySlot: bigint,
): { evmStorageSlot: string; substrateStorageKey: string } {
  const evmStorageSlot = storageSlotHex(totalSupplySlot);
  return {
    evmStorageSlot,
    substrateStorageKey: deriveAccountStoragesKeyDirect(contract, evmStorageSlot),
  };
}

export function deriveBalanceAccountStoragesKey(
  apiAt: { query: unknown },
  contract: string,
  address: string,
  balancesSlot: bigint,
): { evmStorageSlot: string; substrateStorageKey: string } {
  const evmStorageSlot = deriveMappingStorageSlot(address, balancesSlot);
  return {
    evmStorageSlot,
    substrateStorageKey: deriveAccountStoragesKey(apiAt, contract, evmStorageSlot),
  };
}

export function deriveTotalSupplyAccountStoragesKey(
  apiAt: { query: unknown },
  contract: string,
  totalSupplySlot: bigint,
): { evmStorageSlot: string; substrateStorageKey: string } {
  const evmStorageSlot = storageSlotHex(totalSupplySlot);
  return {
    evmStorageSlot,
    substrateStorageKey: deriveAccountStoragesKey(apiAt, contract, evmStorageSlot),
  };
}

export async function readOptionalSubstrateStorage(
  api: ApiPromise,
  key: string,
  blockHash: string,
): Promise<string | null> {
  const value = await retryRpc(() => api.rpc.state.getStorage(key, blockHash));
  if (!value || (value as { isNone?: boolean }).isNone === true) return null;
  return lowerHex(value, 'AccountStorages value');
}

export async function readU256AccountStorage(
  api: ApiPromise,
  key: string,
  blockHash: string,
): Promise<{ rawValue: string | null; value: bigint }> {
  const rawValue = await readOptionalSubstrateStorage(api, key, blockHash);
  return { rawValue, value: decodeU256Storage(rawValue) };
}

export function accountStoragesMetadataSummary(apiAt: { query: unknown }): {
  pallet: 'Evm';
  storage: 'AccountStorages';
  keyDerivation: 'runtime-metadata';
  metadata: unknown;
} {
  const query = accountStoragesQuery(apiAt);
  return {
    pallet: 'Evm',
    storage: 'AccountStorages',
    keyDerivation: 'runtime-metadata',
    metadata: query.meta ?? null,
  };
}
