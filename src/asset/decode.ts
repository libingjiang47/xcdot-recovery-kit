import { normalizeH160 } from './xc20.js';
import { StorageDecodeError } from '../utils/errors.js';
import type { HolderRecord } from '../types.js';

interface CodecLike {
  toBigInt?: () => bigint;
  toString?: () => string;
  toHex?: () => string;
}

export interface StorageKeyLike {
  args?: unknown[];
  toHex: () => string;
}

function codecToBigInt(value: unknown, label: string): bigint {
  const codec = value as CodecLike | null;
  try {
    if (codec && typeof codec.toBigInt === 'function') {
      const decoded = codec.toBigInt();
      if (typeof decoded === 'bigint') return decoded;
    }
    if (typeof value === 'bigint') return value;
    if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  } catch (error) {
    throw new StorageDecodeError(`Could not decode ${label}.`, { cause: String(error) });
  }
  throw new StorageDecodeError(`Decoded ${label} is not an integer.`);
}

function codecToHex(value: unknown, label: string): string {
  const codec = value as CodecLike | null;
  if (codec && typeof codec.toHex === 'function') return codec.toHex();
  if (typeof value === 'string') return value;
  throw new StorageDecodeError(`Could not decode ${label} as hex.`);
}

export function decodeBalanceValue(value: unknown): bigint {
  if (typeof value !== 'object' || value === null || !('balance' in value)) {
    throw new StorageDecodeError('Assets.Account value is missing the balance field.');
  }
  return codecToBigInt((value as { balance: unknown }).balance, 'balance');
}

export function decodeStorageEntry(
  key: StorageKeyLike,
  value: unknown,
  expectedAssetId: bigint,
): HolderRecord {
  const args = key.args as unknown[] | undefined;
  if (!args || args.length !== 2) {
    throw new StorageDecodeError('Unexpected Assets.Account storage key structure.', {
      key: key.toHex(),
    });
  }
  const actualAssetId = codecToBigInt(args[0], 'asset ID');
  if (actualAssetId !== expectedAssetId) {
    throw new StorageDecodeError('Storage key contains an unexpected asset ID.', {
      expected: expectedAssetId.toString(),
      actual: actualAssetId.toString(),
    });
  }
  const address = normalizeH160(codecToHex(args[1], 'account'));
  const balance = decodeBalanceValue(value);
  if (balance < 0n) throw new StorageDecodeError('Decoded balance is negative.');
  return { address, balancePlanck: balance.toString(10) };
}
