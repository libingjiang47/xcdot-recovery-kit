import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  FinalStateBalanceCacheConflictError,
  FinalStateIdentityMismatchError,
  FinalStateStorageBackendUnsupportedError,
} from '../utils/errors.js';

export interface CachedStorageBatch {
  schemaVersion: 1;
  blockHash: string;
  batchIndex: number;
  keys: string[];
  values: Array<string | null>;
}

export interface FinalBalanceCache {
  directory: string;
  values: Map<string, string | null>;
  batchCount: number;
  recordCount: number;
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0;
}

function normalizeStorageValue(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (!isHex(value) || value.length !== 66) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state cache contains a malformed 32-byte storage value.',
      { path, value: String(value).slice(0, 160) },
    );
  }
  return value.toLowerCase();
}

function normalizeKey(value: unknown, path: string): string {
  if (!isHex(value) || value.length <= 2) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state cache contains a malformed storage key.',
      { path, value: String(value).slice(0, 160) },
    );
  }
  return value.toLowerCase();
}

function parseBatch(value: unknown, path: string): CachedStorageBatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state cache batch is not an object.',
      {
        path,
      },
    );
  }
  const record = value as {
    schemaVersion?: unknown;
    blockHash?: unknown;
    batchIndex?: unknown;
    keys?: unknown;
    values?: unknown;
  };
  if (
    record.schemaVersion !== 1 ||
    typeof record.blockHash !== 'string' ||
    typeof record.batchIndex !== 'number' ||
    !Number.isInteger(record.batchIndex) ||
    record.batchIndex < 0 ||
    !Array.isArray(record.keys) ||
    !Array.isArray(record.values) ||
    record.keys.length !== record.values.length
  ) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state cache batch has an invalid schema.',
      { path },
    );
  }
  const keys = record.keys.map((key, index) => normalizeKey(key, `${path}:keys[${index}]`));
  const values = record.values.map((item, index) =>
    normalizeStorageValue(item, `${path}:values[${index}]`),
  );
  return {
    schemaVersion: 1,
    blockHash: record.blockHash.toLowerCase(),
    batchIndex: record.batchIndex,
    keys,
    values,
  };
}

export async function loadFinalBalanceCache(
  directory: string,
  expectedBlockHash: string,
): Promise<FinalBalanceCache> {
  const resolvedDirectory = resolve(directory);
  let names: string[];
  try {
    names = (await readdir(resolvedDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^batch-[0-9]+\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state storage cache directory cannot be read.',
      {
        directory: resolvedDirectory,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (names.length === 0) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state storage cache contains no batch files.',
      { directory: resolvedDirectory },
    );
  }

  const values = new Map<string, string | null>();
  let recordCount = 0;
  for (const name of names) {
    const path = join(resolvedDirectory, name);
    const batch = parseBatch(JSON.parse(await readFile(path, 'utf8')) as unknown, path);
    if (batch.blockHash !== expectedBlockHash.toLowerCase()) {
      throw new FinalStateIdentityMismatchError('Final-state cache belongs to a different block.', {
        path,
        expectedBlockHash,
        actualBlockHash: batch.blockHash,
      });
    }
    for (let index = 0; index < batch.keys.length; index += 1) {
      const key = batch.keys[index];
      const value = batch.values[index];
      if (key === undefined || value === undefined) {
        throw new FinalStateStorageBackendUnsupportedError(
          'Final-state cache batch contains an incomplete key/value pair.',
          { path, index },
        );
      }
      const previous = values.get(key);
      if (values.has(key) && previous !== value) {
        throw new FinalStateBalanceCacheConflictError(
          'Final-state cache contains conflicting values for one storage key.',
          { path, key },
        );
      }
      values.set(key, value);
      recordCount += 1;
    }
  }
  return { directory: resolvedDirectory, values, batchCount: names.length, recordCount };
}
