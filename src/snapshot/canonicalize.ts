import type { HolderRecord } from '../types.js';
import { DuplicateHolderError, CanonicalSerializationError } from '../utils/errors.js';
import { normalizeH160 } from '../asset/xc20.js';
import { compareCanonicalStrings } from '../utils/order.js';

export function canonicalizeHolders(records: readonly HolderRecord[]): HolderRecord[] {
  const seen = new Map<string, string>();
  const normalized: HolderRecord[] = [];
  for (const record of records) {
    let address: string;
    try {
      address = normalizeH160(record.address);
    } catch (error) {
      throw new CanonicalSerializationError(`Invalid holder address: ${String(error)}`);
    }
    if (!/^(0|[1-9][0-9]*)$/.test(record.balancePlanck)) {
      throw new CanonicalSerializationError('Holder balance must be an unsigned decimal integer.', {
        address,
        balance: record.balancePlanck,
      });
    }
    if (seen.has(address)) {
      throw new DuplicateHolderError('The same holder occurs more than once.', { address });
    }
    seen.set(address, record.balancePlanck);
    const balance = BigInt(record.balancePlanck);
    if (balance > 0n) normalized.push({ address, balancePlanck: balance.toString(10) });
  }
  return normalized.sort((a, b) => compareCanonicalStrings(a.address, b.address));
}

export function sumBalances(records: readonly HolderRecord[]): bigint {
  return records.reduce((sum, record) => sum + BigInt(record.balancePlanck), 0n);
}
