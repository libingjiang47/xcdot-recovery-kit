import { keccak256, type Address, type Hex } from 'viem';
import type { AccountClassification, CodeStatus, HolderRecord } from '../types.js';
import { withConcurrency } from './providers.js';
import { compareCanonicalStrings } from '../utils/order.js';

interface CodeClient {
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
}

export async function classifyHolderAccounts(
  client: CodeClient,
  holders: readonly HolderRecord[],
  blockNumber: bigint,
  concurrency: number,
): Promise<AccountClassification[]> {
  const result: AccountClassification[] = [];
  await withConcurrency(holders, concurrency, async (holder) => {
    try {
      const code = await client.getCode({ address: holder.address as Address, blockNumber });
      if (code === '0x') {
        result.push({ address: holder.address, codeStatus: 'no_code' satisfies CodeStatus });
        return;
      }
      if (!code) {
        result.push({ address: holder.address, codeStatus: 'unknown' satisfies CodeStatus });
        return;
      }
      result.push({
        address: holder.address,
        codeStatus: 'has_code',
        codeSize: (code.length - 2) / 2,
        codeHash: keccak256(code),
      });
    } catch {
      result.push({ address: holder.address, codeStatus: 'unknown' satisfies CodeStatus });
    }
  });
  return result.sort((a, b) => compareCanonicalStrings(a.address, b.address));
}
