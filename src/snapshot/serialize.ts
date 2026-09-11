import type { HolderRecord } from '../types.js';
import { formatDot } from '../utils/numbers.js';

export function serializeHoldersNdjson(holders: readonly HolderRecord[]): string {
  if (holders.length === 0) return '';
  return holders.map((holder) => JSON.stringify(holder)).join('\n') + '\n';
}

export function serializeHoldersJson(holders: readonly HolderRecord[]): string {
  return JSON.stringify(holders, null, 2) + '\n';
}

export function serializeHoldersCsv(holders: readonly HolderRecord[], decimals = 10): string {
  const rows = ['address,balance_planck,balance_dot'];
  for (const holder of holders) {
    rows.push(
      `${holder.address},${holder.balancePlanck},${formatDot(BigInt(holder.balancePlanck), decimals)}`,
    );
  }
  return rows.join('\n') + '\n';
}
