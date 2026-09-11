import type { HolderRecord } from '../types.js';
import { sumBalances } from '../snapshot/canonicalize.js';

export function holderSupplyMatches(
  holders: readonly HolderRecord[],
  supplyPlanck: string,
): boolean {
  return sumBalances(holders) === BigInt(supplyPlanck);
}
