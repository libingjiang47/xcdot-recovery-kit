import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { assertExpectedXcDotIdentity } from '../asset/constants.js';
import { BlockHashMismatchError } from '../utils/errors.js';
import type {
  AccountClassification,
  HolderRecord,
  SnapshotManifest,
  VerificationResult,
} from '../types.js';
import { holderSupplyMatches } from './supply.js';
import { retryRpc, withConcurrency } from './providers.js';
import { compareCanonicalStrings } from '../utils/order.js';

export { createEvmClient } from './providers.js';

const XC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;

export interface EvmVerificationOutput {
  verification: VerificationResult;
  classifications: AccountClassification[];
}

export async function verifyEvmSnapshot(
  client: PublicClient,
  manifest: SnapshotManifest,
  holders: readonly HolderRecord[],
  concurrency = 8,
): Promise<EvmVerificationOutput> {
  const blockNumber = BigInt(manifest.snapshot.blockNumber);
  const block = await retryRpc(() => client.getBlock({ blockNumber }));
  const returnedHash = block.hash?.toLowerCase();
  if (!returnedHash || returnedHash !== manifest.snapshot.blockHash.toLowerCase()) {
    throw new BlockHashMismatchError(
      'EVM RPC block hash does not match the pinned Substrate block hash.',
      {
        expected: manifest.snapshot.blockHash,
        actual: returnedHash ?? 'null',
      },
    );
  }

  const address = manifest.asset.xc20Address as Address;
  const [symbol, decimals, evmSupply] = await Promise.all([
    retryRpc(() =>
      client.readContract({ address, abi: XC20_ABI, functionName: 'symbol', blockNumber }),
    ),
    retryRpc(() =>
      client.readContract({ address, abi: XC20_ABI, functionName: 'decimals', blockNumber }),
    ),
    retryRpc(() =>
      client.readContract({ address, abi: XC20_ABI, functionName: 'totalSupply', blockNumber }),
    ),
  ]);
  assertExpectedXcDotIdentity(symbol, decimals, BigInt(manifest.asset.assetId), address);

  const holderBalanceMismatches: VerificationResult['holderBalanceMismatches'] = [];
  const errors: string[] = [];
  await withConcurrency(holders, concurrency, async (holder) => {
    try {
      const actual = await retryRpc(() =>
        client.readContract({
          address,
          abi: XC20_ABI,
          functionName: 'balanceOf',
          args: [holder.address as Address],
          blockNumber,
        }),
      );
      const expected = BigInt(holder.balancePlanck);
      if (actual !== expected) {
        holderBalanceMismatches.push({
          address: holder.address,
          expected: expected.toString(10),
          actual: actual.toString(10),
        });
      }
    } catch (error) {
      errors.push(`${holder.address}: ${String(error)}`);
    }
  });

  const substrateSupplyMatchesHolderSum = holderSupplyMatches(
    holders,
    manifest.asset.totalSupplyPlanck,
  );
  const evmSupplyMatchesSubstrateSupply = evmSupply === BigInt(manifest.asset.totalSupplyPlanck);
  const verification: VerificationResult = {
    substrateSupplyMatchesHolderSum,
    evmSupplyMatchesSubstrateSupply,
    holderBalancesChecked: holders.length - errors.length,
    holderBalanceMismatches: holderBalanceMismatches.sort((a, b) =>
      compareCanonicalStrings(a.address, b.address),
    ),
    ...(errors.length === 0 ? {} : { errors: errors.sort() }),
    status:
      substrateSupplyMatchesHolderSum &&
      evmSupplyMatchesSubstrateSupply &&
      holderBalanceMismatches.length === 0 &&
      errors.length === 0
        ? 'PASS'
        : 'FAIL',
  };

  const classifications: AccountClassification[] = [];
  await withConcurrency(holders, concurrency, async (holder) => {
    try {
      const code = await client.getCode({ address: holder.address as Address, blockNumber });
      if (code === '0x') {
        classifications.push({ address: holder.address, codeStatus: 'no_code' });
      } else if (code) {
        classifications.push({
          address: holder.address,
          codeStatus: 'has_code',
          codeSize: (code.length - 2) / 2,
          codeHash: keccak256(code as Hex),
        });
      } else {
        classifications.push({ address: holder.address, codeStatus: 'unknown' });
      }
    } catch {
      classifications.push({ address: holder.address, codeStatus: 'unknown' });
    }
  });

  return {
    verification,
    classifications: classifications.sort((a, b) => compareCanonicalStrings(a.address, b.address)),
  };
}
