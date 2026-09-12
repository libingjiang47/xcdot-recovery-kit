import type { ApiPromise } from '@polkadot/api';
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
