import type { HolderRecord } from '../types.js';
import { AccountCountMismatchError, SupplyMismatchError } from '../utils/errors.js';
import { sumBalances } from './canonicalize.js';

export function assertSupplyInvariant(
  holders: readonly HolderRecord[],
  totalSupplyPlanck: string,
): void {
  const holderSum = sumBalances(holders);
  const supply = BigInt(totalSupplyPlanck);
  if (holderSum !== supply) {
    throw new SupplyMismatchError('Holder balance sum does not equal asset total supply.', {
      holderSum: holderSum.toString(),
      totalSupply: supply.toString(),
    });
  }
}

export function assertAccountCountInvariant(
  decodedAccountCount: number,
  expectedAccountCount: string,
): void {
  const expected = BigInt(expectedAccountCount);
  if (BigInt(decodedAccountCount) !== expected) {
    throw new AccountCountMismatchError(
      'Decoded Assets.Account count does not equal asset account count.',
      {
        decoded: decodedAccountCount,
        expected: expectedAccountCount,
      },
    );
  }
}
